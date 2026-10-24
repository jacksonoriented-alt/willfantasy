import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { Prisma, PrismaClient } from "@prisma/client";
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import {
  calculateContestFinancials,
  calculateContestPayouts,
  getPayoutPositionCount,
  getPayoutPercentagesForEntryCount,
  validatePayoutPercentages,
} from "./contest-engine";
import { validatePlayerPoolReadiness, type PlayerReadinessRow } from "./cricketliveapi-players";
import {
  fetchCricketLiveApiMatches,
  importCricketLiveApiMatches,
} from "./cricketliveapi";
import { registerAdminFoundationRoutes } from "./admin-foundation";

dotenv.config();

const app = express();
const prisma = new PrismaClient();
const PORT = Number(process.env.PORT || 4000);
const SESSION_COOKIE = "willfantasy_session";
const SESSION_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_CONTEST_INTEGER = 2_147_483_647;
const CONTEST_ENGINE_INTERVAL_MS = 30_000;
const DEFAULT_COMMISSION_BPS = 2_000;
const CONTEST_TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 60_000 };
const SERIALIZABLE_CONTEST_TRANSACTION_OPTIONS = {
  ...CONTEST_TRANSACTION_OPTIONS,
  isolationLevel: "Serializable" as const,
};
const isProduction = process.env.NODE_ENV === "production";
const sessionCookieBaseOptions: {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax" | "none";
  path: string;
} = {
  httpOnly: true,
  secure: isProduction,
  sameSite: isProduction ? "none" : "lax",
  path: "/api",
};
const sessionCookieOptions: typeof sessionCookieBaseOptions & { maxAge: number } = {
  ...sessionCookieBaseOptions,
  maxAge: SESSION_LIFETIME_MS,
};

type AuthenticatedUser = {
  id: string;
  email: string;
  displayName: string;
  fantasyName: string;
  role: string;
};

declare global {
  namespace Express {
    interface Request {
      authenticatedUser?: AuthenticatedUser;
    }
  }
}

const allowedOrigins = new Set(
  (process.env.WEB_ORIGINS ?? process.env.WEB_ORIGIN ?? "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean),
);
const isLocalOrigin = (origin: string) =>
  /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
const adminEmails = new Set(
  (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean),
);
const superAdminEmails = new Set(
  (process.env.SUPER_ADMIN_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean),
);

function hasReadyPlayerPool(match: {
  status: string;
  playersSyncError: string | null;
  participants: { cricketTeamId: string; cricketTeam: { shortName: string } }[];
  players: (Omit<PlayerReadinessRow, "provider" | "externalPlayerId"> & {
    provider?: string | null;
    externalPlayerId?: string | null;
    player?: Pick<PlayerReadinessRow, "provider" | "externalPlayerId">;
  })[];
}) {
  return validatePlayerPoolReadiness(
    match.participants,
    match.players.map((player) => ({
      cricketTeamId: player.cricketTeamId,
      role: player.role,
      creditValue: player.creditValue,
      isInSquad: player.isInSquad,
      provider: player.player?.provider ?? player.provider ?? null,
      externalPlayerId: player.player?.externalPlayerId ?? player.externalPlayerId ?? null,
    })),
    match.status,
    match.playersSyncError ? [match.playersSyncError] : [],
  ).ready;
}

function effectiveRole(email: string, databaseRole: string) {
  const normalizedEmail = email.toLowerCase();
  if (superAdminEmails.has(normalizedEmail)) return "SUPER_ADMIN";
  if (adminEmails.has(normalizedEmail) && databaseRole === "USER") return "ADMIN";
  return databaseRole;
}

app.use(cors({
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  origin(origin, callback) {
    if (!origin) {
      callback(null, true);
      return;
    }

    const normalizedOrigin = origin.trim().replace(/\/+$/, "");
    const isAllowedOrigin = allowedOrigins.has(normalizedOrigin);
    const isAllowedLocalOrigin = isLocalOrigin(normalizedOrigin) && !allowedOrigins.size;

    if (isAllowedOrigin || isAllowedLocalOrigin) {
      callback(null, normalizedOrigin);
      return;
    }

    callback(null, false);
  },
}));
app.use(express.json());
app.use((req, res, next) => {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method) || !readSessionToken(req)) {
    next();
    return;
  }
  const origin = req.get("origin")?.trim().replace(/\/+$/, "");
  const referer = req.get("referer");
  let refererOrigin: string | undefined;
  if (referer) {
    try {
      refererOrigin = new URL(referer).origin;
    } catch {
      res.status(403).json({ error: "A valid request origin is required for this signed-in action." });
      return;
    }
  }
  const requestOrigin = origin || refererOrigin;
  const trusted = requestOrigin && (
    allowedOrigins.has(requestOrigin) ||
    (!allowedOrigins.size && !isProduction && isLocalOrigin(requestOrigin))
  );
  if (!trusted) {
    res.status(403).json({ error: "A trusted origin is required for this signed-in action." });
    return;
  }
  next();
});

function createRateLimiter(maxRequests: number, windowMs: number) {
  const attempts = new Map<string, { count: number; resetAt: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = req.ip || req.socket.remoteAddress || "unknown";
    const current = attempts.get(key);
    if (!current || current.resetAt <= now) {
      if (!current && attempts.size >= 10_000) {
        for (const [attemptKey, attempt] of attempts) {
          if (attempt.resetAt <= now) attempts.delete(attemptKey);
        }
        if (attempts.size >= 10_000) {
          res.status(503).json({ error: "Authentication is temporarily busy. Try again shortly." });
          return;
        }
      }
      attempts.set(key, { count: 1, resetAt: now + windowMs });
    } else if (current.count >= maxRequests) {
      res.setHeader("Retry-After", String(Math.ceil((current.resetAt - now) / 1000)));
      res.status(429).json({ error: "Too many attempts. Wait before trying again." });
      return;
    } else {
      current.count += 1;
    }
    next();
  };
}
const registrationRateLimit = createRateLimiter(5, 15 * 60_000);
const loginRateLimit = createRateLimiter(10, 15 * 60_000);

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function readSessionToken(req: Request) {
  const cookie = req.headers.cookie
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  return cookie?.slice(SESSION_COOKIE.length + 1);
}

function getStringParam(req: Request, name: string) {
  const value = req.params[name];
  return typeof value === "string" ? value : undefined;
}

function derivePasswordHash(password: string, salt: Buffer) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 64, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const hash = await derivePasswordHash(password, salt);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

async function verifyPassword(password: string, encodedHash: string) {
  const [algorithm, saltHex, hashHex] = encodedHash.split("$");
  if (algorithm !== "scrypt" || !saltHex || !hashHex) return false;

  const expectedHash = Buffer.from(hashHex, "hex");
  if (expectedHash.length !== 64) return false;
  const actualHash = await derivePasswordHash(password, Buffer.from(saltHex, "hex"));
  return timingSafeEqual(actualHash, expectedHash);
}

function publicUser(user: AuthenticatedUser) {
  const role = effectiveRole(user.email, user.role);
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    fantasyName: user.fantasyName,
    role,
    isAdmin: role === "ADMIN" || role === "SUPER_ADMIN",
    isCashAgent: role === "CASH_AGENT",
  };
}

async function establishSession(userId: string, res: Response) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS);
  await prisma.session.create({
    data: { tokenHash: hashToken(token), userId, expiresAt },
  });
  res.cookie(SESSION_COOKIE, token, sessionCookieOptions);
}

async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = readSessionToken(req);
  if (!token) {
    res.status(401).json({ error: "Please sign in to continue." });
    return;
  }

  try {
    const session = await prisma.session.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: true },
    });
    if (!session || session.expiresAt <= new Date()) {
      if (session) await prisma.session.delete({ where: { id: session.id } });
      res.clearCookie(SESSION_COOKIE, sessionCookieBaseOptions);
      res.status(401).json({ error: "Your session has expired. Please sign in again." });
      return;
    }
    if (session.user.accountStatus !== "ACTIVE") {
      res.status(403).json({ error: "This account is not active. Contact support for assistance." });
      return;
    }

    req.authenticatedUser = {
      id: session.user.id,
      email: session.user.email,
      displayName: session.user.displayName,
      fantasyName: session.user.fantasyName,
      role: effectiveRole(session.user.email, session.user.role),
    };
    next();
  } catch (error) {
    next(error);
  }
}

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const user = req.authenticatedUser;
  if (!user || !["ADMIN", "SUPER_ADMIN"].includes(user.role)) {
    res.status(403).json({ error: "Administrator access is required." });
    return;
  }
  next();
}

function requireSuperAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.authenticatedUser?.role !== "SUPER_ADMIN") {
    res.status(403).json({ error: "Super-administrator access is required." });
    return;
  }
  next();
}

registerAdminFoundationRoutes(app, prisma, {
  requireAuth,
  requireAdmin,
  requireSuperAdmin,
  effectiveRole: (user) => effectiveRole(user.email, user.role),
});

const registrationSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(12).max(128),
  fantasyName: z.string().trim().min(1).max(30),
});
const loginSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(128),
});

app.get("/api/auth/me", async (req, res) => {
  const token = readSessionToken(req);
  if (!token) {
    res.json({ user: null });
    return;
  }
  try {
    const session = await prisma.session.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: true },
    });
    if (!session || session.expiresAt <= new Date()) {
      if (session) await prisma.session.delete({ where: { id: session.id } });
      res.clearCookie(SESSION_COOKIE, sessionCookieBaseOptions);
      res.json({ user: null });
      return;
    }
    if (session.user.accountStatus !== "ACTIVE") {
      res.status(403).json({ error: "This account is not active. Contact support for assistance." });
      return;
    }
    res.json({ user: publicUser(session.user) });
  } catch (error) {
    console.error("Get session error:", error);
    res.status(500).json({ error: "Could not check your sign-in status." });
  }
});

const accountSettingsSchema = z.object({
  displayName: z.string().trim().min(1).max(50),
  currentPassword: z.string().min(1).max(128).optional(),
  newPassword: z.string().min(12).max(128).optional(),
}).refine(
  (settings) => Boolean(settings.currentPassword) === Boolean(settings.newPassword),
  { message: "Enter both your current password and a new password to change it." },
);

app.patch("/api/account/settings", requireAuth, async (req, res) => {
  const parsed = accountSettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Enter a display name and, when changing your password, both password fields." });
    return;
  }

  try {
    const userId = req.authenticatedUser!.id;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, displayName: true, passwordHash: true },
    });
    if (!user) {
      res.status(404).json({ error: "Account not found." });
      return;
    }

    const { displayName, currentPassword, newPassword } = parsed.data;
    if (
      currentPassword &&
      !(await verifyPassword(currentPassword, user.passwordHash))
    ) {
      res.status(400).json({ error: "Current password is incorrect." });
      return;
    }

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        displayName,
        ...(newPassword ? { passwordHash: await hashPassword(newPassword) } : {}),
      },
      select: { id: true, email: true, displayName: true, fantasyName: true, role: true },
    });
    res.json({ user: publicUser(updatedUser) });
  } catch (error) {
    console.error("Update account settings error:", error);
    res.status(500).json({ error: "Could not update account settings." });
  }
});

