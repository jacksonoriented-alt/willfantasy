import "dotenv/config";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import { PrismaClient } from "@prisma/client";

const runIntegration = process.env.RUN_CONTEST_INTEGRATION_TESTS === "1";

test("contest admin setup remains available while demo money and scoring endpoints are absent", {
  skip: !runIntegration,
}, async () => {
  const prisma = new PrismaClient();
  const suffix = `${Date.now()}-${randomBytes(4).toString("hex")}`;
  const adminEmail = "contest-engine-admin@integration.invalid";
  const superAdminEmail = "contest-engine-superadmin@integration.invalid";
  const apiUrl = process.env.TEST_API_URL ?? `http://localhost:${process.env.PORT || "4000"}`;
  const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const registrationDeadline = new Date(startsAt.getTime() - 15 * 60_000);
  let matchId: string | undefined;
  let contestId: string | undefined;
  let userId: string | undefined;
  let superAdminId: string | undefined;
  let agentUserId: string | undefined;
  let depositorId: string | undefined;
  let depositId: string | undefined;
  let sessionId: string | undefined;
  let superAdminSessionId: string | undefined;
  let agentSessionId: string | undefined;
  const initialAuditChainState = await prisma.auditChainState.findUnique({ where: { id: 1 } });
  const token = randomBytes(32).toString("base64url");
  const superAdminToken = randomBytes(32).toString("base64url");
  const agentToken = randomBytes(32).toString("base64url");

  try {
    const match = await prisma.match.create({
      data: { title: `Integration test match ${suffix}`, status: "UPCOMING", startsAt },
    });
    matchId = match.id;

    const user = await prisma.user.create({
      data: {
        email: adminEmail,
        passwordHash: "integration-test-only",
        displayName: "Contest Engine Admin Test",
        fantasyName: `Engine Admin ${suffix}`,
      },
    });
    userId = user.id;

    const session = await prisma.session.create({
      data: {
        tokenHash: createHash("sha256").update(token).digest("hex"),
        userId: user.id,
        expiresAt: new Date(Date.now() + 60 * 60_000),
      },
    });
    sessionId = session.id;

    const superAdmin = await prisma.user.create({
      data: {
        email: superAdminEmail,
        passwordHash: "integration-test-only",
        displayName: "Contest Engine Super Admin Test",
        fantasyName: `Engine Super Admin ${suffix}`,
      },
    });
    superAdminId = superAdmin.id;
    const superAdminSession = await prisma.session.create({
      data: {
        tokenHash: createHash("sha256").update(superAdminToken).digest("hex"),
        userId: superAdmin.id,
        expiresAt: new Date(Date.now() + 60 * 60_000),
      },
    });
    superAdminSessionId = superAdminSession.id;

    const agent = await prisma.user.create({
      data: {
        email: `contest-engine-agent-${suffix}@integration.invalid`,
        passwordHash: "integration-test-only",
        displayName: "Contest Engine Agent Test",
        fantasyName: `Engine Agent ${suffix}`,
      },
    });
    agentUserId = agent.id;
    const agentSession = await prisma.session.create({
      data: {
        tokenHash: createHash("sha256").update(agentToken).digest("hex"),
        userId: agent.id,
        expiresAt: new Date(Date.now() + 60 * 60_000),
      },
    });
    agentSessionId = agentSession.id;

    const depositor = await prisma.user.create({
      data: {
        email: `contest-engine-depositor-${suffix}@integration.invalid`,
        passwordHash: "integration-test-only",
        displayName: "Contest Engine Depositor Test",
        fantasyName: `Engine Depositor ${suffix}`,
      },
    });
    depositorId = depositor.id;
    const deposit = await prisma.depositRequest.create({
      data: {
        userId: depositor.id,
        amountMinor: 4900n,
        currency: "INR",
        paymentMethod: "integration-test",
        paymentReference: `integration-ref-${suffix}`,
        idempotencyKey: `integration:${suffix}`,
      },
    });
    depositId = deposit.id;

    const adminHeaders = {
      "Content-Type": "application/json",
      Cookie: `willfantasy_session=${token}`,
      Origin: "http://localhost:5173",
    };
    const superAdminHeaders = {
      ...adminHeaders,
      Cookie: `willfantasy_session=${superAdminToken}`,
    };
    const agentHeaders = {
      ...adminHeaders,
      Cookie: `willfantasy_session=${agentToken}`,
    };
    const currentUserResponse = await fetch(`${apiUrl}/api/auth/me`, {
      headers: { Cookie: `willfantasy_session=${token}` },
    });
    assert.equal(currentUserResponse.status, 200);
    const currentUserData = await currentUserResponse.json() as {
      user?: { role?: string; isAdmin?: boolean };
    };
    assert.equal(currentUserData.user?.role, "ADMIN");
    assert.equal(currentUserData.user?.isAdmin, true, "admin session data should expose the admin role to the UI");

    const walletResponse = await fetch(`${apiUrl}/api/wallet`, {
      headers: { Cookie: `willfantasy_session=${token}` },
    });
    assert.equal(walletResponse.status, 200, "signed-in users should be able to open the wallet panel");

    const contestResponse = await fetch(`${apiUrl}/api/contests`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: `Integration contest ${suffix}`,
        matchId: match.id,
        type: "WINNER_TAKES_ALL",
        entryFee: 49,
        entryFeePaise: "4900",
        capacity: 10,
        commissionBps: 2000,
        prizePercentages: [100],
        sponsorContributionPaise: "0",
        targetPrizePoolPaise: "0",
        startsAt: startsAt.toISOString(),
        registrationDeadline: registrationDeadline.toISOString(),
        publish: false,
      }),
    });
    assert.equal(contestResponse.status, 201, "an administrator should be able to configure a draft contest");
    const createdContest = await contestResponse.json() as { id?: string };
    assert.ok(createdContest.id);
    contestId = createdContest.id;

    const contestsResponse = await fetch(`${apiUrl}/api/contests`, {
      headers: { Cookie: `willfantasy_session=${token}` },
    });
    assert.equal(contestsResponse.status, 200);
    const contestsBody = await contestsResponse.json() as Record<string, unknown>;
    assert.equal("demo" in contestsBody, false);
    assert.equal("demoCredits" in contestsBody, false);

    const dashboardResponse = await fetch(`${apiUrl}/api/admin/dashboard`, {
      headers: { Cookie: `willfantasy_session=${token}` },
    });
    assert.equal(dashboardResponse.status, 200, "an administrator should see database-backed operations reporting");
    const dashboard = await dashboardResponse.json() as {
      registrations?: { total?: number };
      providers?: { payments?: string; cricketData?: string };
    };
    assert.equal(dashboard.registrations?.total, await prisma.user.count());
    assert.deepEqual(dashboard.providers, { payments: "NOT_CONFIGURED", cricketData: "NOT_CONFIGURED" });

    const paymentResponse = await fetch(`${apiUrl}/api/deposits`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `willfantasy_session=${token}`, Origin: "http://localhost:5173" },
      body: JSON.stringify({ amountMinor: "4900", currency: "INR" }),
    });
    assert.equal(paymentResponse.status, 503, "unintegrated deposits must never create requests or credit a wallet");

    const matchListResponse = await fetch(`${apiUrl}/api/matches`);
    assert.equal(matchListResponse.status, 200);
    const publishedMatches = await matchListResponse.json() as { id: string }[];
    assert.equal(publishedMatches.some((candidate) => candidate.id === match.id), false, "unselected matches must remain hidden");

    const agentRouteResponse = await fetch(`${apiUrl}/api/agent/deposits`, {
      headers: { Cookie: `willfantasy_session=${token}` },
    });
    assert.equal(agentRouteResponse.status, 403, "administrators without an agent profile must not use agent endpoints");

    const assignmentResponse = await fetch(`${apiUrl}/api/admin/agents`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        userId: agent.id,
        transactionLimitMinor: "10000",
        permissions: ["review_deposits", "reject_deposits", "escalate_deposits"],
      }),
    });
    assert.equal(assignmentResponse.status, 201, "administrators should be able to assign a registered cash agent");

    const agentDepositsResponse = await fetch(`${apiUrl}/api/agent/deposits`, { headers: agentHeaders });
    assert.equal(agentDepositsResponse.status, 200);
    const agentDeposits = await agentDepositsResponse.json() as {
      approvalEnabled?: boolean;
      deposits?: { id: string }[];
    };
    assert.equal(agentDeposits.approvalEnabled, false, "cash agents must not be able to approve or credit deposits");
    assert.equal(agentDeposits.deposits?.some((item) => item.id === deposit.id), true);

    const claimResponse = await fetch(`${apiUrl}/api/agent/deposits/${deposit.id}/claim`, {
      method: "POST",
      headers: agentHeaders,
    });
    assert.equal(claimResponse.status, 200);
    assert.equal((await claimResponse.json() as { status?: string }).status, "UNDER_REVIEW");

    const escalateResponse = await fetch(`${apiUrl}/api/agent/deposits/${deposit.id}/escalate`, {
      method: "POST",
      headers: agentHeaders,
      body: JSON.stringify({ reason: "Integration test escalation" }),
    });
    assert.equal(escalateResponse.status, 200);
    assert.equal((await escalateResponse.json() as { status?: string }).status, "ESCALATED");

    const forbiddenRoleChange = await fetch(`${apiUrl}/api/admin/users/${depositor.id}/role`, {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({ role: "PAYOUT_OPERATOR" }),
    });
    assert.equal(forbiddenRoleChange.status, 403, "only super administrators may change privileged roles");

    const roleChangeResponse = await fetch(`${apiUrl}/api/admin/users/${depositor.id}/role`, {
      method: "PATCH",
      headers: superAdminHeaders,
      body: JSON.stringify({ role: "PAYOUT_OPERATOR" }),
    });
    assert.equal(roleChangeResponse.status, 200);
    assert.equal((await roleChangeResponse.json() as { role?: string }).role, "PAYOUT_OPERATOR");

    const auditResponse = await fetch(`${apiUrl}/api/admin/audit-events/verify`, {
      method: "POST",
      headers: superAdminHeaders,
    });
    assert.equal(auditResponse.status, 200);
    const auditResult = await auditResponse.json() as { valid?: boolean; checked?: number };
    assert.equal(auditResult.valid, true, "the audit hash chain should verify after agent and role operations");
    assert.ok((auditResult.checked ?? 0) >= 4);

    const agentAdminRouteResponse = await fetch(`${apiUrl}/api/admin/deposits`, {
      headers: agentHeaders,
    });
    assert.equal(agentAdminRouteResponse.status, 403, "cash agents must not access administrator deposit queues");

    const publishResponse = await fetch(`${apiUrl}/api/admin/matches/${match.id}`, {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({ isEnabled: true }),
    });
    assert.equal(publishResponse.status, 409, "provider-unready matches must not be published");

    const expenseResponse = await fetch(`${apiUrl}/api/admin/expenses`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        amountMinor: "100",
        currency: "INR",
        category: "test",
        idempotencyKey: `test:${suffix}`,
      }),
    });
    assert.equal(expenseResponse.status, 403, "only super administrators may record platform expenses");

    const csrfResponse = await fetch(`${apiUrl}/api/admin/contest-engine`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: `willfantasy_session=${token}` },
      body: JSON.stringify({ autoGenerationEnabled: false }),
    });
    assert.equal(csrfResponse.status, 403, "cookie-authenticated mutations require a trusted request origin");

    const removedRoutes = [
      { path: "/api/auth/demo", method: "POST" },
      { path: "/api/wallet/transactions", method: "GET" },
      { path: "/api/wallet/transactions", method: "POST" },
      { path: `/api/contests/${contestId}/join`, method: "POST" },
      { path: `/api/contests/${contestId}/leaderboard`, method: "GET" },
      { path: `/api/admin/contests/${contestId}/settle`, method: "POST" },
      { path: `/api/matches/${match.id}/demo-scorecard`, method: "GET" },
      { path: `/api/leaderboard/${match.id}`, method: "GET" },
    ];
    for (const route of removedRoutes) {
      const response = await fetch(`${apiUrl}${route.path}`, {
        method: route.method,
        headers: { Cookie: `willfantasy_session=${token}`, Origin: "http://localhost:5173" },
      });
      assert.equal(response.status, 404, `${route.method} ${route.path} should not be registered`);
    }
  } finally {
    if (contestId) {
      await prisma.contestFinancialEntry.deleteMany({ where: { contestId } });
      await prisma.contestPayout.deleteMany({ where: { contestId } });
      await prisma.contestEntry.deleteMany({ where: { contestId } });
      await prisma.contest.delete({ where: { id: contestId } });
    }
    if (depositId) await prisma.depositRequest.delete({ where: { id: depositId } });
    if (initialAuditChainState) {
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "AuditChainState" WHERE "id" = 1 FOR UPDATE`;
        await tx.auditEvent.deleteMany({
          where: { sequence: { gt: initialAuditChainState.lastSequence } },
        });
        await tx.auditChainState.update({
          where: { id: 1 },
          data: {
            lastSequence: initialAuditChainState.lastSequence,
            lastHash: initialAuditChainState.lastHash,
          },
        });
      });
    } else {
      await prisma.auditEvent.deleteMany();
      await prisma.auditChainState.deleteMany();
    }
    if (sessionId) await prisma.session.delete({ where: { id: sessionId } });
    if (superAdminSessionId) await prisma.session.delete({ where: { id: superAdminSessionId } });
    if (agentSessionId) await prisma.session.delete({ where: { id: agentSessionId } });
    if (agentUserId) await prisma.cashAgentProfile.deleteMany({ where: { userId: agentUserId } });
    if (userId) await prisma.user.delete({ where: { id: userId } });
    if (superAdminId) await prisma.user.delete({ where: { id: superAdminId } });
    if (agentUserId) await prisma.user.delete({ where: { id: agentUserId } });
    if (depositorId) await prisma.user.delete({ where: { id: depositorId } });
    if (matchId) await prisma.match.delete({ where: { id: matchId } });
    await prisma.$disconnect();
  }
});
