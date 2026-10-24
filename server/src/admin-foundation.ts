import { createHash, randomUUID } from "node:crypto";
import type { Express, Request, RequestHandler } from "express";
import { DepositStatus, Prisma, PrismaClient, UserRole } from "@prisma/client";
import {
  CricketLiveApiContractError,
  CricketLiveApiMatch,
  fetchCricketLiveApiMatches,
  importCricketLiveApiMatches,
  getMatchStatus,
} from "./cricketliveapi";
import {
  fetchCricketLiveApiPlayerPool,
  fetchCricketLiveApiPlayingXI,
  importCricketLiveApiPlayerPool,
  importCricketLiveApiPlayingXI,
  validatePlayerPoolReadiness,
} from "./cricketliveapi-players";

type MiddlewareSet = {
  requireAuth: RequestHandler;
  requireAdmin: RequestHandler;
  requireSuperAdmin: RequestHandler;
  effectiveRole: (user: { email: string; role: string }) => string;
};

const enabledAgentPermissions = [
  "review_deposits",
  "reject_deposits",
  "escalate_deposits",
] as const;

export function calculateFinancialMetrics(input: {
  approvedDepositsMinor: bigint;
  pendingDepositsMinor: bigint;
  grossContestEntryFeesMinor: bigint;
  refundsMinor: bigint;
  platformCommissionMinor: bigint;
  expensesMinor: bigint;
  walletBalanceMinor: bigint;
  walletReservedMinor: bigint;
}) {
  return {
    approvedDepositsMinor: input.approvedDepositsMinor,
    pendingDepositsMinor: input.pendingDepositsMinor,
    grossContestEntryFeesMinor: input.grossContestEntryFeesMinor,
    refundsMinor: input.refundsMinor,
    platformCommissionMinor: input.platformCommissionMinor,
    expensesMinor: input.expensesMinor,
    netProfitMinor: input.platformCommissionMinor - input.expensesMinor,
    walletLiabilityMinor: input.walletBalanceMinor + input.walletReservedMinor,
  };
}

function pagination(req: Request) {
  const page = Number(req.query.page ?? 1);
  const pageSize = Number(req.query.pageSize ?? 25);
  if (
    !Number.isSafeInteger(page) || page < 1 ||
    !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100
  ) {
    return null;
  }
  return { page, pageSize, skip: (page - 1) * pageSize };
}

function toCsvCell(value: string | number | bigint | null | undefined) {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replaceAll("\"", "\"\"")}"`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function getUtcBoundaries(now = new Date()) {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const week = new Date(today);
  const weekday = (week.getUTCDay() + 6) % 7;
  week.setUTCDate(week.getUTCDate() - weekday);
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { today, week, month };
}

async function appendAuditEvent(
  tx: Prisma.TransactionClient,
  actorUserId: string | null,
  action: string,
  entityType: string,
  entityId: string | null,
  details: Prisma.InputJsonObject,
) {
  await tx.auditChainState.upsert({
    where: { id: 1 },
    create: { id: 1 },
    update: {},
  });
  await tx.$queryRaw`SELECT "id" FROM "AuditChainState" WHERE "id" = 1 FOR UPDATE`;
  const state = await tx.auditChainState.findUniqueOrThrow({ where: { id: 1 } });
  const createdAt = new Date();
  const previousHash = state.lastHash;
  const sequence = state.lastSequence + 1;
  const id = randomUUID();
  const payload = stableJson({
    id,
    sequence,
    actorUserId,
    action,
    entityType,
    entityId,
    details,
    createdAt: createdAt.toISOString(),
  });
  const eventHash = createHash("sha256")
    .update(previousHash)
    .update("\n")
    .update(payload)
    .digest("hex");
  await tx.auditEvent.create({
    data: {
      id,
      actorUserId,
      sequence,
      action,
      entityType,
      entityId,
      details,
      previousHash,
      eventHash,
      createdAt,
    },
  });
  await tx.auditChainState.update({
    where: { id: 1 },
    data: { lastSequence: sequence, lastHash: eventHash },
  });
}