app.post("/api/auth/register", registrationRateLimit, async (req, res) => {
  const parsed = registrationSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Enter a valid email, a fantasy name up to 30 characters, and a password of at least 12 characters.",
    });
    return;
  }

  try {
    const { email, password, fantasyName } = parsed.data;
    const passwordHash = await hashPassword(password);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS);
    const user = await prisma.$transaction(async (tx) => {
      const createdUser = await tx.user.create({
        data: {
          email: email.toLowerCase(),
          passwordHash,
          displayName: fantasyName,
          fantasyName,
        },
        select: { id: true, email: true, displayName: true, fantasyName: true, role: true },
      });
      await tx.session.create({
        data: { tokenHash: hashToken(token), userId: createdUser.id, expiresAt },
      });
      return createdUser;
    });
    res.cookie(SESSION_COOKIE, token, sessionCookieOptions);
    res.status(201).json({ user: publicUser(user) });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "P2002"
    ) {
      res.status(409).json({ error: "An account with that email already exists." });
      return;
    }
    console.error("Register account error:", error);
    res.status(500).json({ error: "Could not create your account." });
  }
});

app.post("/api/auth/login", loginRateLimit, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Enter a valid email and password." });
    return;
  }

  try {
    const user = await prisma.user.findUnique({
      where: { email: parsed.data.email.toLowerCase() },
    });
    if (!user || !(await verifyPassword(parsed.data.password, user.passwordHash))) {
      res.status(401).json({ error: "Email or password is incorrect." });
      return;
    }
    if (user.accountStatus !== "ACTIVE") {
      res.status(403).json({ error: "This account is not active. Contact support for assistance." });
      return;
    }
    await establishSession(user.id, res);
    res.json({ user: publicUser(user) });
  } catch (error) {
    console.error("Sign in error:", error);
    res.status(500).json({ error: "Could not sign in." });
  }
});

app.post("/api/auth/logout", async (req, res) => {
  try {
    const token = readSessionToken(req);
    if (token) {
      await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
    }
    res.clearCookie(SESSION_COOKIE, sessionCookieOptions);
    res.json({ message: "Signed out." });
  } catch (error) {
    console.error("Sign out error:", error);
    res.status(500).json({ error: "Could not sign out." });
  }
});

app.get("/api/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, database: "connected" });
  } catch {
    res.status(500).json({ ok: false, database: "disconnected" });
  }
});

app.get("/api/matches", async (_req, res) => {
  try {
    const matches = await prisma.match.findMany({
      where: {
        isEnabled: true,
        isSuspended: false,
        archivedAt: null,
        dataStatus: "READY",
        status: { notIn: ["CANCELLED", "CANCELED", "ABANDONED", "POSTPONED"] },
      },
      orderBy: { startsAt: "asc" },
      include: {
        participants: {
          include: { cricketTeam: { select: { id: true, name: true, shortName: true } } },
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
      },
    });
    res.json(matches.filter((match) =>
      Boolean(match.provider) &&
      match.dataStatus === "READY" &&
      hasReadyPlayerPool(match)
    ).map(({ players: _players, ...match }) => match));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not load matches" });
  }
});

app.get("/api/matches/:matchId/players", async (req, res) => {
  try {
    const matchId = getStringParam(req, "matchId");
    if (!matchId) {
      res.status(400).json({ error: "A match ID is required." });
      return;
    }
    const match = await prisma.match.findUnique({
      where: { id: matchId },
      include: {
        participants: { include: { cricketTeam: { select: { shortName: true } } } },
        players: {
          where: { isInSquad: true },
          include: {
            player: {
              select: {
                id: true,
                name: true,
                shortName: true,
                role: true,
                providerRole: true,
                creditValue: true,
                provider: true,
                externalPlayerId: true,
                imageUrl: true,
                cricketTeamId: true,
              },
            },
            cricketTeam: true,
          },
          orderBy: [{ role: "asc" }, { player: { name: "asc" } }],
        },
      },
    });

    if (
      !match ||
      !match.isEnabled ||
      match.isSuspended ||
      match.archivedAt ||
      match.dataStatus !== "READY" ||
      !match.provider ||
      !hasReadyPlayerPool(match)
    ) {
      res.status(404).json({ error: "Match not found" });
      return;
    }

    res.json({
      playingXIConfirmed: match.playingXIConfirmed,
      players: match.players.map((entry) => ({
        ...entry.player,
        role: entry.role,
        creditValue: entry.creditValue,
        cricketTeam: entry.cricketTeam,
        isPlayingXI: entry.isPlayingXI,
        isCaptain: entry.isCaptain,
        isKeeper: entry.isKeeper,
      })),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not load players" });
  }
});

app.post("/api/fantasy-teams", requireAuth, async (req, res) => {
  try {
    const {
      matchId,
      playerIds,
      captainId,
      viceCaptainId,
    } = req.body ?? {};

    if (
      typeof matchId !== "string" ||
      !Array.isArray(playerIds) ||
      playerIds.length !== 11 ||
      !playerIds.every((id: unknown) => typeof id === "string") ||
      new Set(playerIds).size !== 11 ||
      typeof captainId !== "string" ||
      typeof viceCaptainId !== "string"
    ) {
      res.status(400).json({
        error: "Provide a match, 11 unique players, a captain, and a vice-captain.",
      });
      return;
    }
    if (
      !playerIds.includes(captainId) ||
      !playerIds.includes(viceCaptainId) ||
      captainId === viceCaptainId
    ) {
      res.status(400).json({
        error: "Captain and vice-captain must be different selected players.",
      });
      return;
    }

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
      res.status(404).json({ error: "Match not found" });
      return;
    }

    if (match.startsAt <= new Date()) {
      res.status(409).json({
        error: "Fantasy teams cannot be created after the match starts.",
        code: "MATCH_STARTED",
      });
      return;
    }
    if (
      !match.isEnabled ||
      match.isSuspended ||
      match.archivedAt ||
      match.dataStatus !== "READY" ||
      !match.provider ||
      !hasReadyPlayerPool(match)
    ) {
      res.status(409).json({ error: "Fantasy teams can only be created for a published, provider-ready match." });
      return;
    }

    const playerEntries = await prisma.matchPlayer.findMany({
      where: {
        matchId,
        playerId: { in: playerIds },
        isInSquad: true,
      },
      include: { player: true, cricketTeam: true },
    });
    const players = playerEntries.map((entry) => ({
      ...entry.player,
      role: entry.role,
      creditValue: entry.creditValue,
      cricketTeam: entry.cricketTeam,
    }));

    if (players.length !== 11) {
      res.status(400).json({ error: "One or more selected players do not exist." });
      return;
    }

    const credits = players.reduce((sum, player) => sum + player.creditValue, 0);
    if (credits > 100) {
      res.status(400).json({ error: `Credit limit exceeded: ${credits.toFixed(1)} / 100.` });
      return;
    }

    const roleLimits: Record<string, { min: number; max: number }> = {
      WICKETKEEPER: { min: 1, max: 4 },
      BATTER: { min: 3, max: 6 },
      ALL_ROUNDER: { min: 1, max: 4 },
      BOWLER: { min: 3, max: 6 },
    };

    const counts: Record<string, number> = {};
    const teamCounts: Record<string, number> = {};

    for (const player of players) {
      if (!roleLimits[player.role]) {
        res.status(400).json({ error: `Unsupported player role: ${player.role}` });
        return;
      }
      counts[player.role] = (counts[player.role] || 0) + 1;
      const teamName = player.cricketTeam.shortName;
      teamCounts[teamName] = (teamCounts[teamName] || 0) + 1;
    }

    for (const [role, limits] of Object.entries(roleLimits)) {
      const count = counts[role] || 0;
      if (count < limits.min || count > limits.max) {
        res.status(400).json({
          error: `${role} selection must be between ${limits.min} and ${limits.max}; selected ${count}.`,
        });
        return;
      }
    }

    if (Object.values(teamCounts).some((count) => count > 10)) {
      res.status(400).json({ error: "You cannot select more than 10 players from one real team." });
      return;
    }

    const user = req.authenticatedUser!;

    // A player may save at most 25 teams for each match.
    const MAX_TEAMS_PER_MATCH = 25;
    const requestedPlayers = [...playerIds].sort().join(",");
    const savedTeam = await prisma.$transaction(async (tx) => {
      const existingTeams = await tx.fantasyTeam.findMany({
        where: { userId: user.id, matchId },
        select: {
          teamNumber: true,
          captainId: true,
          viceCaptainId: true,
          selections: { select: { playerId: true } },
        },
        orderBy: { teamNumber: "asc" },
      });

      if (existingTeams.length >= MAX_TEAMS_PER_MATCH) {
        throw new Error("MAX_TEAMS_PER_MATCH");
      }

      const duplicate = existingTeams.some((team) => {
        const existingPlayers = team.selections
          .map((selection) => selection.playerId)
          .sort()
          .join(",");
        return (
          existingPlayers === requestedPlayers &&
          team.captainId === captainId &&
          team.viceCaptainId === viceCaptainId
        );
      });
      if (duplicate) throw new Error("DUPLICATE_TEAM");

      const usedNumbers = new Set(existingTeams.map((team) => team.teamNumber));
      let teamNumber = 1;
      while (usedNumbers.has(teamNumber) && teamNumber <= MAX_TEAMS_PER_MATCH) {
        teamNumber += 1;
      }

      return tx.fantasyTeam.create({
        data: {
          name: `Team ${teamNumber}`,
          teamNumber,
          userId: user.id,
          matchId,
          captainId,
          viceCaptainId,
          selections: {
            create: playerIds.map((playerId: string) => ({
              player: { connect: { id: playerId } },
            })),
          },
        },
        include: {
          match: true,
          selections: { include: { player: { include: { cricketTeam: true } } } },
        },
      });
    }, { isolationLevel: "Serializable", maxWait: 10000, timeout: 15000 });

    res.status(201).json({
      message: "Team saved successfully",
      team: savedTeam,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "MAX_TEAMS_PER_MATCH") {
      res.status(400).json({ error: "You have reached the maximum of 25 teams for this match." });
      return;
    }
    if (error instanceof Error && error.message === "DUPLICATE_TEAM") {
      res.status(409).json({
        error: "This team already exists. Change a player, captain, or vice-captain before saving.",
      });
      return;
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === "P2002" || error.code === "P2034")
    ) {
      res.status(409).json({ error: "Team list changed while saving. Please refresh your teams and try again." });
      return;
    }
    console.error("Save team error:", error);
    res.status(500).json({ error: "Could not save team. Check the API terminal logs." });
  }
});

// Lists only the signed-in user's teams.
app.get("/api/fantasy-teams", requireAuth, async (req, res) => {
  try {
    const user = req.authenticatedUser!;
    const teams = await prisma.fantasyTeam.findMany({
      where: { userId: user.id },
      orderBy: [{ matchId: "asc" }, { teamNumber: "asc" }],
      include: {
        match: true,
        selections: { include: { player: true } },
      },
    });
    res.json(teams);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not load saved teams" });
  }
});



// Update a saved team. Teams already entered in contests are locked.
app.put("/api/fantasy-teams/:teamId", requireAuth, async (req, res) => {
  try {
    const user = req.authenticatedUser!;
    const teamId = getStringParam(req, "teamId");
    if (!teamId) {
      res.status(400).json({ error: "A team ID is required." });
      return;
    }
    const { playerIds, captainId, viceCaptainId } = req.body ?? {};

    const team = await prisma.fantasyTeam.findFirst({
      where: { id: teamId, userId: user.id },
      include: {
        contestEntries: true,
        match: {
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
        },
      },
    });

    if (!team) {
      res.status(404).json({ error: "Team not found." });
      return;
    }

    if (team.match.startsAt <= new Date()) {
      res.status(409).json({
        error: "Fantasy teams cannot be edited after the match starts.",
        code: "MATCH_STARTED",
      });
      return;
    }
    if (team.contestEntries.length > 0) {
      res.status(409).json({
        error: "This team has entered a contest and can no longer be edited.",
      });
      return;
    }
    if (
      !team.match.isEnabled ||
      team.match.isSuspended ||
      team.match.archivedAt ||
      team.match.dataStatus !== "READY" ||
      !team.match.provider ||
      !hasReadyPlayerPool(team.match)
    ) {
      res.status(409).json({ error: "Teams can only be edited for a published, provider-ready match." });
      return;
    }
    if (
      !Array.isArray(playerIds) ||
      playerIds.length !== 11 ||
      !playerIds.every((id: unknown) => typeof id === "string") ||
      new Set(playerIds).size !== 11 ||
      typeof captainId !== "string" ||
      typeof viceCaptainId !== "string" ||
      !playerIds.includes(captainId) ||
      !playerIds.includes(viceCaptainId) ||
      captainId === viceCaptainId
    ) {
      res.status(400).json({
        error: "Choose 11 unique players and different captain and vice-captain.",
      });
      return;
    }

    const playerEntries = await prisma.matchPlayer.findMany({
      where: { matchId: team.matchId, playerId: { in: playerIds }, isInSquad: true },
      include: { player: true, cricketTeam: true },
    });
    const players = playerEntries.map((entry) => ({
      ...entry.player,
      role: entry.role,
      creditValue: entry.creditValue,
      cricketTeam: entry.cricketTeam,
    }));
    if (players.length !== 11) {
      res.status(400).json({ error: "One or more selected players do not exist." });
      return;
    }

    const credits = players.reduce((sum, p) => sum + p.creditValue, 0);
    if (credits > 100) {
      res.status(400).json({ error: `Credit limit exceeded: ${credits.toFixed(1)} / 100.` });
      return;
    }

    const limits: Record<string, { min: number; max: number }> = {
      WICKETKEEPER: { min: 1, max: 4 },
      BATTER: { min: 3, max: 6 },
      ALL_ROUNDER: { min: 1, max: 4 },
      BOWLER: { min: 3, max: 6 },
    };
    const counts: Record<string, number> = {};
    const realTeams: Record<string, number> = {};

    for (const p of players) {
      if (!limits[p.role]) {
        res.status(400).json({ error: `Unsupported player role: ${p.role}` });
        return;
      }
      counts[p.role] = (counts[p.role] || 0) + 1;
      realTeams[p.cricketTeam.shortName] =
        (realTeams[p.cricketTeam.shortName] || 0) + 1;
    }

    for (const [role, limit] of Object.entries(limits)) {
      const count = counts[role] || 0;
      if (count < limit.min || count > limit.max) {
        res.status(400).json({
          error: `${role} selection must be between ${limit.min} and ${limit.max}; selected ${count}.`,
        });
        return;
      }
    }
    if (Object.values(realTeams).some((count) => count > 10)) {
      res.status(400).json({ error: "You cannot select more than 10 players from one real team." });
      return;
    }

    const otherTeams = await prisma.fantasyTeam.findMany({
      where: { userId: user.id, matchId: team.matchId, id: { not: teamId } },
      select: {
        captainId: true,
        viceCaptainId: true,
        selections: { select: { playerId: true } },
      },
    });
    const requested = [...playerIds].sort().join(",");
    const duplicate = otherTeams.some((other) =>
      other.selections.map((selection) => selection.playerId).sort().join(",") === requested &&
      other.captainId === captainId &&
      other.viceCaptainId === viceCaptainId
    );
    if (duplicate) {
      res.status(409).json({
        error: "Another saved team already has these players, captain and vice-captain.",
      });
      return;
    }

    const updated = await prisma.fantasyTeam.update({
      where: { id: teamId },
      data: {
        captainId,
        viceCaptainId,
        selections: {
          deleteMany: {},
          create: playerIds.map((playerId: string) => ({
            player: { connect: { id: playerId } },
          })),
        },
      },
      include: {
        match: true,
        selections: { include: { player: { include: { cricketTeam: true } } } },
      },
    });

    res.json({ message: "Team updated successfully.", team: updated });
  } catch (error) {
    console.error("Update team error:", error);
    res.status(500).json({ error: "Could not update team." });
  }
});

// Teams are permanent once created; players can edit their lineups instead.
app.delete("/api/fantasy-teams/:teamId", requireAuth, async (req, res) => {
  res.status(405).json({ error: "Teams cannot be deleted. You can edit your team instead." });
});

const contestTypes = [
  "WINNER_TAKES_ALL", "TOP_3", "TOP_5", "TOP_10", "TOP_10_PERCENT",
  "TOP_20_PERCENT", "HEAD_TO_HEAD", "THREE_MAX", "SMALL_FIELD", "MULTI_POSITION",
] as const;

type ContestPayoutTier = { fromRank: number; toRank: number; prizeRupees: number };

function buildPrizeTiers(shares: number[], prizePoolPaise: bigint): ContestPayoutTier[] {
  const totalShare = shares.reduce((sum, share) => sum + share, 0);
  if (totalShare <= 0) return [];

  const normalizedPercentages = shares.map((share) => Math.floor(share * 100 / totalShare));
  const leftoverPercentages = 100 -
    normalizedPercentages.reduce((sum, percentage) => sum + percentage, 0);
  for (let index = 0; index < leftoverPercentages; index += 1) {
    const target = index % normalizedPercentages.length;
    normalizedPercentages[target] = (normalizedPercentages[target] ?? 0) + 1;
  }
  const payouts = calculateContestPayouts(
    shares.map((_, index) => ({
      entryId: `rank-${index + 1}`,
      joinedAt: new Date(index),
      score: shares.length - index,
    })),
    normalizedPercentages,
    prizePoolPaise,
  );
  const tiers: ContestPayoutTier[] = [];
  let tierStart = 1;
  let currentPrize = -1;
  for (const payout of payouts) {
    const amount = Number(payout.amountPaise / 100n);
    if (currentPrize !== -1 && amount !== currentPrize) {
      tiers.push({
        fromRank: tierStart,
        toRank: payout.rank - 1,
        prizeRupees: currentPrize,
      });
      tierStart = payout.rank;
    }
    currentPrize = amount;
  }
  if (currentPrize !== -1) {
    tiers.push({
      fromRank: tierStart,
      toRank: payouts.length,
      prizeRupees: currentPrize,
    });
  }
  return tiers;
}

function readPayoutPercentages(value: Prisma.JsonValue | null, type: string): number[] {
  if (validatePayoutPercentages(value)) return value;
  if (type === "WINNER_TAKES_ALL" || type === "HEAD_TO_HEAD") return [100];
  if (type === "TOP_3") return [50, 30, 20];
  if (type === "TOP_5") return [40, 25, 15, 10, 10];
  if (type === "TOP_10") return [25, 15, 10, 10, 8, 7, 6, 6, 6, 7];
  if (type === "TOP_20_PERCENT") return Array(20).fill(5) as number[];
  if (type === "TOP_10_PERCENT") return Array(10).fill(10) as number[];
  if (type === "THREE_MAX") return [50, 30, 20];
  return [50, 30, 20];
}

function exceedsPayoutPositionLimit(capacity: number, type: string) {
  return getPayoutPositionCount(capacity, type) > 100;
}

type FixedPrizeTemplate = "MEGA_JACKPOT" | "HALF_WIN" | "CLIMBER" | "CUSTOM";

function validateFixedPrizeTiers(
  value: unknown,
  capacity: number,
): value is ContestPayoutTier[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) return false;

  const tiers: ContestPayoutTier[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
    const tier = item as Record<string, unknown>;
    const { fromRank, toRank, prizeRupees } = tier;

    if (
      !Number.isSafeInteger(fromRank) ||
      !Number.isSafeInteger(toRank) ||
      !Number.isSafeInteger(prizeRupees) ||
      (fromRank as number) < 1 ||
      (toRank as number) < (fromRank as number) ||
      (toRank as number) > capacity ||
      (prizeRupees as number) < 1 ||
      (prizeRupees as number) > MAX_CONTEST_INTEGER
    ) {
      return false;
    }

    tiers.push({
      fromRank: fromRank as number,
      toRank: toRank as number,
      prizeRupees: prizeRupees as number,
    });
  }

  tiers.sort((a, b) => a.fromRank - b.fromRank);
  for (let index = 1; index < tiers.length; index += 1) {
    if (tiers[index]!.fromRank <= tiers[index - 1]!.toRank) return false;
  }
  return true;
}

function calculateFixedPrizeLiabilityPaise(tiers: ContestPayoutTier[]): bigint {
  return tiers.reduce(
    (total, tier) =>
      total + BigInt(tier.toRank - tier.fromRank + 1) * BigInt(tier.prizeRupees) * 100n,
    0n,
  );
}

function getFixedPrizeBreakdown(
  entryCount: number,
  tiers: ContestPayoutTier[],
): { prizeBreakdown: ContestPayoutTier[]; winnerCount: number } {
  const prizeBreakdown: ContestPayoutTier[] = [];
  let winnerCount = 0;

  for (const tier of tiers) {
    if (tier.fromRank > entryCount) continue;
    const toRank = Math.min(tier.toRank, entryCount);
    if (toRank < tier.fromRank) continue;
    prizeBreakdown.push({ ...tier, toRank });
    winnerCount += toRank - tier.fromRank + 1;
  }

  return { prizeBreakdown, winnerCount };
}

function getPrizeDistribution(
  entryCount: number,
  entryFee: number,
  type: string,
  commissionBps = DEFAULT_COMMISSION_BPS,
  sponsorContributionPaise = 0n,
  entryFeePaise?: bigint,
  payoutConfig?: Prisma.JsonValue | null,
  capacity = Number.MAX_SAFE_INTEGER,
  targetPrizePoolPaise = 0n,
  prizeMode = "PERCENTAGE",
  fixedPrizeTiersConfig?: Prisma.JsonValue | null,
) {
  const financials = calculateContestFinancials(
    entryCount,
    entryFeePaise ?? BigInt(entryFee) * 100n,
    commissionBps,
    sponsorContributionPaise,
  );
  const maximumFinancials = calculateContestFinancials(
    capacity,
    entryFeePaise ?? BigInt(entryFee) * 100n,
    commissionBps,
    sponsorContributionPaise,
  );

  if (prizeMode === "FIXED") {
    const rawTiers: unknown = fixedPrizeTiersConfig;
    if (!validateFixedPrizeTiers(rawTiers, capacity)) {
      return {
        prizePool: 0,
        winnerCount: 0,
        prizeBreakdown: [] as ContestPayoutTier[],
        maxPrizeBreakdown: [] as ContestPayoutTier[],
        grossEntryRevenuePaise: financials.grossEntryRevenuePaise.toString(),
        commissionPaise: financials.commissionPaise.toString(),
        distributablePrizePaise: "0",
        prizeLiabilityPaise: "0",
        commissionBps,
      };
    }

    const tiers = [...rawTiers].sort((a, b) => a.fromRank - b.fromRank);
    const maximumLiability = calculateFixedPrizeLiabilityPaise(tiers);

    // Scale current prizes to the funded pool, without changing maximum prizes.
    const currentPool = financials.distributablePrizePaise;
    const maximumPool = maximumFinancials.distributablePrizePaise;
    const poolNumerator =
      maximumPool > 0n && currentPool < maximumPool ? currentPool : maximumPool;
    const poolDenominator = maximumPool > 0n ? maximumPool : 1n;

    // Scale rank ranges proportionately to the number of joined entries.
    const joined = Math.max(0, Math.min(entryCount, capacity));
    const currentTiers: ContestPayoutTier[] = [];

    if (joined > 0 && capacity > 0 && poolNumerator > 0n) {
      for (const tier of tiers) {
        const fromRank = Math.floor((tier.fromRank - 1) * joined / capacity) + 1;
        const toRank = Math.floor(tier.toRank * joined / capacity);
        if (toRank < fromRank) continue;

        const prizeRupees = Number(
          BigInt(tier.prizeRupees) * poolNumerator / poolDenominator
        );
        if (prizeRupees <= 0) continue;

        const previous = currentTiers[currentTiers.length - 1];
        if (previous &&
            previous.toRank + 1 === fromRank &&
            previous.prizeRupees === prizeRupees) {
          previous.toRank = toRank;
        } else {
          currentTiers.push({ fromRank, toRank, prizeRupees });
        }
      }
    }

    const currentLiability = calculateFixedPrizeLiabilityPaise(currentTiers);

    return {
      prizePool: Number(currentLiability / 100n),
      winnerCount: currentTiers.reduce(
        (total, tier) => total + tier.toRank - tier.fromRank + 1, 0
      ),
      prizeBreakdown: currentTiers,
      maxPrizeBreakdown: tiers,
      grossEntryRevenuePaise: financials.grossEntryRevenuePaise.toString(),
      commissionPaise: financials.commissionPaise.toString(),
      distributablePrizePaise: currentPool.toString(),
      prizeLiabilityPaise: currentLiability.toString(),
      maxPrizeLiabilityPaise: maximumLiability.toString(),
      commissionBps,
    };
  }

  const configuredPercentages = readPayoutPercentages(payoutConfig ?? null, type);
  const shares = getPayoutPercentagesForEntryCount(entryCount, type, configuredPercentages);
  const winnersCount = shares.length;
  const actualPrizePoolPaise = targetPrizePoolPaise > 0n && entryCount >= capacity
    ? targetPrizePoolPaise
    : financials.distributablePrizePaise;
  const prizePool = Number(actualPrizePoolPaise / 100n);
  const prizeBreakdown = buildPrizeTiers(shares, actualPrizePoolPaise);
  const maximumShares = getPayoutPercentagesForEntryCount(capacity, type, configuredPercentages);
  const maximumPrizePoolPaise = targetPrizePoolPaise > 0n
    ? targetPrizePoolPaise
    : maximumFinancials.distributablePrizePaise;
  const maxPrizeBreakdown = buildPrizeTiers(maximumShares, maximumPrizePoolPaise);

  return {
    prizePool,
    winnerCount: winnersCount,
    prizeBreakdown,
    maxPrizeBreakdown,
    grossEntryRevenuePaise: financials.grossEntryRevenuePaise.toString(),
    commissionPaise: financials.commissionPaise.toString(),
    distributablePrizePaise: actualPrizePoolPaise.toString(),
    commissionBps,
  };
}

function isRecord(value: Prisma.JsonValue): value is Prisma.JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getEligibleMatchStatuses(value: Prisma.JsonValue) {
  if (!isRecord(value)) return ["UPCOMING"];
  const statuses = value.matchStatuses;
  if (!Array.isArray(statuses) || !statuses.every((status) => typeof status === "string")) {
    return ["UPCOMING"];
  }
  return statuses.map((status) => status.trim().toUpperCase());
}

function makeGeneratedContestData(
  template: Prisma.ContestTemplateGetPayload<object>,
  match: { id: string; title: string; startsAt: Date },
  instanceNumber: number,
) {
  if (!validatePayoutPercentages(template.payoutPercentages)) {
    throw new Error(`Contest template ${template.code} has invalid payout percentages.`);
  }
  const registrationDeadline = new Date(
    match.startsAt.getTime() - template.registrationLeadMinutes * 60_000,
  );
  return {
    id: randomBytes(16).toString("hex"),
    name: `${template.name} · ${match.title} · #${instanceNumber}`,
    matchId: match.id,
    type: template.contestFormat,
    entryFee: Number(template.entryFeePaise / 100n),
    capacity: template.capacity,
    status: "OPEN",
    sourceType: "REGULAR",
    templateId: template.id,
    instanceNumber,
    entryFeePaise: template.entryFeePaise,
    commissionBps: template.commissionBps,
    prizePercentages: template.payoutPercentages as Prisma.InputJsonValue,
    startsAt: match.startsAt,
    registrationDeadline,
    publishedAt: new Date(),
  };
}

async function insertGeneratedContest(
  tx: Prisma.TransactionClient,
  template: Prisma.ContestTemplateGetPayload<object>,
  match: { id: string; title: string; startsAt: Date },
  instanceNumber: number,
) {
  await tx.$queryRaw`SELECT "id" FROM "ContestEngineSetting" WHERE "id" = 1 FOR SHARE`;
  const setting = await tx.contestEngineSetting.findUnique({ where: { id: 1 } });
  if (!setting?.autoGenerationEnabled || !template.enabled) return false;
  const created = await tx.contest.createMany({
    data: [makeGeneratedContestData(template, match, instanceNumber)],
    skipDuplicates: true,
  });
  return created.count === 1;
}

async function cancelContestAndRefund(
  tx: Prisma.TransactionClient,
  contestId: string,
  allowStartedMatchCancellation = false,
) {
  await tx.$queryRaw`SELECT "id" FROM "Contest" WHERE "id" = ${contestId} FOR UPDATE`;
  const contest = await tx.contest.findUnique({
    where: { id: contestId },
    include: { entries: true },
  });
  if (!contest) throw new Error("CONTEST_NOT_FOUND");
  if (contest.status === "CANCELLED") return contest;
  if (
    contest.settledAt ||
    (!allowStartedMatchCancellation && ["LIVE", "COMPLETED", "SETTLED"].includes(contest.status))
  ) {
    throw new Error("CONTEST_ALREADY_STARTED");
  }

  for (const entry of contest.entries) {
    const commissionPaise = contest.entryFeePaise * BigInt(contest.commissionBps) / 10_000n;
    await tx.contestFinancialEntry.createMany({
      data: [
        {
          contestId,
          type: "ENTRY_REFUND",
          amountPaise: contest.entryFeePaise,
          idempotencyKey: `refund:${contestId}:${entry.id}`,
        },
        {
          contestId,
          type: "COMMISSION_REVERSAL",
          amountPaise: commissionPaise,
          idempotencyKey: `refund:${contestId}:${entry.id}:commission`,
        },
        {
          contestId,
          type: "PRIZE_CONTRIBUTION_REVERSAL",
          amountPaise: contest.entryFeePaise - commissionPaise,
          idempotencyKey: `refund:${contestId}:${entry.id}:prize`,
        },
      ],
    });
  }
  if (contest.sponsorContributionPaise > 0n) {
    await tx.contestFinancialEntry.create({
      data: {
        contestId,
        type: "SPONSOR_REVERSAL",
        amountPaise: contest.sponsorContributionPaise,
        idempotencyKey: `refund:${contestId}:sponsor`,
      },
    });
  }
  return tx.contest.update({
    where: { id: contestId },
    data: { status: "CANCELLED" },
  });
}

let contestGenerationRunning = false;

async function runContestGenerationCycle() {
  if (contestGenerationRunning) return;
  contestGenerationRunning = true;
  let run: Awaited<ReturnType<typeof prisma.contestGenerationRun.create>> | null = null;
  try {
    run = await prisma.contestGenerationRun.create({ data: {} });
    const setting = await prisma.contestEngineSetting.findUnique({ where: { id: 1 } });
    if (!setting?.autoGenerationEnabled) {
      await prisma.contestGenerationRun.update({
        where: { id: run.id },
        data: { status: "PAUSED", completedAt: new Date() },
      });
      return;
    }

    const now = new Date();
    const contestsToAdvance = await prisma.contest.findMany({
      where: { status: { in: ["OPEN", "FULL", "CLOSED", "LIVE"] } },
      include: { match: true, template: true, _count: { select: { entries: true } } },
    });
    for (const contest of contestsToAdvance) {
      const matchStatus = contest.match.status.trim().toUpperCase();
      const matchCancelled = ["CANCELLED", "CANCELED"].includes(matchStatus);
      const registrationClosed =
        (contest.registrationDeadline !== null && contest.registrationDeadline <= now) ||
        contest.match.startsAt <= now ||
        ["LIVE", "IN_PROGRESS", "IN PROGRESS", "COMPLETED", "COMPLETE", "FINISHED"].includes(matchStatus);
      const belowMinimum =
        contest.sourceType === "REGULAR" &&
        contest.template !== null &&
        contest._count.entries < contest.template.minimumEntriesToOpen &&
        registrationClosed;
      const nextStatus = ["CANCELLED", "CANCELED"].includes(matchStatus)
        ? "CANCELLED"
        : ["COMPLETED", "COMPLETE", "FINISHED"].includes(matchStatus)
          ? "COMPLETED"
          : contest.match.startsAt <= now || ["LIVE", "IN_PROGRESS", "IN PROGRESS"].includes(matchStatus)
            ? "LIVE"
            : contest._count.entries >= contest.capacity
              ? "FULL"
              : contest.registrationDeadline && contest.registrationDeadline <= now
                ? "CLOSED"
                : contest.status;
      if (nextStatus === "CANCELLED" || belowMinimum) {
        if (contest.status !== "CANCELLED") {
          await prisma.$transaction(
            (tx) => cancelContestAndRefund(tx, contest.id, matchCancelled),
            CONTEST_TRANSACTION_OPTIONS,
          );
        }
      } else if (nextStatus !== contest.status) {
        await prisma.contest.update({ where: { id: contest.id }, data: { status: nextStatus } });
      }
    }

    const templates = await prisma.contestTemplate.findMany({ where: { enabled: true } });
    const [matches, refreshedContests] = await Promise.all([
      prisma.match.findMany({
        where: {
          isEnabled: true,
          isSuspended: false,
          archivedAt: null,
          dataStatus: "READY",
          provider: { not: null },
          status: { notIn: ["CANCELLED", "CANCELED", "ABANDONED", "POSTPONED"] },
        },
        orderBy: { startsAt: "asc" },
      }),
      prisma.contest.findMany({
        where: { templateId: { not: null }, instanceNumber: { not: null } },
        orderBy: [
          { templateId: "asc" },
          { matchId: "asc" },
          { instanceNumber: "desc" },
        ],
        select: { templateId: true, matchId: true, instanceNumber: true, status: true },
      }),
    ]);
    let scanned = 0;
    let createdCount = 0;

    for (const template of templates) {
      const allowedStatuses = getEligibleMatchStatuses(template.matchEligibility);
      for (const match of matches) {
        scanned += 1;
        const status = match.status.trim().toUpperCase();
        const millisUntilStart = match.startsAt.getTime() - now.getTime();
        const insideWindow =
          millisUntilStart <= template.openWindowMinutes * 60_000 &&
          millisUntilStart > template.registrationLeadMinutes * 60_000;
        if (!allowedStatuses.includes(status) || !insideWindow) continue;

        const latest = refreshedContests.find(
          (contest) => contest.templateId === template.id && contest.matchId === match.id,
        );
        if (latest && latest.status !== "FULL") continue;
        const instanceNumber = (latest?.instanceNumber ?? 0) + 1;
        const wasCreated = await prisma.$transaction(
          (tx) => insertGeneratedContest(tx, template, match, instanceNumber),
          CONTEST_TRANSACTION_OPTIONS,
        );
        if (wasCreated) createdCount += 1;
      }
    }

    await prisma.contestGenerationRun.update({
      where: { id: run.id },
      data: { status: "COMPLETED", completedAt: new Date(), scanned, created: createdCount },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 2000) : "Unknown generation error.";
    console.error("Contest generation cycle failed:", error);
    if (run) {
      await prisma.contestGenerationRun.update({
        where: { id: run.id },
        data: { status: "FAILED", completedAt: new Date(), error: message },
      });
    }
  } finally {
    contestGenerationRunning = false;
  }
}

app.get("/api/contests", requireAuth, async (req, res) => {
  try {
    const user = req.authenticatedUser!;
    const matchId = typeof req.query.matchId === "string"
      ? req.query.matchId : undefined;

    const contests = await prisma.contest.findMany({
      where: {
        ...(matchId ? { matchId } : {}),
        status: { not: "DRAFT" },
        match: {
          isEnabled: true,
          isSuspended: false,
          archivedAt: null,
          dataStatus: "READY",
          provider: { not: null },
          status: { notIn: ["CANCELLED", "CANCELED", "ABANDONED", "POSTPONED"] },
        },
      },
      include: {
        match: true,
        _count: { select: { entries: true } },
        entries: {
          where: { userId: user.id },
          select: { id: true, fantasyTeamId: true },
        },
      },
      orderBy: [{ createdAt: "desc" }],
    });

    res.json({
      contests: contests.map(({ entries, _count, ...contest }) => ({
        ...contest,
        entryFeePaise: contest.entryFeePaise.toString(),
        sponsorContributionPaise: contest.sponsorContributionPaise.toString(),
        prizePoolPaise: contest.prizePoolPaise.toString(),
        targetPrizePoolPaise: contest.targetPrizePoolPaise.toString(),
        startsAt: contest.startsAt ?? contest.match.startsAt,
        ...getPrizeDistribution(
          _count.entries,
          contest.entryFee,
          contest.type,
          contest.commissionBps,
          contest.sponsorContributionPaise,
          contest.entryFeePaise,
          contest.prizePercentages,
          contest.capacity,
          contest.targetPrizePoolPaise,
          contest.prizeMode,
          contest.fixedPrizeTiers,
        ),
        entryCount: _count.entries,
        joined: entries.length > 0,
        userEntryCount: entries.length,
        myEntry: entries[0] ?? null,
      })),
    });
  } catch (error) {
    console.error("List contests error:", error);
    res.status(500).json({ error: "Could not load contests." });
  }
});

app.get("/api/admin/contest-engine", requireAuth, requireAdmin, async (_req, res) => {
  try {
    const [setting, templates, contests, runs] = await Promise.all([
      prisma.contestEngineSetting.findUnique({ where: { id: 1 } }),
      prisma.contestTemplate.findMany({ orderBy: { entryFeePaise: "asc" } }),
      prisma.contest.findMany({
        include: { match: true, _count: { select: { entries: true } }, financialEntries: true },
        orderBy: { createdAt: "desc" },
        take: 100,
      }),
      prisma.contestGenerationRun.findMany({ orderBy: { startedAt: "desc" }, take: 25 }),
    ]);
    res.json({
      autoGenerationEnabled: setting?.autoGenerationEnabled ?? false,
      templates: templates.map((template) => ({
        ...template,
        entryFeePaise: template.entryFeePaise.toString(),
      })),
      contests: contests.map((contest) => {
        const distribution = getPrizeDistribution(
          contest._count.entries,
          contest.entryFee,
          contest.type,
          contest.commissionBps,
          contest.sponsorContributionPaise,
          contest.entryFeePaise,
          contest.prizePercentages,
          contest.capacity,
          contest.targetPrizePoolPaise,
          contest.prizeMode,
          contest.fixedPrizeTiers,
        );
        return {
          id: contest.id,
          name: contest.name,
          match: contest.match,
          status: contest.status,
          instanceNumber: contest.instanceNumber,
          entryCount: contest._count.entries,
          capacity: contest.capacity,
          prizeMode: contest.prizeMode,
          prizeTemplate: contest.prizeTemplate,
          fixedPrizeTiers: contest.fixedPrizeTiers,
          prizePoolPaise: distribution.distributablePrizePaise,
          sponsorContributionPaise: contest.financialEntries
            .reduce((sum, entry) => sum + (
              ["SPONSOR_CONTRIBUTION", "SPONSOR_ADJUSTMENT"].includes(entry.type)
                ? entry.amountPaise
                : entry.type === "SPONSOR_REVERSAL" ? -entry.amountPaise : 0n
            ), 0n).toString(),
          grossRevenuePaise: contest.financialEntries
            .reduce((sum, entry) => sum + (entry.type === "ENTRY_GROSS"
              ? entry.amountPaise
              : entry.type === "ENTRY_REFUND" ? -entry.amountPaise : 0n), 0n).toString(),
          commissionPaise: contest.financialEntries
            .reduce((sum, entry) => sum + (entry.type === "PLATFORM_COMMISSION"
              ? entry.amountPaise
              : entry.type === "COMMISSION_REVERSAL" ? -entry.amountPaise : 0n), 0n).toString(),
          prizeLiabilityPaise: contest.financialEntries
            .reduce((sum, entry) => sum + (
              ["PRIZE_CONTRIBUTION", "SPONSOR_CONTRIBUTION", "SPONSOR_ADJUSTMENT"].includes(entry.type)
                ? entry.amountPaise
                : ["PRIZE_CONTRIBUTION_REVERSAL", "SPONSOR_REVERSAL", "PAYOUT"].includes(entry.type)
                  ? -entry.amountPaise
                  : 0n
            ), 0n).toString(),
          payoutStatus: contest.settledAt ? "SETTLED" : "UNSETTLED",
        };
      }),
      generationRuns: runs,
    });
  } catch (error) {
    console.error("Admin contest engine status error:", error);
    res.status(500).json({ error: "Could not load contest engine status." });
  }
});

app.patch("/api/admin/contest-engine", requireAuth, requireAdmin, async (req, res) => {
  if (typeof req.body?.autoGenerationEnabled !== "boolean") {
    res.status(400).json({ error: "autoGenerationEnabled must be a boolean." });
    return;
  }
  try {
    const setting = await prisma.contestEngineSetting.upsert({
      where: { id: 1 },
      create: { id: 1, autoGenerationEnabled: req.body.autoGenerationEnabled },
      update: { autoGenerationEnabled: req.body.autoGenerationEnabled },
    });
    res.json({ autoGenerationEnabled: setting.autoGenerationEnabled });
  } catch (error) {
    console.error("Update contest engine settings error:", error);
    res.status(500).json({ error: "Could not update contest engine settings." });
  }
});

const contestTemplateInputSchema = z.object({
  code: z.string().trim().min(2).max(50).regex(/^[A-Z0-9_]+$/),
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean(),
  entryFeePaise: z.string().regex(/^\d+$/),
  capacity: z.number().int().min(2).max(MAX_CONTEST_INTEGER),
  contestFormat: z.enum(contestTypes),
  commissionBps: z.number().int().min(0).max(10_000),
  payoutPercentages: z.array(z.number().int().min(0).max(100)).min(1).max(100),
  minimumEntriesToOpen: z.number().int().min(1).max(MAX_CONTEST_INTEGER),
  registrationLeadMinutes: z.number().int().min(1).max(10_080),
  openWindowMinutes: z.number().int().min(1).max(525_600),
  matchEligibility: z.object({
    matchStatuses: z.array(z.enum(["UPCOMING", "LIVE", "IN_PROGRESS", "COMPLETED", "FINISHED"])).min(1),
  }).strict(),
}).refine((value) => validatePayoutPercentages(value.payoutPercentages), {
  message: "Prize payout percentages must add up to exactly 100.",
  path: ["payoutPercentages"],
}).refine((value) => value.minimumEntriesToOpen <= value.capacity, {
  message: "Minimum entries cannot exceed contest capacity.",
  path: ["minimumEntriesToOpen"],
}).refine((value) => !exceedsPayoutPositionLimit(value.capacity, value.contestFormat), {
  message: "Top-percentage formats support a maximum of 100 payout positions; reduce capacity or choose another format.",
  path: ["capacity"],
});

function contestTemplateData(value: z.infer<typeof contestTemplateInputSchema>) {
  const entryFeePaise = BigInt(value.entryFeePaise);
  if (entryFeePaise > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Entry fee exceeds the supported exact paise range.");
  }
  if (BigInt(value.capacity) * entryFeePaise > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Maximum contest revenue exceeds the supported exact paise range.");
  }
  return {
    ...value,
    entryFeePaise,
    matchEligibility: value.matchEligibility as Prisma.InputJsonObject,
    payoutPercentages: value.payoutPercentages as Prisma.InputJsonArray,
  };
}

app.post("/api/admin/contest-templates", requireAuth, requireAdmin, async (req, res) => {
  const parsed = contestTemplateInputSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid template settings. Check fees, capacity, eligibility, and payout percentages." });
    return;
  }
  try {
    const template = await prisma.contestTemplate.create({ data: contestTemplateData(parsed.data) });
    res.status(201).json({ ...template, entryFeePaise: template.entryFeePaise.toString() });
  } catch (error) {
    if (error instanceof Error && error.message.includes("supported")) {
      res.status(400).json({ error: error.message });
      return;
    }
    console.error("Create contest template error:", error);
    res.status(500).json({ error: "Could not create contest template." });
  }
});

app.put("/api/admin/contest-templates/:templateId", requireAuth, requireAdmin, async (req, res) => {
  const parsed = contestTemplateInputSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid template settings. Check fees, capacity, eligibility, and payout percentages." });
    return;
  }
  const templateId = getStringParam(req, "templateId");
  if (!templateId) {
    res.status(400).json({ error: "A template ID is required." });
    return;
  }
  try {
    const template = await prisma.contestTemplate.update({
      where: { id: templateId },
      data: contestTemplateData(parsed.data),
    });
    res.json({ ...template, entryFeePaise: template.entryFeePaise.toString() });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      res.status(404).json({ error: "Contest template not found." });
      return;
    }
    if (error instanceof Error && error.message.includes("supported")) {
      res.status(400).json({ error: error.message });
      return;
    }
    console.error("Update contest template error:", error);
    res.status(500).json({ error: "Could not update contest template." });
  }
});