function parseMinorAmount(value: unknown) {
  if (typeof value !== "string" || !/^[1-9]\d{0,17}$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function routeError(res: { status: (status: number) => { json: (body: object) => void } }, error: unknown, context: string) {
  console.error(`${context}:`, error);
  res.status(500).json({ error: "The operation could not be completed." });
}

export function registerAdminFoundationRoutes(
  app: Express,
  prisma: PrismaClient,
  middleware: MiddlewareSet,
) {
  const { requireAuth, requireAdmin, requireSuperAdmin, effectiveRole } = middleware;

  const requireActiveAgent: RequestHandler = async (req, res, next) => {
    try {
      const userId = req.authenticatedUser?.id;
      if (!userId) {
        res.status(401).json({ error: "Please sign in to continue." });
        return;
      }
      const [user, profile] = await Promise.all([
        prisma.user.findUnique({
          where: { id: userId },
          select: { role: true, accountStatus: true },
        }),
        prisma.cashAgentProfile.findUnique({ where: { userId } }),
      ]);
      if (
        user?.role !== UserRole.CASH_AGENT ||
        user.accountStatus !== "ACTIVE" ||
        !profile?.active
      ) {
        res.status(403).json({ error: "Active cash-agent access is required." });
        return;
      }
      next();
    } catch (error) {
      next(error);
    }
  };

  app.get("/api/wallet", requireAuth, async (req, res) => {
    try {
      const wallets = await prisma.wallet.findMany({
        where: { userId: req.authenticatedUser!.id },
        select: { currency: true, balanceMinor: true, reservedMinor: true },
        orderBy: { currency: "asc" },
      });
      res.json({
        wallets: wallets.map((wallet) => ({
          currency: wallet.currency,
          availableMinor: wallet.balanceMinor.toString(),
          reservedMinor: wallet.reservedMinor.toString(),
        })),
        paymentStatus: "UNAVAILABLE",
        message: "Wallet funding and spending are disabled until payment verification is integrated.",
      });
    } catch (error) {
      routeError(res, error, "Get wallet error");
    }
  });

  app.get("/api/deposits", requireAuth, async (req, res) => {
    const page = pagination(req);
    if (!page) {
      res.status(400).json({ error: "Choose a valid page and page size (maximum 100)." });
      return;
    }
    try {
      const where = { userId: req.authenticatedUser!.id };
      const [total, deposits] = await Promise.all([
        prisma.depositRequest.count({ where }),
        prisma.depositRequest.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: page.skip,
          take: page.pageSize,
          select: {
            id: true,
            amountMinor: true,
            currency: true,
            paymentMethod: true,
            paymentReference: true,
            status: true,
            decisionReason: true,
            createdAt: true,
            updatedAt: true,
          },
        }),
      ]);
      res.json({
        page: page.page,
        pageSize: page.pageSize,
        total,
        deposits: deposits.map((deposit) => ({
          ...deposit,
          amountMinor: deposit.amountMinor.toString(),
        })),
      });
    } catch (error) {
      routeError(res, error, "List deposits error");
    }
  });

  app.post("/api/deposits", requireAuth, async (req, res) => {
    const amountMinor = parseMinorAmount(req.body?.amountMinor);
    const paymentMethod = typeof req.body?.paymentMethod === "string"
      ? req.body.paymentMethod.trim().toUpperCase()
      : "";
    const paymentReference = typeof req.body?.paymentReference === "string"
      ? req.body.paymentReference.trim()
      : "";
    const idempotencyKey = typeof req.body?.idempotencyKey === "string"
      ? req.body.idempotencyKey.trim()
      : "";

    if (
      !amountMinor ||
      !["UPI", "BANK_TRANSFER"].includes(paymentMethod) ||
      paymentReference.length < 4 ||
      paymentReference.length > 120 ||
      !/^[A-Za-z0-9._:/-]+$/.test(paymentReference) ||
      !/^[A-Za-z0-9:_-]{8,120}$/.test(idempotencyKey)
    ) {
      res.status(400).json({
        error: "Provide a positive amount in minor units, a supported payment method, a valid payment reference, and an idempotency key.",
        code: "INVALID_DEPOSIT_REQUEST",
      });
      return;
    }

    try {
      const existing = await prisma.depositRequest.findUnique({
        where: { idempotencyKey },
        select: { id: true, userId: true, amountMinor: true, currency: true, status: true },
      });

      if (existing) {
        if (
          existing.userId !== req.authenticatedUser!.id ||
          existing.amountMinor !== amountMinor ||
          existing.currency !== "INR"
        ) {
          res.status(409).json({
            error: "This idempotency key has already been used for a different request.",
            code: "IDEMPOTENCY_CONFLICT",
          });
          return;
        }
        res.status(200).json({
          deposit: { ...existing, amountMinor: existing.amountMinor.toString() },
          message: "This deposit request already exists. It has not been credited automatically.",
        });
        return;
      }

      const duplicate = await prisma.depositRequest.findFirst({
        where: {
          paymentReference: { equals: paymentReference, mode: "insensitive" },
          status: { in: ["PENDING", "UNDER_REVIEW", "APPROVED", "ESCALATED"] },
        },
        select: { id: true },
      });

      if (duplicate) {
        res.status(409).json({
          error: "This payment reference is already associated with a deposit request.",
          code: "DUPLICATE_PAYMENT_REFERENCE",
        });
        return;
      }

      const deposit = await prisma.depositRequest.create({
        data: {
          userId: req.authenticatedUser!.id,
          amountMinor,
          currency: "INR",
          paymentMethod,
          paymentReference,
          idempotencyKey,
          paidAt: new Date(),
        },
        select: {
          id: true,
          amountMinor: true,
          currency: true,
          paymentMethod: true,
          paymentReference: true,
          status: true,
          createdAt: true,
        },
      });

      res.status(201).json({
        deposit: { ...deposit, amountMinor: deposit.amountMinor.toString() },
        message: "Deposit request submitted for review. Your wallet will not be credited until the payment is independently verified.",
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        res.status(409).json({
          error: "This request or payment reference may already exist. Refresh your deposit history before retrying.",
          code: "DUPLICATE_DEPOSIT_REQUEST",
        });
        return;
      }
      routeError(res, error, "Create deposit request error");
    }
  });

  app.get("/api/withdrawals", requireAuth, async (req, res) => {
    const page = pagination(req);
    if (!page) {
      res.status(400).json({ error: "Choose a valid page and page size (maximum 100)." });
      return;
    }
    try {
      const where = { userId: req.authenticatedUser!.id };
      const [total, withdrawals] = await Promise.all([
        prisma.withdrawalRequest.count({ where }),
        prisma.withdrawalRequest.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: page.skip,
          take: page.pageSize,
          select: {
            id: true,
            amountMinor: true,
            currency: true,
            status: true,
            decisionReason: true,
            payoutReference: true,
            paidAt: true,
            createdAt: true,
            updatedAt: true,
          },
        }),
      ]);
      res.json({
        page: page.page,
        pageSize: page.pageSize,
        total,
        withdrawals: withdrawals.map((withdrawal) => ({
          ...withdrawal,
          amountMinor: withdrawal.amountMinor.toString(),
        })),
      });
    } catch (error) {
      routeError(res, error, "List withdrawals error");
    }
  });

  app.post("/api/withdrawals", requireAuth, (_req, res) => {
    res.status(503).json({
      error: "Withdrawals are unavailable until a payout provider and verified wallet funding are configured.",
      code: "PAYOUT_PROVIDER_UNAVAILABLE",
    });
  });

  app.get("/api/admin/dashboard", requireAuth, requireAdmin, async (_req, res) => {
    try {
      const now = new Date();
      const { today, week, month } = getUtcBoundaries(now);
      const chartStart = new Date(today);
      chartStart.setUTCDate(chartStart.getUTCDate() - 29);
      const [
        registeredUsers,
        registrationsToday,
        registrationsThisWeek,
        registrationsThisMonth,
        activeUsers,
        suspendedUsers,
        depositGroups,
        withdrawalGroups,
        inrWallets,
        cryptoWallets,
        contestEntries,
        activeContests,
        matchGroups,
        contestFinanceGroups,
        payoutTotals,
        expenseTotals,
        recentUsers,
        pendingDeposits,
        pendingWithdrawals,
        recentEntries,
        recentLedger,
        chartUsers,
        chartDeposits,
        chartContestEntries,
        contestChartEntries,
        expenseCategories,
      ] = await Promise.all([
        prisma.user.count(),
        prisma.user.count({ where: { createdAt: { gte: today } } }),
        prisma.user.count({ where: { createdAt: { gte: week } } }),
        prisma.user.count({ where: { createdAt: { gte: month } } }),
        prisma.user.count({ where: { accountStatus: "ACTIVE" } }),
        prisma.user.count({ where: { accountStatus: "SUSPENDED" } }),
        prisma.depositRequest.groupBy({
          by: ["status", "currency"],
          _count: { _all: true },
          _sum: { amountMinor: true },
        }),
        prisma.withdrawalRequest.groupBy({
          by: ["status", "currency"],
          _count: { _all: true },
          _sum: { amountMinor: true },
        }),
        prisma.wallet.aggregate({
          where: { currency: "INR" },
          _sum: { balanceMinor: true, reservedMinor: true },
        }),
        prisma.wallet.aggregate({
          where: { currency: "USDT" },
          _sum: { balanceMinor: true, reservedMinor: true },
        }),
        prisma.contestEntry.count(),
        prisma.contest.count({ where: { status: { in: ["OPEN", "FULL", "LIVE"] } } }),
        prisma.match.groupBy({ by: ["status", "isEnabled"], _count: { _all: true } }),
        prisma.contestFinancialEntry.groupBy({
          by: ["type", "currency"],
          _sum: { amountPaise: true },
        }),
        prisma.contestPayout.aggregate({ _sum: { amountPaise: true } }),
        prisma.platformExpense.groupBy({
          by: ["currency"],
          _sum: { amountMinor: true },
        }),
        prisma.user.findMany({
          orderBy: { createdAt: "desc" },
          take: 8,
          select: { id: true, email: true, fantasyName: true, role: true, accountStatus: true, createdAt: true },
        }),
        prisma.depositRequest.findMany({
          where: { status: { in: ["PENDING", "UNDER_REVIEW", "ESCALATED"] } },
          orderBy: { createdAt: "asc" },
          take: 8,
          include: { user: { select: { id: true, email: true, fantasyName: true } } },
        }),
        prisma.withdrawalRequest.findMany({
          where: { status: { in: ["PENDING", "UNDER_REVIEW", "APPROVED"] } },
          orderBy: { createdAt: "asc" },
          take: 8,
          include: { user: { select: { id: true, email: true, fantasyName: true } } },
        }),
        prisma.contestEntry.findMany({
          orderBy: { joinedAt: "desc" },
          take: 8,
          include: {
            contest: { select: { id: true, name: true, status: true } },
            user: { select: { id: true, fantasyName: true } },
          },
        }),
        prisma.walletLedgerEntry.findMany({
          orderBy: { createdAt: "desc" },
          take: 8,
          include: { wallet: { include: { user: { select: { id: true, email: true, fantasyName: true } } } } },
        }),
        prisma.user.findMany({
          where: { createdAt: { gte: chartStart } },
          select: { createdAt: true },
        }),
        prisma.depositRequest.findMany({
          where: { createdAt: { gte: chartStart } },
          select: { createdAt: true, amountMinor: true, status: true, currency: true },
        }),
        prisma.contestEntry.findMany({
          where: { joinedAt: { gte: chartStart } },
          select: { joinedAt: true },
        }),
        prisma.contestFinancialEntry.findMany({
          where: { createdAt: { gte: chartStart } },
          select: { createdAt: true, type: true, amountPaise: true, currency: true },
        }),
        prisma.platformExpense.findMany({
          where: { createdAt: { gte: chartStart } },
          select: { createdAt: true, amountMinor: true, currency: true },
        }),
      ]);

      const depositsFor = (statuses: string[], currency: string) =>
        depositGroups
          .filter((row) => statuses.includes(row.status) && row.currency === currency)
          .reduce((sum, row) => sum + (row._sum.amountMinor ?? 0n), 0n);
      const depositCount = (statuses: string[]) =>
        depositGroups
          .filter((row) => statuses.includes(row.status))
          .reduce((sum, row) => sum + row._count._all, 0);
      const withdrawalCount = (statuses: string[]) =>
        withdrawalGroups
          .filter((row) => statuses.includes(row.status))
          .reduce((sum, row) => sum + row._count._all, 0);
      const amountFor = (type: string, currency: string) =>
        contestFinanceGroups
          .filter((row) => row.type === type && row.currency === currency)
          .reduce((sum, row) => sum + (row._sum.amountPaise ?? 0n), 0n);
      const currencies = [...new Set([
        "INR",
        "USDT",
        ...depositGroups.map((row) => row.currency),
        ...withdrawalGroups.map((row) => row.currency),
        ...contestFinanceGroups.map((row) => row.currency),
        ...expenseTotals.map((row) => row.currency),
      ])].sort();
      const financials = currencies.map((currency) => {
        const grossEntryFees = amountFor("ENTRY_GROSS", currency);
        const refunds = amountFor("ENTRY_REFUND", currency);
        const commission = amountFor("PLATFORM_COMMISSION", currency) -
          amountFor("COMMISSION_REVERSAL", currency);
        const expenses = expenseTotals
          .filter((row) => row.currency === currency)
          .reduce((sum, row) => sum + (row._sum.amountMinor ?? 0n), 0n);
        const metrics = calculateFinancialMetrics({
          approvedDepositsMinor: depositsFor(["APPROVED"], currency),
          pendingDepositsMinor: depositsFor(["PENDING", "UNDER_REVIEW", "ESCALATED"], currency),
          grossContestEntryFeesMinor: grossEntryFees,
          refundsMinor: refunds,
          platformCommissionMinor: commission,
          expensesMinor: expenses,
          walletBalanceMinor: currency === "INR"
            ? inrWallets._sum.balanceMinor ?? 0n
            : currency === "USDT"
              ? cryptoWallets._sum.balanceMinor ?? 0n
              : 0n,
          walletReservedMinor: currency === "INR"
            ? inrWallets._sum.reservedMinor ?? 0n
            : currency === "USDT"
              ? cryptoWallets._sum.reservedMinor ?? 0n
              : 0n,
        });
        return {
          currency,
          approvedDepositsMinor: metrics.approvedDepositsMinor.toString(),
          pendingDepositsMinor: metrics.pendingDepositsMinor.toString(),
          grossContestEntryFeesMinor: metrics.grossContestEntryFeesMinor.toString(),
          refundsMinor: metrics.refundsMinor.toString(),
          platformCommissionMinor: metrics.platformCommissionMinor.toString(),
          expensesMinor: metrics.expensesMinor.toString(),
          netProfitMinor: metrics.netProfitMinor.toString(),
          walletLiabilityMinor: metrics.walletLiabilityMinor.toString(),
        };
      });
      const chart = Array.from({ length: 30 }, (_, index) => {
        const date = new Date(chartStart);
        date.setUTCDate(date.getUTCDate() + index);
        const key = date.toISOString().slice(0, 10);
        const dayDeposits = chartDeposits.filter((row) =>
          row.createdAt.toISOString().slice(0, 10) === key &&
          row.status === "APPROVED" && row.currency === "INR"
        );
        const dayFinance = contestChartEntries.filter((row) =>
          row.createdAt.toISOString().slice(0, 10) === key && row.currency === "INR"
        );
        const dayExpenses = expenseCategories.filter((row) =>
          row.createdAt.toISOString().slice(0, 10) === key && row.currency === "INR"
        );
        return {
          date: key,
          registrations: chartUsers.filter((row) => row.createdAt.toISOString().slice(0, 10) === key).length,
          approvedDepositMinor: dayDeposits.reduce((sum, row) => sum + row.amountMinor, 0n).toString(),
          rejectedDeposits: chartDeposits.filter((row) =>
            row.createdAt.toISOString().slice(0, 10) === key && row.status === "REJECTED"
          ).length,
          contestParticipants: chartContestEntries.filter((row) => row.joinedAt.toISOString().slice(0, 10) === key).length,
          contestEntryFeesMinor: dayFinance.filter((row) => row.type === "ENTRY_GROSS")
            .reduce((sum, row) => sum + row.amountPaise, 0n).toString(),
          commissionMinor: dayFinance.filter((row) => row.type === "PLATFORM_COMMISSION")
            .reduce((sum, row) => sum + row.amountPaise, 0n).toString(),
          expensesMinor: dayExpenses.reduce((sum, row) => sum + row.amountMinor, 0n).toString(),
        };
      });
      const enabledMatches = matchGroups
        .filter((row) => row.isEnabled)
        .reduce((sum, row) => sum + row._count._all, 0);
      const matchCount = (statuses: string[]) =>
        matchGroups
          .filter((row) => statuses.includes(row.status))
          .reduce((sum, row) => sum + row._count._all, 0);
      res.json({
        updatedAt: now.toISOString(),
        providers: {
          payments: "NOT_CONFIGURED",
          cricketData: process.env.CRICKETLIVEAPI_API_KEY?.trim() ? "CONFIGURED" : "NOT_CONFIGURED",
        },
        registrations: {
          total: registeredUsers,
          today: registrationsToday,
          thisWeek: registrationsThisWeek,
          thisMonth: registrationsThisMonth,
        },
        users: { active: activeUsers, suspended: suspendedUsers },
        deposits: {
          totalRequests: depositCount(["PENDING", "UNDER_REVIEW", "APPROVED", "REJECTED", "ESCALATED", "CANCELLED"]),
          pending: depositCount(["PENDING"]),
          underReview: depositCount(["UNDER_REVIEW"]),
          approved: depositCount(["APPROVED"]),
          rejected: depositCount(["REJECTED"]),
          escalated: depositCount(["ESCALATED"]),
        },
        withdrawals: {
          totalRequests: withdrawalCount(["PENDING", "UNDER_REVIEW", "APPROVED", "PAID", "REJECTED", "CANCELLED"]),
          pending: withdrawalCount(["PENDING", "UNDER_REVIEW", "APPROVED"]),
        },
        walletLiabilitiesMinor: {
          INR: ((inrWallets._sum.balanceMinor ?? 0n) + (inrWallets._sum.reservedMinor ?? 0n)).toString(),
          USDT: ((cryptoWallets._sum.balanceMinor ?? 0n) + (cryptoWallets._sum.reservedMinor ?? 0n)).toString(),
        },
        financials,
        contestPrizesRecordedMinor: (payoutTotals._sum.amountPaise ?? 0n).toString(),
        matches: {
          enabled: enabledMatches,
          live: matchCount(["LIVE", "IN_PROGRESS"]),
          upcoming: matchCount(["UPCOMING"]),
        },
        contests: {
          active: activeContests,
          participants: contestEntries,
        },
        chart,
        recentRegistrations: recentUsers.map((user) => ({
          ...user,
          role: effectiveRole(user),
        })),
        pendingDeposits: pendingDeposits.map((deposit) => ({
          id: deposit.id,
          amountMinor: deposit.amountMinor.toString(),
          currency: deposit.currency,
          paymentMethod: deposit.paymentMethod,
          paymentReference: deposit.paymentReference,
          status: deposit.status,
          createdAt: deposit.createdAt,
          user: deposit.user,
        })),
        pendingWithdrawals: pendingWithdrawals.map((withdrawal) => ({
          id: withdrawal.id,
          amountMinor: withdrawal.amountMinor.toString(),
          currency: withdrawal.currency,
          status: withdrawal.status,
          createdAt: withdrawal.createdAt,
          user: withdrawal.user,
        })),
        recentContestActivity: recentEntries.map((entry) => ({
          id: entry.id,
          joinedAt: entry.joinedAt,
          contest: entry.contest,
          user: entry.user,
        })),
        recentTransactions: recentLedger.map((entry) => ({
          id: entry.id,
          type: entry.type,
          amountMinor: entry.amountMinor.toString(),
          currency: entry.currency,
          reference: entry.reference,
          createdAt: entry.createdAt,
          user: entry.wallet.user,
        })),
      });
    } catch (error) {
      routeError(res, error, "Admin dashboard error");
    }
  });

  app.get("/api/admin/users", requireAuth, requireAdmin, async (req, res) => {
    const page = pagination(req);
    const search = typeof req.query.search === "string" ? req.query.search.trim().slice(0, 120) : "";
    if (!page) {
      res.status(400).json({ error: "Choose a valid page and page size (maximum 100)." });
      return;
    }
    try {
      const where: Prisma.UserWhereInput = search
        ? { OR: [{ email: { contains: search, mode: "insensitive" } }, { fantasyName: { contains: search, mode: "insensitive" } }] }
        : {};
      const [total, users] = await Promise.all([
        prisma.user.count({ where }),
        prisma.user.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: page.skip,
          take: page.pageSize,
          select: { id: true, email: true, fantasyName: true, role: true, accountStatus: true, createdAt: true },
        }),
      ]);
      res.json({
        page: page.page,
        pageSize: page.pageSize,
        total,
        users: users.map((user) => ({ ...user, role: effectiveRole(user) })),
      });
    } catch (error) {
      routeError(res, error, "List admin users error");
    }
  });

  app.patch("/api/admin/users/:userId/status", requireAuth, requireAdmin, async (req, res) => {
    const userId = typeof req.params.userId === "string" ? req.params.userId : "";
    const status = req.body?.status;
    if (!userId || !["ACTIVE", "SUSPENDED", "DEACTIVATED"].includes(status)) {
      res.status(400).json({ error: "Choose ACTIVE, SUSPENDED, or DEACTIVATED." });
      return;
    }
    try {
      const target = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, role: true, accountStatus: true },
      });
      if (!target) {
        res.status(404).json({ error: "User not found." });
        return;
      }
      if (
        target.id === req.authenticatedUser!.id ||
        (effectiveRole(target) !== "USER" && req.authenticatedUser!.role !== "SUPER_ADMIN")
      ) {
        res.status(403).json({ error: "You cannot change this account's status." });
        return;
      }
      const updated = await prisma.$transaction(async (tx) => {
        const user = await tx.user.update({
          where: { id: userId },
          data: { accountStatus: status },
          select: { id: true, accountStatus: true },
        });
        await appendAuditEvent(tx, req.authenticatedUser!.id, "USER_STATUS_CHANGED", "User", userId, {
          previousStatus: target.accountStatus,
          status,
        });
        return user;
      });
      res.json(updated);
    } catch (error) {
      routeError(res, error, "Update user status error");
    }
  });

  app.patch("/api/admin/users/:userId/role", requireAuth, requireSuperAdmin, async (req, res) => {
    const userId = typeof req.params.userId === "string" ? req.params.userId : "";
    const role = req.body?.role;
    if (!userId || !["USER", "ADMIN", "PAYOUT_OPERATOR"].includes(role)) {
      res.status(400).json({ error: "Choose USER, ADMIN, or PAYOUT_OPERATOR. Cash agents use Agent Management." });
      return;
    }
    if (userId === req.authenticatedUser!.id) {
      res.status(409).json({ error: "You cannot change your own role." });
      return;
    }
    try {
      const target = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, role: true },
      });
      if (!target) {
        res.status(404).json({ error: "User not found." });
        return;
      }
      if (
        effectiveRole(target) === "SUPER_ADMIN" ||
        target.role === "SUPER_ADMIN"
      ) {
        res.status(409).json({ error: "Super-administrator access is controlled through SUPER_ADMIN_EMAILS and cannot be changed here." });
        return;
      }
      const updated = await prisma.$transaction(async (tx) => {
        const user = await tx.user.update({
          where: { id: userId },
          data: { role },
          select: { id: true, email: true, role: true },
        });
        if (role !== "CASH_AGENT") {
          await tx.cashAgentProfile.updateMany({
            where: { userId },
            data: { active: false },
          });
        }
        await appendAuditEvent(tx, req.authenticatedUser!.id, "USER_ROLE_CHANGED", "User", userId, {
          previousRole: effectiveRole(target),
          role,
        });
        return user;
      });
      res.json({ id: updated.id, role: effectiveRole(updated) });
    } catch (error) {
      routeError(res, error, "Update user role error");
    }
  });

  app.get("/api/admin/agents", requireAuth, requireAdmin, async (_req, res) => {
    try {
      const agents = await prisma.cashAgentProfile.findMany({
        orderBy: { createdAt: "desc" },
        include: {
          user: {
            select: { id: true, email: true, fantasyName: true, accountStatus: true, role: true, createdAt: true },
          },
        },
      });
      const { today, month } = getUtcBoundaries();
      const agentUserIds = agents.map((agent) => agent.userId);
      const activity = agentUserIds.length
        ? await prisma.auditEvent.findMany({
          where: {
            actorUserId: { in: agentUserIds },
            createdAt: { gte: month },
            action: { in: ["DEPOSIT_CLAIMED", "DEPOSIT_REJECT", "DEPOSIT_ESCALATE"] },
          },
          select: { actorUserId: true, action: true, createdAt: true },
        })
        : [];
      res.json({
        agents: agents.map((agent) => ({
          id: agent.id,
          active: agent.active,
          transactionLimitMinor: agent.transactionLimitMinor?.toString() ?? null,
          permissions: agent.permissions,
          createdAt: agent.createdAt,
          user: { ...agent.user, role: effectiveRole(agent.user) },
          activity: {
            today: activity.filter((event) => event.actorUserId === agent.userId && event.createdAt >= today).length,
            thisMonth: activity.filter((event) => event.actorUserId === agent.userId).length,
            claimsThisMonth: activity.filter((event) => event.actorUserId === agent.userId && event.action === "DEPOSIT_CLAIMED").length,
            rejectionsThisMonth: activity.filter((event) => event.actorUserId === agent.userId && event.action === "DEPOSIT_REJECT").length,
            escalationsThisMonth: activity.filter((event) => event.actorUserId === agent.userId && event.action === "DEPOSIT_ESCALATE").length,
          },
        })),
      });
    } catch (error) {
      routeError(res, error, "List agents error");
    }
  });

  app.post("/api/admin/agents", requireAuth, requireAdmin, async (req, res) => {
    const userId = typeof req.body?.userId === "string" ? req.body.userId : "";
    const limit = req.body?.transactionLimitMinor === undefined || req.body?.transactionLimitMinor === null
      ? null
      : parseMinorAmount(req.body.transactionLimitMinor);
    const permissions = req.body?.permissions;
    if (
      !userId ||
      (req.body?.transactionLimitMinor !== undefined && req.body?.transactionLimitMinor !== null && limit === null) ||
      !Array.isArray(permissions) ||
      !permissions.every((item: unknown) => enabledAgentPermissions.includes(item as typeof enabledAgentPermissions[number]))
    ) {
      res.status(400).json({ error: "Provide an existing user, optional positive transaction limit, and valid agent permissions." });
      return;
    }
    try {
      const target = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, role: true, accountStatus: true },
      });
      if (!target) {
        res.status(404).json({ error: "Register the agent account before assigning agent access." });
        return;
      }
      if (
        target.accountStatus !== "ACTIVE" ||
        !["USER", "CASH_AGENT"].includes(effectiveRole(target)) ||
        target.id === req.authenticatedUser!.id
      ) {
        res.status(409).json({ error: "This account cannot be assigned as a cash agent." });
        return;
      }
      const agent = await prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id: userId }, data: { role: "CASH_AGENT" } });
        const profile = await tx.cashAgentProfile.upsert({
          where: { userId },
          create: {
            userId,
            active: true,
            transactionLimitMinor: limit,
            permissions: permissions as Prisma.InputJsonArray,
          },
          update: {
            active: true,
            transactionLimitMinor: limit,
            permissions: permissions as Prisma.InputJsonArray,
          },
        });
        await appendAuditEvent(tx, req.authenticatedUser!.id, "CASH_AGENT_ASSIGNED", "CashAgentProfile", profile.id, {
          userId,
          permissions: permissions as Prisma.InputJsonArray,
          transactionLimitMinor: limit?.toString() ?? null,
        });
        return profile;
      });
      res.status(201).json({ id: agent.id, userId: agent.userId, active: agent.active });
    } catch (error) {
      routeError(res, error, "Assign cash agent error");
    }
  });

  app.patch("/api/admin/agents/:userId", requireAuth, requireAdmin, async (req, res) => {
    const userId = typeof req.params.userId === "string" ? req.params.userId : "";
    const active = req.body?.active;
    const limit = req.body?.transactionLimitMinor === undefined || req.body?.transactionLimitMinor === null
      ? null
      : parseMinorAmount(req.body.transactionLimitMinor);
    const permissions = req.body?.permissions;
    if (
      !userId ||
      (active !== undefined && typeof active !== "boolean") ||
      (req.body?.transactionLimitMinor !== undefined && req.body?.transactionLimitMinor !== null && limit === null) ||
      (permissions !== undefined && (
        !Array.isArray(permissions) ||
        !permissions.every((item: unknown) => enabledAgentPermissions.includes(item as typeof enabledAgentPermissions[number]))
      ))
    ) {
      res.status(400).json({ error: "Invalid agent settings." });
      return;
    }
    try {
      const result = await prisma.$transaction(async (tx) => {
        const profile = await tx.cashAgentProfile.findUnique({ where: { userId } });
        if (!profile) throw new Error("AGENT_NOT_FOUND");
        if (profile.userId === req.authenticatedUser!.id) throw new Error("CANNOT_EDIT_SELF");
        const updated = await tx.cashAgentProfile.update({
          where: { userId },
          data: {
            ...(active === undefined ? {} : { active }),
            ...(req.body?.transactionLimitMinor === undefined ? {} : { transactionLimitMinor: limit }),
            ...(permissions === undefined ? {} : { permissions: permissions as Prisma.InputJsonArray }),
          },
        });
        if (active === false) {
          await tx.user.update({ where: { id: userId }, data: { role: "USER" } });
        } else if (active === true) {
          await tx.user.update({ where: { id: userId }, data: { role: "CASH_AGENT" } });
        }
        await appendAuditEvent(tx, req.authenticatedUser!.id, "CASH_AGENT_UPDATED", "CashAgentProfile", updated.id, {
          userId,
          active: updated.active,
          transactionLimitMinor: updated.transactionLimitMinor?.toString() ?? null,
          permissions: updated.permissions as Prisma.InputJsonValue,
        });
        return updated;
      });
      res.json({
        id: result.id,
        userId: result.userId,
        active: result.active,
        transactionLimitMinor: result.transactionLimitMinor?.toString() ?? null,
        permissions: result.permissions,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "AGENT_NOT_FOUND") {
        res.status(404).json({ error: "Cash agent not found." });
        return;
      }
      if (error instanceof Error && error.message === "CANNOT_EDIT_SELF") {
        res.status(403).json({ error: "Agents cannot change their own permissions." });
        return;
      }
      routeError(res, error, "Update cash agent error");
    }
  });

  app.get("/api/agent/deposits", requireAuth, requireActiveAgent, async (req, res) => {
    try {
      const userId = req.authenticatedUser!.id;
      const deposits = await prisma.depositRequest.findMany({
        where: {
          OR: [
            { status: "PENDING", assignedAgentId: null },
            { status: { in: ["UNDER_REVIEW", "ESCALATED"] }, assignedAgentId: userId },
          ],
        },
        orderBy: { createdAt: "asc" },
        take: 100,
        include: { user: { select: { id: true, email: true, fantasyName: true } } },
      });
      const duplicateReferences = deposits.length
        ? await prisma.depositRequest.groupBy({
          by: ["paymentReference"],
          where: { paymentReference: { in: deposits.map((deposit) => deposit.paymentReference) } },
          _count: { _all: true },
        })
        : [];
      const duplicateReferenceSet = new Set(
        duplicateReferences.filter((item) => item._count._all > 1).map((item) => item.paymentReference),
      );
      const { today, month } = getUtcBoundaries();
      const activity = await prisma.auditEvent.findMany({
        where: {
          actorUserId: userId,
          createdAt: { gte: month },
          action: { in: ["DEPOSIT_CLAIMED", "DEPOSIT_REJECT", "DEPOSIT_ESCALATE"] },
        },
        select: { action: true, createdAt: true },
      });
      res.json({
        deposits: deposits.map((deposit) => ({
          id: deposit.id,
          amountMinor: deposit.amountMinor.toString(),
          currency: deposit.currency,
          paymentMethod: deposit.paymentMethod,
          paymentReference: deposit.paymentReference,
          paidAt: deposit.paidAt,
          receiptAvailable: Boolean(deposit.receiptObjectKey),
          duplicateReference: duplicateReferenceSet.has(deposit.paymentReference),
          status: deposit.status,
          createdAt: deposit.createdAt,
          user: deposit.user,
        })),
        approvalEnabled: false,
        message: "Payment approval is disabled until provider-side verification is integrated.",
        activity: {
          today: activity.filter((event) => event.createdAt >= today).length,
          thisMonth: activity.length,
          claimsThisMonth: activity.filter((event) => event.action === "DEPOSIT_CLAIMED").length,
          rejectionsThisMonth: activity.filter((event) => event.action === "DEPOSIT_REJECT").length,
          escalationsThisMonth: activity.filter((event) => event.action === "DEPOSIT_ESCALATE").length,
        },
      });
    } catch (error) {
      routeError(res, error, "List agent deposits error");
    }
  });

  app.post("/api/agent/deposits/:depositId/claim", requireAuth, requireActiveAgent, async (req, res) => {
    const depositId = typeof req.params.depositId === "string" ? req.params.depositId : "";
    if (!depositId) {
      res.status(400).json({ error: "A deposit request ID is required." });
      return;
    }
    try {
      const profile = await prisma.cashAgentProfile.findUnique({
        where: { userId: req.authenticatedUser!.id },
        select: { permissions: true },
      });
      const permissions = profile?.permissions;
      if (!Array.isArray(permissions) || !permissions.includes("review_deposits")) {
        res.status(403).json({ error: "Your account does not have deposit-review permission." });
        return;
      }
      const claimed = await prisma.$transaction(async (tx) => {
        const result = await tx.depositRequest.updateMany({
          where: { id: depositId, status: "PENDING", assignedAgentId: null },
          data: { status: "UNDER_REVIEW", assignedAgentId: req.authenticatedUser!.id },
        });
        if (result.count !== 1) throw new Error("DEPOSIT_NOT_CLAIMABLE");
        await appendAuditEvent(tx, req.authenticatedUser!.id, "DEPOSIT_CLAIMED", "DepositRequest", depositId, {});
        return tx.depositRequest.findUniqueOrThrow({
          where: { id: depositId },
          select: { id: true, status: true, assignedAgentId: true, updatedAt: true },
        });
      });
      res.json(claimed);
    } catch (error) {
      if (error instanceof Error && error.message === "DEPOSIT_NOT_CLAIMABLE") {
        res.status(409).json({ error: "This deposit was already claimed or is no longer pending." });
        return;
      }
      routeError(res, error, "Claim deposit error");
    }
  });

  for (const action of ["reject", "escalate"] as const) {
    app.post(`/api/agent/deposits/:depositId/${action}`, requireAuth, requireActiveAgent, async (req, res) => {
      const depositId = typeof req.params.depositId === "string" ? req.params.depositId : "";
      const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 500) : "";
      if (!depositId || !reason) {
        res.status(400).json({ error: "A deposit request ID and decision reason are required." });
        return;
      }
      try {
        const profile = await prisma.cashAgentProfile.findUnique({
          where: { userId: req.authenticatedUser!.id },
          select: { permissions: true },
        });
        const permission = action === "reject" ? "reject_deposits" : "escalate_deposits";
        if (!Array.isArray(profile?.permissions) || !profile.permissions.includes(permission)) {
          res.status(403).json({ error: "Your account does not have permission for this action." });
          return;
        }
        const result = await prisma.$transaction(async (tx) => {
          const updated = await tx.depositRequest.updateMany({
            where: {
              id: depositId,
              status: "UNDER_REVIEW",
              assignedAgentId: req.authenticatedUser!.id,
            },
            data: {
              status: action === "reject" ? "REJECTED" : "ESCALATED",
              decisionReason: reason,
            },
          });
          if (updated.count !== 1) throw new Error("DEPOSIT_NOT_REVIEWABLE");
          await appendAuditEvent(tx, req.authenticatedUser!.id, `DEPOSIT_${action.toUpperCase()}`, "DepositRequest", depositId, {
            reason,
          });
          return tx.depositRequest.findUniqueOrThrow({
            where: { id: depositId },
            select: { id: true, status: true, decisionReason: true, updatedAt: true },
          });
        });
        res.json(result);
      } catch (error) {
        if (error instanceof Error && error.message === "DEPOSIT_NOT_REVIEWABLE") {
          res.status(409).json({ error: "The deposit is not assigned to you or is no longer under review." });
          return;
        }
        routeError(res, error, `${action} deposit error`);
      }
    });
  }

  app.get("/api/admin/deposits", requireAuth, requireAdmin, async (req, res) => {
    const page = pagination(req);
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    if (!page || (status && !["PENDING", "UNDER_REVIEW", "APPROVED", "REJECTED", "ESCALATED", "CANCELLED"].includes(status))) {
      res.status(400).json({ error: "Choose a valid pagination or deposit status filter." });
      return;
    }
    try {
      const where = status ? { status: status as DepositStatus } : {};
      const [total, deposits] = await Promise.all([
        prisma.depositRequest.count({ where }),
        prisma.depositRequest.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: page.skip,
          take: page.pageSize,
          include: {
            user: { select: { id: true, email: true, fantasyName: true } },
            assignedAgent: { select: { id: true, email: true, fantasyName: true } },
          },
        }),
      ]);
      const duplicateReferences = deposits.length
        ? await prisma.depositRequest.groupBy({
          by: ["paymentReference"],
          where: { paymentReference: { in: deposits.map((deposit) => deposit.paymentReference) } },
          _count: { _all: true },
        })
        : [];
      const duplicateReferenceSet = new Set(
        duplicateReferences.filter((item) => item._count._all > 1).map((item) => item.paymentReference),
      );
      res.json({
        page: page.page,
        pageSize: page.pageSize,
        total,
        deposits: deposits.map((deposit) => ({
          id: deposit.id,
          amountMinor: deposit.amountMinor.toString(),
          currency: deposit.currency,
          paymentMethod: deposit.paymentMethod,
          paymentReference: deposit.paymentReference,
          status: deposit.status,
          duplicateReference: duplicateReferenceSet.has(deposit.paymentReference),
          decisionReason: deposit.decisionReason,
          createdAt: deposit.createdAt,
          updatedAt: deposit.updatedAt,
          assignedAgent: deposit.assignedAgent,
          user: deposit.user,
        })),
        approvalEnabled: false,
      });
    } catch (error) {
      routeError(res, error, "List admin deposits error");
    }
  });


  app.post("/api/admin/deposits/:depositId/approve", requireAuth, requireAdmin, async (req, res) => {
    if (process.env.ENABLE_VERIFIED_DEPOSIT_APPROVAL !== "true") {
      res.status(503).json({
        error: "Deposit approval is disabled until verification and wallet-credit tests are complete.",
      });
      return;
    }

    const depositId = typeof req.params.depositId === "string" ? req.params.depositId : "";
    const body = req.body as {
      paymentVerified?: unknown;
      verifiedPaymentReference?: unknown;
      reason?: unknown;
    } | undefined;

    const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
    const verifiedPaymentReference =
      typeof body?.verifiedPaymentReference === "string"
        ? body.verifiedPaymentReference.trim()
        : "";

    if (!depositId) {
      res.status(400).json({ error: "A valid deposit ID is required." });
      return;
    }

    if (
      body?.paymentVerified !== true ||
      reason.length < 10 ||
      reason.length > 500 ||
      !verifiedPaymentReference
    ) {
      res.status(400).json({
        error: "Confirm independent payment verification, provide the exact verified payment reference, and enter a reason of 10–500 characters.",
      });
      return;
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
        const deposit = await tx.depositRequest.findUnique({
          where: { id: depositId },
          select: {
            id: true,
            userId: true,
            amountMinor: true,
            currency: true,
            paymentMethod: true,
            paymentReference: true,
            status: true,
          },
        });

        if (!deposit) throw new Error("DEPOSIT_NOT_FOUND");

        if (deposit.paymentReference.trim().toLowerCase() !== verifiedPaymentReference.toLowerCase()) {
          throw new Error("PAYMENT_REFERENCE_MISMATCH");
        }

        if (!["PENDING", "UNDER_REVIEW", "ESCALATED"].includes(deposit.status)) {
          throw new Error("DEPOSIT_NOT_APPROVABLE");
        }

        if (deposit.amountMinor <= 0n || deposit.currency !== "INR") {
          throw new Error("INVALID_DEPOSIT_AMOUNT_OR_CURRENCY");
        }

        // Conditional status transition prevents concurrent/repeated approval.
        const changed = await tx.depositRequest.updateMany({
          where: {
            id: deposit.id,
            status: {
              in: [
                DepositStatus.PENDING,
                DepositStatus.UNDER_REVIEW,
                DepositStatus.ESCALATED,
              ],
            },
          },
          data: {
            status: DepositStatus.APPROVED,
            verifiedAt: new Date(),
            decisionReason: reason,
          },
        });

        if (changed.count !== 1) throw new Error("DEPOSIT_NOT_APPROVABLE");

        // Total balance and deposited-funds balance are updated atomically.
        const wallet = await tx.wallet.upsert({
          where: {
            userId_currency: {
              userId: deposit.userId,
              currency: deposit.currency,
            },
          },
          create: {
            userId: deposit.userId,
            currency: deposit.currency,
            balanceMinor: deposit.amountMinor,
            depositedBalanceMinor: deposit.amountMinor,
            winningsBalanceMinor: 0n,
          },
          update: {
            balanceMinor: { increment: deposit.amountMinor },
            depositedBalanceMinor: { increment: deposit.amountMinor },
          },
          select: { id: true },
        });

        await tx.walletLedgerEntry.create({
          data: {
            walletId: wallet.id,
            type: "DEPOSIT",
            amountMinor: deposit.amountMinor,
            currency: deposit.currency,
            idempotencyKey: `deposit:${deposit.id}`,
            reference: deposit.id,
            metadata: {
              paymentMethod: deposit.paymentMethod,
              paymentReference: deposit.paymentReference,
              verifiedByAdminId: req.authenticatedUser!.id,
              verificationReason: reason,
            },
          },
        });

        await appendAuditEvent(
          tx,
          req.authenticatedUser!.id,
          "DEPOSIT_APPROVED",
          "DepositRequest",
          deposit.id,
          {
            amountMinor: deposit.amountMinor.toString(),
            currency: deposit.currency,
            paymentMethod: deposit.paymentMethod,
            paymentReference: deposit.paymentReference,
            reason,
          },
        );

        return {
          id: deposit.id,
          status: DepositStatus.APPROVED,
          amountMinor: deposit.amountMinor.toString(),
          currency: deposit.currency,
        };
      });

      res.json({ success: true, deposit: result });
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === "DEPOSIT_NOT_FOUND") {
          res.status(404).json({ error: "Deposit request not found." });
          return;
        }

        if (error.message === "PAYMENT_REFERENCE_MISMATCH") {
          res.status(400).json({ error: "The verified payment reference does not match the deposit request." });
          return;
        }

        if (error.message === "DEPOSIT_NOT_APPROVABLE") {
          res.status(409).json({ error: "This deposit has already been decided or cannot be approved." });
          return;
        }

        if (error.message === "INVALID_DEPOSIT_AMOUNT_OR_CURRENCY") {
          res.status(409).json({ error: "The deposit amount or currency is invalid." });
          return;
        }

        // A duplicate ledger idempotency key aborts the transaction, including
        // the wallet update and status change.
        if ("code" in error && error.code === "P2002") {
          res.status(409).json({ error: "A duplicate ledger or payment reference prevented this operation." });
          return;
        }
      }

      routeError(res, error, "Approve deposit error");
    }
  });

  app.get("/api/admin/withdrawals", requireAuth, requireAdmin, async (req, res) => {
    const page = pagination(req);
    if (!page) {
      res.status(400).json({ error: "Choose a valid page and page size (maximum 100)." });
      return;
    }
    try {
      const [total, withdrawals] = await Promise.all([
        prisma.withdrawalRequest.count(),
        prisma.withdrawalRequest.findMany({
          orderBy: { createdAt: "desc" },
          skip: page.skip,
          take: page.pageSize,
          include: {
            user: { select: { id: true, email: true, fantasyName: true } },
            reviewedBy: { select: { id: true, email: true, fantasyName: true } },
          },
        }),
      ]);
      res.json({
        page: page.page,
        pageSize: page.pageSize,
        total,
        withdrawals: withdrawals.map((withdrawal) => ({
          id: withdrawal.id,
          amountMinor: withdrawal.amountMinor.toString(),
          currency: withdrawal.currency,
          status: withdrawal.status,
          payoutMethod: withdrawal.payoutMethod,
          payoutReference: withdrawal.payoutReference,
          decisionReason: withdrawal.decisionReason,
          createdAt: withdrawal.createdAt,
          updatedAt: withdrawal.updatedAt,
          user: withdrawal.user,
          reviewedBy: withdrawal.reviewedBy,
        })),
        payoutEnabled: false,
      });
    } catch (error) {
      routeError(res, error, "List admin withdrawals error");
    }
  });

  app.get("/api/admin/matches", requireAuth, requireAdmin, async (req, res) => {
    const page = pagination(req);
    const search = typeof req.query.search === "string" ? req.query.search.trim().slice(0, 120) : "";
    const competition = typeof req.query.competition === "string" ? req.query.competition.trim().slice(0, 120) : "";
    const format = typeof req.query.format === "string" ? req.query.format.trim().slice(0, 40) : "";
    const status = typeof req.query.status === "string" ? req.query.status : "";
    const from = typeof req.query.from === "string" ? new Date(req.query.from) : null;
    const to = typeof req.query.to === "string" ? new Date(req.query.to) : null;
    if (to && typeof req.query.to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to)) {
      to.setUTCHours(23, 59, 59, 999);
    }
    if (
      !page ||
      (status && !["UPCOMING", "LIVE", "IN_PROGRESS", "COMPLETED", "CANCELLED", "ABANDONED", "POSTPONED"].includes(status)) ||
      (from && Number.isNaN(from.getTime())) ||
      (to && Number.isNaN(to.getTime())) ||
      (from && to && from > to)
    ) {
      res.status(400).json({ error: "Choose valid match filters and pagination." });
      return;
    }
    try {
      const where: Prisma.MatchWhereInput = {
        ...(status ? { status } : {}),
        ...(competition ? { competition: { contains: competition, mode: "insensitive" } } : {}),
        ...(format ? { format: { equals: format, mode: "insensitive" } } : {}),
        ...(from || to ? { startsAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
        ...(search ? {
          OR: [
            { title: { contains: search, mode: "insensitive" } },
            { competition: { contains: search, mode: "insensitive" } },
            { participants: { some: { cricketTeam: { name: { contains: search, mode: "insensitive" } } } } },
          ],
        } : {}),
      };
      const [total, matches] = await Promise.all([
        prisma.match.count({ where }),
        prisma.match.findMany({
          where,
          orderBy: [{ startsAt: "asc" }, { title: "asc" }],
          skip: page.skip,
          take: page.pageSize,
          include: {
            participants: {
              include: {
                cricketTeam: { select: { id: true, name: true, shortName: true } },
              },
            },
            players: {
              where: { isInSquad: true },
              select: {
                cricketTeamId: true,
                role: true,
                creditValue: true,
                isInSquad: true,
                player: { select: { provider: true, externalPlayerId: true } },
              },
            },
            _count: { select: { contests: true, teams: true } },
          },
        }),
      ]);
      res.json({
        page: page.page,
        pageSize: page.pageSize,
        total,
        providerConfigured: Boolean(process.env.CRICKETLIVEAPI_API_KEY?.trim()),
        matches: matches.map((match) => {
          const playerReadiness = validatePlayerPoolReadiness(
            match.participants,
            match.players.map((player) => ({
              cricketTeamId: player.cricketTeamId,
              role: player.role,
              creditValue: player.creditValue,
              isInSquad: player.isInSquad,
              provider: player.player.provider,
              externalPlayerId: player.player.externalPlayerId,
            })),
            match.status,
            match.playersSyncError ? [match.playersSyncError] : [],
          );
          const status = !match.provider
            ? "PROVIDER_UNAVAILABLE"
            : match.dataStatus === "READY" && playerReadiness.ready
              ? "READY"
              : "INCOMPLETE";
          return {
            id: match.id,
            title: match.title,
            startsAt: match.startsAt,
            status: match.status,
            provider: match.provider,
            externalFixtureId: match.externalFixtureId,
            competition: match.competition,
            format: match.format,
            isEnabled: match.isEnabled,
            isSuspended: match.isSuspended,
            archivedAt: match.archivedAt,
            readiness: status,
            playersLastSyncedAt: match.playersLastSyncedAt,
            playersSyncError: match.playersSyncError,
            playingXIConfirmed: match.playingXIConfirmed,
            playingXILastSyncedAt: match.playingXILastSyncedAt,
            playingXISyncError: match.playingXISyncError,
            participantTeams: match.participants.map(({ cricketTeam }) => ({
              id: cricketTeam.id,
              name: cricketTeam.name,
              shortName: cricketTeam.shortName,
              playerCount: match.players.filter((player) =>
                player.cricketTeamId === cricketTeam.id
              ).length,
            })),
            lastSyncedAt: match.lastSyncedAt,
            syncError: match.syncError,
            linkedContests: match._count.contests,
            savedTeams: match._count.teams,
          };
        }),
      });
    } catch (error) {
      routeError(res, error, "List admin matches error");
    }
  });

  app.post("/api/admin/matches/:matchId/sync-players", requireAuth, requireAdmin, async (req, res) => {
    const matchId = typeof req.params.matchId === "string" ? req.params.matchId : "";
    if (!matchId) {
      res.status(400).json({ error: "A match ID is required." });
      return;
    }

    const match = await prisma.match.findUnique({
      where: { id: matchId },
      include: {
        participants: {
          include: { cricketTeam: { select: { id: true, shortName: true } } },
        },
      },
    });
    if (!match) {
      res.status(404).json({ error: "Match not found." });
      return;
    }
    if (match.provider !== "CRICKETLIVEAPI" || !match.externalFixtureId) {
      res.status(409).json({ error: "This match does not have a CricketLiveAPI fixture ID." });
      return;
    }

    const [playerPoolResult, playingXIResult] = await Promise.allSettled([
      fetchCricketLiveApiPlayerPool(match.externalFixtureId),
      fetchCricketLiveApiPlayingXI(match.externalFixtureId),
    ]);
    if (playerPoolResult.status === "rejected") {
      const syncError = playerPoolResult.reason instanceof Error
        ? playerPoolResult.reason.message
        : "CricketLiveAPI player-list request failed.";
      console.error("CricketLiveAPI player-list sync failed:", syncError);
      try {
        await prisma.$transaction(async (tx) => {
          await tx.match.update({
            where: { id: matchId },
            data: {
              dataStatus: "INCOMPLETE",
              playersLastSyncedAt: new Date(),
              playersSyncError: syncError.slice(0, 1000),
              playingXIConfirmed: false,
              playingXILastSyncedAt: new Date(),
              playingXISyncError: playingXIResult.status === "rejected"
                ? String(playingXIResult.reason).slice(0, 1000)
                : "Player pool could not be validated; playing XI was not applied.",
            },
          });
          await tx.matchPlayer.updateMany({
            where: { matchId },
            data: { isPlayingXI: false },
          });
          await appendAuditEvent(tx, req.authenticatedUser!.id, "CRICKETLIVEAPI_PLAYER_SYNC_FAILED", "Match", matchId, {
            error: syncError.slice(0, 1000),
          });
        });
      } catch (error) {
        routeError(res, error, "Record CricketLiveAPI player sync failure error");
        return;
      }
      res.status(502).json({ error: syncError });
      return;
    }

    const playingXIError = playingXIResult.status === "rejected"
      ? playingXIResult.reason instanceof Error
        ? playingXIResult.reason.message
        : "CricketLiveAPI playing-XI request failed."
      : null;
    if (playingXIError) {
      console.error("CricketLiveAPI playing-XI sync failed:", playingXIError);
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
        const playerSummary = await importCricketLiveApiPlayerPool(tx, {
          matchId,
          fixtureStatus: match.status,
          participants: match.participants,
          pool: playerPoolResult.value,
        });
        let playingXIConfirmed = false;
        let finalPlayingXIError = playingXIError;
        if (playingXIResult.status === "fulfilled") {
          const xiSummary = await importCricketLiveApiPlayingXI(
            tx,
            matchId,
            playingXIResult.value,
          );
          playingXIConfirmed = xiSummary.confirmed;
          if (xiSummary.errors.length) {
            finalPlayingXIError = xiSummary.errors.join(" ");
            console.error("CricketLiveAPI playing-XI validation failed:", finalPlayingXIError);
          }
        } else {
          await tx.matchPlayer.updateMany({
            where: { matchId },
            data: { isPlayingXI: false },
          });
          await tx.match.update({
            where: { id: matchId },
            data: {
              playingXIConfirmed: false,
              playingXILastSyncedAt: new Date(),
              playingXISyncError: playingXIError?.slice(0, 1000) ?? null,
            },
          });
        }
        await appendAuditEvent(tx, req.authenticatedUser!.id, "CRICKETLIVEAPI_PLAYERS_SYNCED", "Match", matchId, {
          received: playerSummary.received,
          imported: playerSummary.imported,
          ready: playerSummary.ready,
          errors: playerSummary.errors,
          warnings: playerSummary.warnings,
          playingXIConfirmed,
          playingXIError: finalPlayingXIError,
        });
        return {
          ...playerSummary,
          playingXIConfirmed,
          playingXIError: finalPlayingXIError,
        };
      }, { maxWait: 10_000, timeout: 60_000 });
      res.json(result);
    } catch (error) {
      routeError(res, error, "Import CricketLiveAPI players error");
    }
  });

  app.post("/api/admin/matches/sync", requireAuth, requireAdmin, async (req, res) => {
    const apiKey = process.env.CRICKETLIVEAPI_API_KEY?.trim();
    if (!apiKey) {
      res.status(503).json({ error: "CricketLiveAPI is not configured. Set CRICKETLIVEAPI_API_KEY in the API environment." });
      return;
    }

    let matches: CricketLiveApiMatch[];
    try {
      matches = await fetchCricketLiveApiMatches(apiKey);
    } catch (error) {
      if (error instanceof CricketLiveApiContractError) {
        console.error("CricketLiveAPI matches response validation failed:", error.message);
        res.status(502).json({ error: error.message });
        return;
      }
      console.error("CricketLiveAPI matches request failed:", error);
      res.status(502).json({
        error: error instanceof Error ? error.message : "CricketLiveAPI matches request failed.",
      });
      return;
    }

    // Sync every fixture returned by the provider so existing matches can
    // transition from UPCOMING to LIVE and then COMPLETED. Records absent
    // from the provider response are not deleted.
    const fixturesToSync = matches;

    try {
      const result = await prisma.$transaction(async (tx) => {
        const summary = await importCricketLiveApiMatches(tx, fixturesToSync);
        await appendAuditEvent(tx, req.authenticatedUser!.id, "CRICKETLIVEAPI_MATCHES_SYNCED", "Match", null, {
          received: summary.received,
          created: summary.created,
          updated: summary.updated,
        });
        return summary;
      }, { maxWait: 10_000, timeout: 60_000 });
      res.json(result);
    } catch (error) {
      routeError(res, error, "Import CricketLiveAPI matches error");
    }
  });

  app.patch("/api/admin/matches/:matchId", requireAuth, requireAdmin, async (req, res) => {
    const matchId = typeof req.params.matchId === "string" ? req.params.matchId : "";
    const { isEnabled, isSuspended, archived } = req.body ?? {};
    if (
      !matchId ||
      (isEnabled !== undefined && typeof isEnabled !== "boolean") ||
      (isSuspended !== undefined && typeof isSuspended !== "boolean") ||
      (archived !== undefined && typeof archived !== "boolean") ||
      [isEnabled, isSuspended, archived].filter((value) => value !== undefined).length !== 1
    ) {
      res.status(400).json({ error: "Choose one match action: isEnabled, isSuspended, or archived." });
      return;
    }
    try {
      const match = await prisma.match.findUnique({
        where: { id: matchId },
        include: {
          participants: { include: { cricketTeam: { select: { shortName: true } } } },
          players: {
            where: { isInSquad: true },
            select: {
              cricketTeamId: true,
              role: true,
              creditValue: true,
              isInSquad: true,
              player: { select: { provider: true, externalPlayerId: true } },
            },
          },
        },
      });
      if (!match) {
        res.status(404).json({ error: "Match not found." });
        return;
      }
      const playerReadiness = validatePlayerPoolReadiness(
        match.participants,
        match.players.map((player) => ({
          cricketTeamId: player.cricketTeamId,
          role: player.role,
          creditValue: player.creditValue,
          isInSquad: player.isInSquad,
          provider: player.player.provider,
          externalPlayerId: player.player.externalPlayerId,
        })),
        match.status,
        match.playersSyncError ? [match.playersSyncError] : [],
      );
      const ready = Boolean(match.provider) &&
        match.dataStatus === "READY" &&
        playerReadiness.ready &&
        !match.syncError;
      if (isEnabled === true && (!ready || match.isSuspended || match.archivedAt)) {
        res.status(409).json({ error: "This match cannot be published until an integrated provider confirms fixture and squad readiness." });
        return;
      }
      const updateData: Prisma.MatchUpdateInput = {
        ...(isEnabled === undefined ? {} : { isEnabled }),
        ...(isSuspended === undefined ? {} : { isSuspended }),
        ...(archived === undefined ? {} : { archivedAt: archived ? new Date() : null }),
        ...(isSuspended === true ? { isEnabled: false } : {}),
        ...(archived === true ? { isEnabled: false } : {}),
      };
      const updated = await prisma.$transaction(async (tx) => {
        const result = await tx.match.update({
          where: { id: matchId },
          data: updateData,
          select: {
            id: true,
            isEnabled: true,
            isSuspended: true,
            archivedAt: true,
          },
        });
        await appendAuditEvent(tx, req.authenticatedUser!.id, "MATCH_PUBLICATION_UPDATED", "Match", matchId, {
          isEnabled: result.isEnabled,
          isSuspended: result.isSuspended,
          archivedAt: result.archivedAt?.toISOString() ?? null,
        });
        return result;
      });
      res.json(updated);
    } catch (error) {
      routeError(res, error, "Update match publication error");
    }
  });

  app.get("/api/admin/audit-events", requireAuth, requireAdmin, async (req, res) => {
    const page = pagination(req);
    if (!page) {
      res.status(400).json({ error: "Choose a valid page and page size (maximum 100)." });
      return;
    }
    try {
      const [total, events] = await Promise.all([
        prisma.auditEvent.count(),
        prisma.auditEvent.findMany({
          orderBy: { createdAt: "desc" },
          skip: page.skip,
          take: page.pageSize,
          include: { actor: { select: { id: true, email: true, fantasyName: true } } },
        }),
      ]);
      res.json({
        page: page.page,
        pageSize: page.pageSize,
        total,
        events: events.map((event) => ({
          id: event.id,
          action: event.action,
          entityType: event.entityType,
          entityId: event.entityId,
          details: event.details,
          previousHash: event.previousHash,
          eventHash: event.eventHash,
          createdAt: event.createdAt,
          actor: event.actor,
        })),
      });
    } catch (error) {
      routeError(res, error, "List audit events error");
    }
  });

  app.post("/api/admin/audit-events/verify", requireAuth, requireSuperAdmin, async (_req, res) => {
    try {
      let sequence = 0;
      let previousHash = "";
      let checked = 0;
      let valid = true;
      while (valid) {
        const events = await prisma.auditEvent.findMany({
          where: { sequence: { gt: sequence } },
          orderBy: { sequence: "asc" },
          take: 1000,
        });
        if (events.length === 0) break;
        for (const event of events) {
          const payload = stableJson({
            id: event.id,
            sequence: event.sequence,
            actorUserId: event.actorUserId,
            action: event.action,
            entityType: event.entityType,
            entityId: event.entityId,
            details: event.details,
            createdAt: event.createdAt.toISOString(),
          });
          const computedHash = createHash("sha256")
            .update(previousHash)
            .update("\n")
            .update(payload)
            .digest("hex");
          if (event.sequence !== sequence + 1 || event.previousHash !== previousHash || event.eventHash !== computedHash) {
            valid = false;
            break;
          }
          previousHash = event.eventHash;
          sequence = event.sequence;
          checked += 1;
        }
      }
      const state = await prisma.auditChainState.findUnique({ where: { id: 1 } });
      if ((state?.lastSequence ?? 0) !== checked || (state?.lastHash ?? "") !== previousHash) {
        valid = false;
      }
      res.json({ valid, checked, verifiedAt: new Date().toISOString() });
    } catch (error) {
      routeError(res, error, "Verify audit chain error");
    }
  });

  app.get("/api/admin/financial-report.csv", requireAuth, requireAdmin, async (req, res) => {
    const fromValue = typeof req.query.from === "string" ? new Date(req.query.from) : null;
    const toValue = typeof req.query.to === "string" ? new Date(req.query.to) : null;
    if (
      (fromValue && Number.isNaN(fromValue.getTime())) ||
      (toValue && Number.isNaN(toValue.getTime())) ||
      (fromValue && toValue && fromValue > toValue)
    ) {
      res.status(400).json({ error: "Provide a valid date range." });
      return;
    }
    if (fromValue && toValue && toValue.getTime() - fromValue.getTime() > 90 * 24 * 60 * 60 * 1000) {
      res.status(400).json({ error: "CSV exports are limited to a 90-day range." });
      return;
    }
    try {
      const dateFilter = {
        ...(fromValue ? { gte: fromValue } : {}),
        ...(toValue ? { lte: toValue } : {}),
      };
      const [entries, expenses, deposits, withdrawals, contestEntries, payouts] = await Promise.all([
        prisma.walletLedgerEntry.findMany({
          where: Object.keys(dateFilter).length ? { createdAt: dateFilter } : {},
          orderBy: { createdAt: "asc" },
          take: 10_000,
          include: { wallet: { include: { user: { select: { id: true, email: true } } } } },
        }),
        prisma.platformExpense.findMany({
          where: Object.keys(dateFilter).length ? { createdAt: dateFilter } : {},
          orderBy: { createdAt: "asc" },
          take: 10_000,
          include: { recordedBy: { select: { id: true, email: true } } },
        }),
        prisma.depositRequest.findMany({
          where: Object.keys(dateFilter).length ? { createdAt: dateFilter } : {},
          orderBy: { createdAt: "asc" },
          take: 10_000,
          include: {
            user: { select: { id: true } },
            assignedAgent: { select: { email: true } },
          },
        }),
        prisma.withdrawalRequest.findMany({
          where: Object.keys(dateFilter).length ? { createdAt: dateFilter } : {},
          orderBy: { createdAt: "asc" },
          take: 10_000,
          include: {
            user: { select: { id: true } },
            reviewedBy: { select: { email: true } },
          },
        }),
        prisma.contestFinancialEntry.findMany({
          where: Object.keys(dateFilter).length ? { createdAt: dateFilter } : {},
          orderBy: { createdAt: "asc" },
          take: 10_000,
        }),
        prisma.contestPayout.findMany({
          where: Object.keys(dateFilter).length ? { createdAt: dateFilter } : {},
          orderBy: { createdAt: "asc" },
          take: 10_000,
          include: { user: { select: { id: true } } },
        }),
      ]);
      const rowCount = entries.length + expenses.length + deposits.length + withdrawals.length +
        contestEntries.length + payouts.length;
      if (rowCount >= 50_000) {
        res.status(413).json({ error: "The report exceeds the export limit. Narrow the date range." });
        return;
      }
      const rows = [
        ["timestamp", "record_type", "user_id", "staff_email", "type_or_category", "amount_minor", "currency", "reference", "idempotency_key"],
        ...entries.map((entry) => [
          entry.createdAt.toISOString(),
          "WALLET_LEDGER",
          entry.wallet.user.id,
          "",
          entry.type,
          entry.amountMinor.toString(),
          entry.currency,
          entry.reference ?? "",
          entry.idempotencyKey,
        ]),
        ...expenses.map((expense) => [
          expense.createdAt.toISOString(),
          "PLATFORM_EXPENSE",
          "",
          expense.recordedBy.email,
          expense.category,
          expense.amountMinor.toString(),
          expense.currency,
          expense.reference ?? "",
          expense.idempotencyKey,
        ]),
        ...deposits.map((deposit) => [
          deposit.createdAt.toISOString(),
          `DEPOSIT_${deposit.status}`,
          deposit.user.id,
          deposit.assignedAgent?.email ?? "",
          deposit.paymentMethod,
          deposit.amountMinor.toString(),
          deposit.currency,
          deposit.paymentReference,
          deposit.idempotencyKey,
        ]),
        ...withdrawals.map((withdrawal) => [
          withdrawal.createdAt.toISOString(),
          `WITHDRAWAL_${withdrawal.status}`,
          withdrawal.user.id,
          withdrawal.reviewedBy?.email ?? "",
          withdrawal.payoutMethod,
          withdrawal.amountMinor.toString(),
          withdrawal.currency,
          withdrawal.payoutReference ?? "",
          withdrawal.idempotencyKey,
        ]),
        ...contestEntries.map((entry) => [
          entry.createdAt.toISOString(),
          `CONTEST_${entry.type}`,
          "",
          "",
          entry.type,
          entry.amountPaise.toString(),
          entry.currency,
          entry.contestId,
          entry.idempotencyKey,
        ]),
        ...payouts.map((payout) => [
          payout.createdAt.toISOString(),
          "CONTEST_PAYOUT_RECORDED",
          payout.user.id,
          "",
          "PAYOUT",
          payout.amountPaise.toString(),
          "INR",
          `${payout.contestId}:${payout.entryId}`,
          "",
        ]),
      ];
      const csv = rows.map((row) => row.map(toCsvCell).join(",")).join("\r\n");
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="willfantasy-financial-report.csv"');
      res.send(csv);
    } catch (error) {
      routeError(res, error, "Export financial report error");
    }
  });

  app.post("/api/admin/expenses", requireAuth, requireSuperAdmin, async (req, res) => {
    const amountMinor = parseMinorAmount(req.body?.amountMinor);
    const currency = typeof req.body?.currency === "string" ? req.body.currency.toUpperCase() : "";
    const category = typeof req.body?.category === "string" ? req.body.category.trim().slice(0, 80) : "";
    const idempotencyKey = typeof req.body?.idempotencyKey === "string" ? req.body.idempotencyKey.trim() : "";
    const reference = typeof req.body?.reference === "string" ? req.body.reference.trim().slice(0, 160) : null;
    const notes = typeof req.body?.notes === "string" ? req.body.notes.trim().slice(0, 1000) : null;
    if (
      amountMinor === null ||
      !["INR", "USDT"].includes(currency) ||
      !category ||
      !/^[A-Za-z0-9:_-]{8,120}$/.test(idempotencyKey)
    ) {
      res.status(400).json({ error: "Provide a positive amount, INR or USDT currency, category, and unique idempotency key." });
      return;
    }
    try {
      const expense = await prisma.$transaction(async (tx) => {
        const created = await tx.platformExpense.create({
          data: {
            amountMinor,
            currency,
            category,
            idempotencyKey,
            reference,
            notes,
            recordedById: req.authenticatedUser!.id,
          },
        });
        await appendAuditEvent(tx, req.authenticatedUser!.id, "PLATFORM_EXPENSE_RECORDED", "PlatformExpense", created.id, {
          amountMinor: amountMinor.toString(),
          currency,
          category,
          reference,
        });
        return created;
      });
      res.status(201).json({
        id: expense.id,
        amountMinor: expense.amountMinor.toString(),
        currency: expense.currency,
        category: expense.category,
        createdAt: expense.createdAt,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        res.status(409).json({ error: "That expense idempotency key has already been used." });
        return;
      }
      routeError(res, error, "Record platform expense error");
    }
  });

}