app.post("/api/admin/contest-engine/run", requireAuth, requireAdmin, async (_req, res) => {
  await runContestGenerationCycle();
  res.status(202).json({ message: "Contest generation cycle completed or is already running." });
});

const megaContestEditSchema = z.object({
  name: z.string().trim().min(1).max(80),
  matchId: z.string().min(1),
  type: z.enum(contestTypes),
  entryFee: z.number().int().min(0).max(MAX_CONTEST_INTEGER),
  entryFeePaise: z.string().regex(/^\d+$/),
  capacity: z.number().int().min(2).max(MAX_CONTEST_INTEGER),
  commissionBps: z.number().int().min(0).max(10_000),
  prizeMode: z.enum(["PERCENTAGE", "FIXED"]).default("PERCENTAGE"),
  prizeTemplate: z.enum(["MEGA_JACKPOT", "HALF_WIN", "CLIMBER", "CUSTOM"]).nullable().optional(),
  fixedPrizeTiers: z.unknown().optional(),
  prizePercentages: z.array(z.number().int().min(0).max(100)).min(1).max(100),
  sponsorContributionPaise: z.string().regex(/^\d+$/),
  targetPrizePoolPaise: z.string().regex(/^\d+$/),
  startsAt: z.string().datetime(),
  registrationDeadline: z.string().datetime(),
}).refine(
  (value) => value.prizeMode === "FIXED" || validatePayoutPercentages(value.prizePercentages),
  {
    message: "Prize payout percentages must add up to exactly 100 in percentage mode.",
    path: ["prizePercentages"],
  },
).refine(
  (value) => value.prizeMode !== "FIXED" ||
    (Boolean(value.prizeTemplate) && validateFixedPrizeTiers(value.fixedPrizeTiers, value.capacity)),
  {
    message: "Fixed mode requires a valid template and non-overlapping prize tiers within capacity.",
    path: ["fixedPrizeTiers"],
  },
).refine((value) => !exceedsPayoutPositionLimit(value.capacity, value.type), {
  message: "Top-percentage formats support a maximum of 100 payout positions; reduce capacity or choose another format.",
  path: ["capacity"],
});

app.put("/api/admin/contests/:contestId", requireAuth, requireAdmin, async (req, res) => {
  const contestId = getStringParam(req, "contestId");
  const parsed = megaContestEditSchema.safeParse(req.body);
  if (!contestId || !parsed.success) {
    res.status(400).json({ error: "Invalid Mega Contest details." });
    return;
  }
  const input = parsed.data;
  const entryFeePaise = BigInt(input.entryFeePaise);
  const sponsorContributionPaise = BigInt(input.sponsorContributionPaise);
  const targetPrizePoolPaise = BigInt(input.targetPrizePoolPaise);
  const fixedTiers = input.fixedPrizeTiers as ContestPayoutTier[] | undefined;
  if (input.prizeMode === "FIXED") {
    if (!fixedTiers || !validateFixedPrizeTiers(fixedTiers, input.capacity)) {
      res.status(400).json({ error: "Fixed prize tiers are invalid or overlap." });
      return;
    }
    const liability = calculateFixedPrizeLiabilityPaise(fixedTiers);
    if (liability > BigInt(Number.MAX_SAFE_INTEGER)) {
      res.status(400).json({ error: "Fixed prize liability exceeds the supported exact paise range." });
      return;
    }
    const funding = calculateContestFinancials(
      input.capacity, entryFeePaise, input.commissionBps, sponsorContributionPaise,
    ).distributablePrizePaise;
    if (liability > funding) {
      res.status(400).json({ error: "Fixed prizes exceed available funding at full capacity. Increase sponsor funding or reduce prizes." });
      return;
    }
  }
  if (BigInt(input.capacity) * entryFeePaise > BigInt(Number.MAX_SAFE_INTEGER)) {
    res.status(400).json({ error: "Maximum contest revenue exceeds the supported exact paise range." });
    return;
  }
  const registrationDeadline = new Date(input.registrationDeadline);
  if (registrationDeadline <= new Date()) {
    res.status(400).json({ error: "Registration deadline must be in the future." });
    return;
  }
  const maximumNet = calculateContestFinancials(
    input.capacity,
    entryFeePaise,
    input.commissionBps,
    sponsorContributionPaise,
  ).distributablePrizePaise;
  if (targetPrizePoolPaise > maximumNet) {
    res.status(400).json({ error: "The target prize exceeds net entry revenue and sponsor funding at capacity." });
    return;
  }
  try {
    const updated = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Contest" WHERE "id" = ${contestId} FOR UPDATE`;
      const previous = await tx.contest.findUnique({
        where: { id: contestId },
        include: { _count: { select: { entries: true } } },
      });
      if (!previous) throw new Error("CONTEST_NOT_FOUND");
      if (previous.sourceType !== "MEGA") throw new Error("NOT_A_MEGA_CONTEST");
      if (previous._count.entries > 0) throw new Error("CONTEST_HAS_ENTRIES");
      if (previous.settledAt || ["LIVE", "COMPLETED", "SETTLED", "CANCELLED"].includes(previous.status)) {
        throw new Error("CONTEST_NOT_EDITABLE");
      }
      const match = await tx.match.findUnique({ where: { id: input.matchId } });
      if (!match) throw new Error("MATCH_NOT_FOUND");
      if (match.startsAt <= new Date() || registrationDeadline >= match.startsAt) {
        throw new Error("INVALID_MATCH_START");
      }
      const startsAt = match.startsAt;
      const sponsorDelta = sponsorContributionPaise - previous.sponsorContributionPaise;
      if (sponsorDelta !== 0n) {
        await tx.contestFinancialEntry.create({
          data: {
            contestId,
            type: "SPONSOR_ADJUSTMENT",
            amountPaise: sponsorDelta,
            idempotencyKey: `sponsor-edit:${contestId}:${Date.now()}`,
          },
        });
      }
      return tx.contest.update({
        where: { id: contestId },
        data: {
          name: input.name,
          matchId: input.matchId,
          type: input.type,
          entryFee: input.entryFee,
          entryFeePaise,
          capacity: input.capacity,
          commissionBps: input.commissionBps,
          prizePercentages: input.prizePercentages as Prisma.InputJsonArray,
          prizeMode: input.prizeMode,
          prizeTemplate: input.prizeMode === "FIXED" ? input.prizeTemplate! : null,
          fixedPrizeTiers: input.prizeMode === "FIXED"
            ? fixedTiers as Prisma.InputJsonArray
            : Prisma.DbNull,
          sponsorContributionPaise,
          targetPrizePoolPaise,
          startsAt,
          registrationDeadline,
        },
      });
    }, SERIALIZABLE_CONTEST_TRANSACTION_OPTIONS);
    res.json({
      id: updated.id,
      status: updated.status,
      entryFeePaise: updated.entryFeePaise.toString(),
      sponsorContributionPaise: updated.sponsorContributionPaise.toString(),
      targetPrizePoolPaise: updated.targetPrizePoolPaise.toString(),
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    const known: Record<string, { status: number; message: string }> = {
      CONTEST_NOT_FOUND: { status: 404, message: "Contest not found." },
      NOT_A_MEGA_CONTEST: { status: 400, message: "Only Mega Contests can be edited here." },
      CONTEST_HAS_ENTRIES: { status: 409, message: "A contest cannot be edited after the first entry." },
      CONTEST_NOT_EDITABLE: { status: 409, message: "This Mega Contest can no longer be edited." },
      MATCH_NOT_FOUND: { status: 404, message: "Match not found." },
      INVALID_MATCH_START: { status: 400, message: "The selected match must be in the future and registration must close before its start." },
    };
    if (known[code]) {
      res.status(known[code].status).json({ error: known[code].message });
      return;
    }
    console.error("Edit Mega Contest error:", error);
    res.status(500).json({ error: "Could not edit Mega Contest." });
  }
});

app.patch("/api/admin/contests/:contestId", requireAuth, requireAdmin, async (req, res) => {
  const contestId = getStringParam(req, "contestId");
  const requestedStatus = req.body?.status;
  if (!contestId || !["OPEN", "CLOSED", "CANCELLED"].includes(requestedStatus)) {
    res.status(400).json({ error: "Choose OPEN, CLOSED, or CANCELLED." });
    return;
  }
  try {
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Contest" WHERE "id" = ${contestId} FOR UPDATE`;
      const contest = await tx.contest.findUnique({
        where: { id: contestId },
        include: { entries: true, match: true },
      });
      if (!contest) throw new Error("CONTEST_NOT_FOUND");
      if (contest.settledAt || ["LIVE", "COMPLETED", "SETTLED"].includes(contest.status)) {
        throw new Error("CONTEST_ALREADY_STARTED");
      }
      if (contest.status === "CANCELLED" && requestedStatus !== "CANCELLED") {
        throw new Error("CANCELLED_CONTEST_CANNOT_REOPEN");
      }
      if (requestedStatus === "CANCELLED") {
        return cancelContestAndRefund(tx, contestId);
      }
      if (
        requestedStatus === "OPEN" &&
        (contest.registrationDeadline && contest.registrationDeadline <= new Date() ||
          (contest.startsAt ?? contest.match.startsAt) <= new Date())
      ) {
        throw new Error("REGISTRATION_CLOSED");
      }
      const updated = await tx.contest.update({
        where: { id: contestId },
        data: {
          status: requestedStatus,
          ...(requestedStatus === "OPEN" ? { publishedAt: new Date() } : {}),
        },
      });
      return updated;
    }, SERIALIZABLE_CONTEST_TRANSACTION_OPTIONS);
    res.json({ id: result.id, status: result.status });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    const known: Record<string, { status: number; message: string }> = {
      CONTEST_NOT_FOUND: { status: 404, message: "Contest not found." },
      CONTEST_ALREADY_STARTED: { status: 409, message: "This contest can no longer be changed." },
      CANCELLED_CONTEST_CANNOT_REOPEN: { status: 409, message: "A cancelled contest cannot be reopened." },
      REGISTRATION_CLOSED: { status: 409, message: "Registration deadline has passed; this contest cannot be reopened." },
    };
    if (known[code]) {
      res.status(known[code].status).json({ error: known[code].message });
      return;
    }
    console.error("Manage Mega Contest error:", error);
    res.status(500).json({ error: "Could not manage contest." });
  }
});

app.post("/api/contests", requireAuth, requireAdmin, async (req, res) => {
  try {
    const {
      name,
      matchId,
      type,
      entryFee = 0,
      entryFeePaise: entryFeePaiseInput,
      capacity = 100,
      commissionBps = DEFAULT_COMMISSION_BPS,
      sponsorContributionPaise: sponsorInput = "0",
      targetPrizePoolPaise: targetPoolInput = "0",
      prizePercentages: payoutInput,
      prizeMode: requestedPrizeMode = "PERCENTAGE",
      prizeTemplate: requestedPrizeTemplate = null,
      fixedPrizeTiers: requestedFixedPrizeTiers,
      startsAt: startsAtInput,
      registrationDeadline: deadlineInput,
      publish = true,
    } = req.body ?? {};

    if (typeof name !== "string" || !name.trim() || name.trim().length > 80) {
      res.status(400).json({ error: "Contest name must be 1–80 characters." });
      return;
    }
    if (typeof matchId !== "string" || !matchId) {
      res.status(400).json({ error: "A match is required." });
      return;
    }
    if (!contestTypes.includes(type)) {
      res.status(400).json({ error: "Choose a supported contest format." });
      return;
    }
    if (!Number.isInteger(entryFee) || entryFee < 0 || entryFee > MAX_CONTEST_INTEGER) {
      res.status(400).json({ error: "Entry fee must be a non-negative whole number of rupees." });
      return;
    }
    if (!Number.isInteger(capacity) || capacity < 2 || capacity > MAX_CONTEST_INTEGER) {
      res.status(400).json({ error: "Contest capacity must be a whole number between 2 and 2,147,483,647." });
      return;
    }
    if (exceedsPayoutPositionLimit(capacity, type)) {
      res.status(400).json({ error: "Top-percentage formats support a maximum of 100 payout positions; reduce capacity or choose another format." });
      return;
    }
    if (BigInt(entryFee) * 100n * BigInt(capacity) > BigInt(Number.MAX_SAFE_INTEGER)) {
      res.status(400).json({ error: "Maximum contest revenue exceeds the supported exact paise range." });
      return;
    }
    if (!Number.isInteger(commissionBps) || commissionBps < 0 || commissionBps > 10_000) {
      res.status(400).json({ error: "Commission must be a whole-number basis-point rate between 0 and 10000." });
      return;
    }
    const parsePaise = (value: unknown, fallback: bigint) =>
      typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : fallback;
    if (
      entryFeePaiseInput !== undefined && (typeof entryFeePaiseInput !== "string" || !/^\d+$/.test(entryFeePaiseInput)) ||
      typeof sponsorInput !== "string" || !/^\d+$/.test(sponsorInput) ||
      typeof targetPoolInput !== "string" || !/^\d+$/.test(targetPoolInput)
    ) {
      res.status(400).json({ error: "Entry fees, sponsor contributions, and target pools must be whole paise amounts encoded as strings." });
      return;
    }
    const entryFeePaise = parsePaise(entryFeePaiseInput, BigInt(entryFee) * 100n);
    const sponsorContributionPaise = parsePaise(sponsorInput, 0n);
    const targetPrizePoolPaise = parsePaise(targetPoolInput, 0n);
    if (
      entryFeePaise > BigInt(Number.MAX_SAFE_INTEGER) ||
      BigInt(capacity) * entryFeePaise > BigInt(Number.MAX_SAFE_INTEGER) ||
      sponsorContributionPaise > BigInt(Number.MAX_SAFE_INTEGER) ||
      targetPrizePoolPaise > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      res.status(400).json({ error: "Contest amounts exceed the exact paise calculation limit." });
      return;
    }
    if (!["PERCENTAGE", "FIXED"].includes(requestedPrizeMode)) {
      res.status(400).json({ error: "Choose percentage or fixed prizes." });
      return;
    }
    const prizeMode = requestedPrizeMode as "PERCENTAGE" | "FIXED";
    const allowedTemplates = ["MEGA_JACKPOT", "HALF_WIN", "CLIMBER", "CUSTOM"];
    const prizeTemplate = requestedPrizeTemplate;
    const prizePercentages = payoutInput ?? readPayoutPercentages(null, type);
    if (prizeMode === "PERCENTAGE" && !validatePayoutPercentages(prizePercentages)) {
      res.status(400).json({ error: "Payout percentages must be whole numbers that add up to exactly 100." });
      return;
    }
    if (prizeMode === "FIXED" && (
      typeof prizeTemplate !== "string" ||
      !allowedTemplates.includes(prizeTemplate) ||
      !validateFixedPrizeTiers(requestedFixedPrizeTiers, capacity)
    )) {
      res.status(400).json({ error: "Choose a fixed-prize template and provide valid, non-overlapping prize tiers." });
      return;
    }
    const fixedPrizeTiers = prizeMode === "FIXED"
      ? requestedFixedPrizeTiers as ContestPayoutTier[]
      : undefined;
    if (typeof publish !== "boolean") {
      res.status(400).json({ error: "Publish state must be a boolean." });
      return;
    }
    const registrationDeadline = typeof deadlineInput === "string" ? new Date(deadlineInput) : undefined;
    if (
      (deadlineInput !== undefined && (!registrationDeadline || !Number.isFinite(registrationDeadline.getTime()))) ||
      (registrationDeadline && registrationDeadline <= new Date())
    ) {
      res.status(400).json({ error: "Registration deadline must be a valid future date." });
      return;
    }
    const atCapacity = calculateContestFinancials(
      capacity,
      entryFeePaise,
      commissionBps,
      sponsorContributionPaise,
    );
    if (prizeMode === "FIXED" && fixedPrizeTiers) {
      const liability = calculateFixedPrizeLiabilityPaise(fixedPrizeTiers);
      if (
        liability > BigInt(Number.MAX_SAFE_INTEGER) ||
        liability > atCapacity.distributablePrizePaise
      ) {
        res.status(400).json({
          error: "Fixed prize liability exceeds available funding at full capacity. Increase sponsor funding or reduce prizes.",
        });
        return;
      }
    }
    if (
      targetPrizePoolPaise > 0n &&
      targetPrizePoolPaise > atCapacity.distributablePrizePaise
    ) {
      res.status(400).json({
        error: "The target prize exceeds entry revenue after commission. Add the difference as an explicit sponsor contribution or lower the target.",
      });
      return;
    }

    const match = await prisma.match.findUnique({ where: { id: matchId } });
    if (!match) {
      res.status(404).json({ error: "Match not found." });
      return;
    }
    if (match.startsAt <= new Date() || (registrationDeadline && registrationDeadline >= match.startsAt)) {
      res.status(400).json({ error: "The selected match must be in the future and registration must close before its start." });
      return;
    }
    const startsAt = match.startsAt;
    if (
      publish &&
      (!match.isEnabled || match.isSuspended || match.archivedAt ||
        match.dataStatus !== "READY" || !match.provider)
    ) {
      res.status(409).json({ error: "Only explicitly published, provider-ready matches can have a published contest." });
      return;
    }

    const contest = await prisma.$transaction(async (tx) => {
      const created = await tx.contest.create({
        data: {
          name: name.trim(),
          matchId,
          type,
          entryFee,
          entryFeePaise,
          commissionBps,
          prizePercentages: prizePercentages as Prisma.InputJsonArray,
          prizeMode,
          prizeTemplate: prizeMode === "FIXED" ? prizeTemplate : null,
          fixedPrizeTiers: prizeMode === "FIXED"
            ? fixedPrizeTiers as Prisma.InputJsonArray
            : Prisma.DbNull,
          sponsorContributionPaise,
          targetPrizePoolPaise,
          capacity,
          startsAt: startsAt ?? match.startsAt,
          registrationDeadline: registrationDeadline ?? new Date(match.startsAt.getTime() - 15 * 60_000),
          status: publish ? "OPEN" : "DRAFT",
          sourceType: "MEGA",
          publishedAt: publish ? new Date() : null,
        },
      });
      if (sponsorContributionPaise > 0n) {
        await tx.contestFinancialEntry.create({
          data: {
            contestId: created.id,
            type: "SPONSOR_CONTRIBUTION",
            amountPaise: sponsorContributionPaise,
            idempotencyKey: `sponsor:${created.id}`,
          },
        });
      }
      const financials = calculateContestFinancials(0, entryFeePaise, commissionBps, sponsorContributionPaise);
      const poolPaise = targetPrizePoolPaise > 0n ? targetPrizePoolPaise : financials.distributablePrizePaise;
      return {
        ...created,
        prizePoolPaise: poolPaise,
        prizePool: Number(poolPaise / 100n),
        _count: { entries: 0 },
      };
    }, CONTEST_TRANSACTION_OPTIONS);

    res.status(201).json({
      ...contest,
      entryFeePaise: contest.entryFeePaise.toString(),
      sponsorContributionPaise: contest.sponsorContributionPaise.toString(),
      targetPrizePoolPaise: contest.targetPrizePoolPaise.toString(),
      prizePoolPaise: contest.prizePoolPaise.toString(),
      startsAt: contest.startsAt,
      entryCount: contest._count.entries,
      ...getPrizeDistribution(
        contest._count.entries,
        contest.entryFee,
        contest.type,
        contest.commissionBps,
        contest.sponsorContributionPaise,
        contest.entryFeePaise,
        contest.prizePercentages,
        contest.capacity,
        contest.targetPrizePoolPaise,
        contest.prizeMode,
        contest.fixedPrizeTiers,
      ),
      joined: false,
      notice: "Contest created. Entry and payout processing will be available after payment and scoring integrations are implemented.",
    });
  } catch (error) {
    console.error("Create contest error:", error);
    res.status(500).json({ error: "Could not create contest." });
  }
});


// Join a contest with one of the signed-in user's saved fantasy teams.
app.post("/api/contests/:contestId/join", requireAuth, async (req, res) => {
  try {
    const contestId = getStringParam(req, "contestId");
    const fantasyTeamId =
      typeof req.body?.fantasyTeamId === "string"
        ? req.body.fantasyTeamId.trim()
        : "";

    if (!contestId || !fantasyTeamId) {
      res.status(400).json({
        error: "Choose a contest and one of your saved fantasy teams.",
        code: "INVALID_JOIN_REQUEST",
      });
      return;
    }

    const userId = req.authenticatedUser!.id;

    const result = await prisma.$transaction(async (tx) => {
      const contest = await tx.contest.findUnique({
        where: { id: contestId },
        include: { match: true, _count: { select: { entries: true } } },
      });

      if (!contest) throw new Error("CONTEST_NOT_FOUND");

      const now = new Date();
      const match = contest.match;
      const matchStatus = match.status.trim().toUpperCase();
      const deadline = contest.registrationDeadline;
      const effectiveStart = contest.startsAt ?? match.startsAt;

      if (contest.status !== "OPEN") throw new Error("CONTEST_NOT_OPEN");
      if (contest._count.entries >= contest.capacity) throw new Error("CONTEST_FULL");
      if (deadline && deadline <= now) throw new Error("REGISTRATION_CLOSED");
      if (effectiveStart <= now || match.startsAt <= now) throw new Error("MATCH_STARTED");

      if (
        !match.isEnabled ||
        match.isSuspended ||
        match.archivedAt ||
        match.dataStatus !== "READY" ||
        !match.provider ||
        ["CANCELLED", "CANCELED", "ABANDONED", "POSTPONED",
         "COMPLETED", "COMPLETE", "FINISHED", "LIVE",
         "IN_PROGRESS", "IN PROGRESS"].includes(matchStatus)
      ) {
        throw new Error("MATCH_UNAVAILABLE");
      }

      const team = await tx.fantasyTeam.findFirst({
        where: {
          id: fantasyTeamId,
          userId,
          matchId: contest.matchId,
        },
        select: { id: true, name: true },
      });

      if (!team) throw new Error("TEAM_NOT_FOUND");

      const existing = await tx.contestEntry.findUnique({
        where: {
          contestId_fantasyTeamId: {
            contestId,
            fantasyTeamId,
          },
        },
        select: { id: true },
      });

      if (existing) throw new Error("ALREADY_JOINED");

      const fee =
        contest.entryFeePaise > 0n
          ? contest.entryFeePaise
          : BigInt(contest.entryFee) * 100n;

      if (fee < 0n) throw new Error("INVALID_ENTRY_FEE");

      if (fee > 0n && process.env.ENABLE_REAL_MONEY_CONTESTS !== "true") {
        throw new Error("REAL_MONEY_DISABLED");
      }

      // Validate funds and deduct them in the same serializable transaction
      // as the contest entry and ledger record.
      let walletId: string | null = null;

      if (fee > 0n) {
        const wallet = await tx.wallet.findUnique({
          where: {
            userId_currency: { userId, currency: "INR" },
          },
        });

        if (!wallet) throw new Error("INSUFFICIENT_BALANCE");

        const available = wallet.balanceMinor - wallet.reservedMinor;
        if (available < fee) throw new Error("INSUFFICIENT_BALANCE");

        // Spend deposited funds first, then winnings.
        const fromDeposits =
          wallet.depositedBalanceMinor < fee
            ? wallet.depositedBalanceMinor
            : fee;
        const fromWinnings = fee - fromDeposits;

        if (wallet.depositedBalanceMinor < 0n ||
            wallet.winningsBalanceMinor < fromWinnings) {
          throw new Error("WALLET_BALANCE_MISMATCH");
        }

        await tx.wallet.update({
          where: { id: wallet.id },
          data: {
            balanceMinor: { decrement: fee },
            depositedBalanceMinor: { decrement: fromDeposits },
            winningsBalanceMinor: { decrement: fromWinnings },
          },
        });

        walletId = wallet.id;
      }

      const entry = await tx.contestEntry.create({
        data: {
          contestId,
          userId,
          fantasyTeamId,
        },
        select: { id: true, joinedAt: true },
      });

      if (fee > 0n && walletId) {
        await tx.walletLedgerEntry.create({
          data: {
            walletId,
            type: "CONTEST_ENTRY",
            amountMinor: -fee,
            currency: "INR",
            idempotencyKey: `contest-entry:${contestId}:${fantasyTeamId}`,
            reference: entry.id,
            metadata: {
              contestId,
              fantasyTeamId,
              userId,
              entryFeePaise: fee.toString(),
            },
          },
        });
      }

      return {
        entryId: entry.id,
        joinedAt: entry.joinedAt,
        teamName: team.name,
        feePaise: fee.toString(),
      };
    }, {
      isolationLevel: "Serializable",
      maxWait: 10000,
      timeout: 15000,
    });

    res.status(201).json({
      message: "Successfully joined the contest.",
      ...result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";

    const knownErrors: Record<string, { status: number; error: string }> = {
      CONTEST_NOT_FOUND: { status: 404, error: "Contest not found." },
      TEAM_NOT_FOUND: { status: 404, error: "That saved team was not found for this match." },
      CONTEST_NOT_OPEN: { status: 409, error: "This contest is not open for entries." },
      CONTEST_FULL: { status: 409, error: "This contest is full." },
      REGISTRATION_CLOSED: { status: 409, error: "Contest registration has closed." },
      MATCH_STARTED: { status: 409, error: "The match has started. Entries are closed." },
      MATCH_UNAVAILABLE: { status: 409, error: "This match is not available for fantasy entry." },
      ALREADY_JOINED: { status: 409, error: "This fantasy team has already joined this contest." },
      INSUFFICIENT_BALANCE: { status: 400, error: "Insufficient available INR wallet balance." },
      INVALID_ENTRY_FEE: { status: 409, error: "The contest entry fee is invalid." },
      REAL_MONEY_DISABLED: { status: 503, error: "Paid contest entries are disabled until wallet tests are complete." },
      WALLET_BALANCE_MISMATCH: { status: 409, error: "Wallet balances need reconciliation. No entry was charged." },
    };

    const known = knownErrors[message];
    if (known) {
      res.status(known.status).json({ error: known.error, code: message });
      return;
    }

    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === "P2002" || error.code === "P2034")
    ) {
      res.status(409).json({
        error: "The contest changed while you were joining. Refresh and try again.",
        code: "CONCURRENT_JOIN",
      });
      return;
    }

    console.error("Join contest error:", error);
    res.status(500).json({ error: "Could not join the contest." });
  }
});

app.get("/api/contests/:contestId/leaderboard", requireAuth, async (req, res) => {
  try {
    const contestId = getStringParam(req, "contestId");
    if (!contestId) {
      res.status(400).json({ error: "A valid contest ID is required." });
      return;
    }

    const contest = await prisma.contest.findUnique({
      where: { id: contestId },
      select: {
        id: true, capacity: true, status: true,
        match: { select: { status: true } },
        _count: { select: { entries: true } },
      },
    });

    if (!contest) {
      res.status(404).json({ error: "Contest not found." });
      return;
    }

    const entries = await prisma.contestEntry.findMany({
      where: { contestId },
      select: {
        id: true,
        joinedAt: true,
        fantasyTeam: { select: { id: true, name: true } },
        user: { select: { fantasyName: true } },
      },
      orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
      take: contest.capacity,
    });

    res.json({
      contestId: contest.id,
      status: contest.status,
      entryCount: contest._count.entries,
      reportEligible:
        contest._count.entries > 200 &&
        ["LIVE", "IN_PROGRESS", "IN PROGRESS"].includes(contest.match.status.toUpperCase()),
      entries: entries.map((entry) => ({
        id: entry.id,
        joinedAt: entry.joinedAt,
        teamName: entry.fantasyTeam.name,
        fantasyName: entry.user.fantasyName,
      })),
    });
  } catch (error) {
    console.error("Contest leaderboard error:", error);
    res.status(500).json({ error: "Could not load contest entries." });
  }
});


app.get("/api/contests/:contestId/teams-report", requireAuth, async (req, res) => {
  try {
    const contestId = getStringParam(req, "contestId");
    if (!contestId) return res.status(400).send("Invalid contest ID.");
    const contest = await prisma.contest.findUnique({
      where: { id: contestId },
      select: {
        id: true, name: true, capacity: true,
        match: { select: { title: true, status: true } },
        _count: { select: { entries: true } },
      },
    });
    if (!contest) return res.status(404).send("Contest not found.");
    const live = ["LIVE", "IN_PROGRESS", "IN PROGRESS"].includes(contest.match.status.toUpperCase());
    if (contest._count.entries <= 200 || !live)
      return res.status(403).send("Report available only for contests with over 200 entries during a live match.");

    const entries = await prisma.contestEntry.findMany({
      where: { contestId },
      select: {
        fantasyTeam: {
          select: {
            name: true, captainId: true, viceCaptainId: true,
            selections: { select: { player: { select: { id: true, name: true } } } },
          },
        },
      },
      orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
      take: contest.capacity,
    });
    const esc = (v: string) => v.replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c
    );
    const rows = entries.map((e, i) => {
      const t = e.fantasyTeam;
      const players = t.selections.map(({ player }) =>
        esc(player.name) + (player.id === t.captainId ? " (C)" :
          player.id === t.viceCaptainId ? " (VC)" : "")
      ).join(", ");
      return `<tr><td>${i + 1}</td><td>${esc(t.name)}</td><td>${players}</td></tr>`;
    }).join("");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.send(`<!doctype html><html><head><meta charset="utf-8">
<title>${esc(contest.name)} Teams Report</title>
<style>
body{font:14px Arial;margin:24px;color:#111}h1{font-size:22px}
table{width:100%;border-collapse:collapse}th,td{border:1px solid #bbb;padding:8px;text-align:left;vertical-align:top}
th{background:#eee}button{padding:10px 16px;margin:12px 0}
@media print{button{display:none}body{margin:8mm}tr{break-inside:avoid}}
</style></head><body>
<h1>${esc(contest.name)} — Teams Report</h1>
<p>Match: ${esc(contest.match.title)} | Entries shown: ${entries.length} | (C) Captain | (VC) Vice-captain</p>
<button onclick="window.print()">Print / Save as PDF</button>
<table><thead><tr><th>#</th><th>Fantasy Team</th><th>Selected Players</th></tr></thead><tbody>${rows}</tbody></table>
</body></html>`);
  } catch (error) {
    console.error("Teams report error:", error);
    res.status(500).send("Could not generate teams report.");
  }
});

app.get("/api/my-contests", requireAuth, async (req, res) => {
  try {
    const user = req.authenticatedUser!;
    const entries = await prisma.contestEntry.findMany({
      where: { userId: user.id },
      include: {
        contest: { include: { match: true, _count: { select: { entries: true } } } },
        fantasyTeam: { select: { id: true, name: true } },
      },
      orderBy: { joinedAt: "desc" },
    });

    res.json({
      entries: entries.map((entry) => ({
        id: entry.id,
        joinedAt: entry.joinedAt,
        fantasyTeam: entry.fantasyTeam,
        contest: {
          ...entry.contest,
          entryFeePaise: entry.contest.entryFeePaise.toString(),
          sponsorContributionPaise: entry.contest.sponsorContributionPaise.toString(),
          prizePoolPaise: entry.contest.prizePoolPaise.toString(),
          targetPrizePoolPaise: entry.contest.targetPrizePoolPaise.toString(),
          startsAt: entry.contest.startsAt ?? entry.contest.match.startsAt,
          entryCount: entry.contest._count.entries,
          ...getPrizeDistribution(
            entry.contest._count.entries,
            entry.contest.entryFee,
            entry.contest.type,
            entry.contest.commissionBps,
            entry.contest.sponsorContributionPaise,
            entry.contest.entryFeePaise,
            entry.contest.prizePercentages,
            entry.contest.capacity,
            entry.contest.targetPrizePoolPaise,
            entry.contest.prizeMode,
            entry.contest.fixedPrizeTiers,
          ),
        },
      })),
    });
  } catch (error) {
    console.error("My contests error:", error);
    res.status(500).json({ error: "Could not load your contests." });
  }
});

app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  console.error("Unhandled API error:", error);
  res.status(500).json({ error: "An unexpected server error occurred." });
});

const CRICKET_MATCH_SYNC_INTERVAL_MS = 5 * 60 * 1000;
let cricketMatchSyncRunning = false;

async function runCricketMatchSyncCycle() {
  const apiKey = process.env.CRICKETLIVEAPI_API_KEY?.trim();

  if (!apiKey) {
    return;
  }

  if (cricketMatchSyncRunning) {
    console.log("Cricket match sync skipped: previous sync is still running.");
    return;
  }

  cricketMatchSyncRunning = true;

  try {
    const matches = await fetchCricketLiveApiMatches(apiKey);

    const summary = await prisma.$transaction(
      (tx) => importCricketLiveApiMatches(tx, matches),
      { maxWait: 10_000, timeout: 60_000 },
    );

    console.log("Automatic cricket match sync completed:", {
      received: summary.received,
      created: summary.created,
      updated: summary.updated,
    });
  } catch (error) {
    console.error("Automatic cricket match sync failed:", error);
  } finally {
    cricketMatchSyncRunning = false;
  }
}

const cricketMatchSyncTimer = setInterval(() => {
  void runCricketMatchSyncCycle();
}, CRICKET_MATCH_SYNC_INTERVAL_MS);
cricketMatchSyncTimer.unref();
void runCricketMatchSyncCycle();

const contestGenerationTimer = setInterval(() => {
  void runContestGenerationCycle();
}, CONTEST_ENGINE_INTERVAL_MS);
contestGenerationTimer.unref();
void runContestGenerationCycle();

const httpServer = app.listen(PORT, "0.0.0.0", () => {
  console.log(`WillFantasy API running on port ${PORT}`);
});

async function shutdown() {
  clearInterval(contestGenerationTimer);
  clearInterval(cricketMatchSyncTimer);
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
