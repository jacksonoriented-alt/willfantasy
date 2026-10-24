import type { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  CricketLiveApiContractError,
  providerTeamShortName,
} from "./cricketliveapi";

const providerId = z.union([
  z.string().trim().min(1),
  z.number().int().safe(),
]).transform(String);

const playerSchema = z.object({
  player_id: providerId,
  name: z.string().trim().min(1),
  short_name: z.string().nullable().optional(),
  team_id: providerId,
  team: z.string().nullable().optional(),
  team_short: z.string().nullable().optional(),
  role: z.string().trim().min(1),
  role_full: z.string().nullable().optional(),
  credit: z.unknown().optional(),
  is_playing_xi: z.boolean().nullable().optional(),
  is_captain: z.boolean().nullable().optional(),
  is_keeper: z.boolean().nullable().optional(),
  image_url: z.string().nullable().optional(),
});

const playerPoolSchema = z.object({
  success: z.literal(true),
  match_id: providerId,
  count: z.number().int().nonnegative(),
  data: z.array(playerSchema),
}).superRefine((pool, context) => {
  if (pool.count !== pool.data.length) {
    context.addIssue({
      code: "custom",
      path: ["data"],
      message: `Player-list count ${pool.count} does not match the ${pool.data.length} returned players.`,
    });
  }
  if (pool.data.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["data"],
      message: "The player-list response contains no players.",
    });
  }
  const ids = new Set<string>();
  pool.data.forEach((player, index) => {
    if (ids.has(player.player_id)) {
      context.addIssue({
        code: "custom",
        path: ["data", index, "player_id"],
        message: "A player response cannot contain duplicate player IDs.",
      });
    }
    ids.add(player.player_id);
  });
});

const playingXIPlayerSchema = z.object({
  player_id: providerId,
  name: z.string().trim().min(1),
  role: z.string().trim().min(1),
  is_captain: z.boolean().nullable().optional(),
  is_keeper: z.boolean().nullable().optional(),
  credit: z.unknown().optional(),
  image_url: z.string().nullable().optional(),
});

const playingXISchema = z.object({
  success: z.literal(true),
  match_id: providerId,
  data: z.object({
    confirmed: z.boolean(),
    team1: z.array(playingXIPlayerSchema),
    team2: z.array(playingXIPlayerSchema),
  }),
}).superRefine((response, context) => {
  const ids = new Set<string>();
  for (const [teamName, players] of [
    ["team1", response.data.team1],
    ["team2", response.data.team2],
  ] as const) {
    players.forEach((player, index) => {
      if (ids.has(player.player_id)) {
        context.addIssue({
          code: "custom",
          path: ["data", teamName, index, "player_id"],
          message: "A playing XI response cannot contain duplicate player IDs.",
        });
      }
      ids.add(player.player_id);
    });
  }
});

export type CricketLiveApiPlayer = z.infer<typeof playerSchema>;
export type CricketLiveApiPlayerPool = z.infer<typeof playerPoolSchema>;
export type CricketLiveApiXIPlayer = z.infer<typeof playingXIPlayerSchema>;
export type CricketLiveApiPlayingXI = z.infer<typeof playingXISchema>;

const fantasyRoles: Record<string, string> = {
  WK: "WICKETKEEPER",
  BAT: "BATTER",
  AR: "ALL_ROUNDER",
  BOWL: "BOWLER",
};

export function normalizeCricketLiveApiRole(role: string): string | null {
  return fantasyRoles[role.trim().toUpperCase()] ?? null;
}

function parseResponse<T>(
  schema: z.ZodType<T>,
  value: unknown,
  description: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const location = issue?.path.length ? issue.path.join(".") : "response";
    throw new CricketLiveApiContractError(
      `Invalid CricketLiveAPI ${description} response at ${location}: ${issue?.message ?? "invalid response"}`,
    );
  }
  return parsed.data;
}

export function parseCricketLiveApiPlayerPool(
  value: unknown,
  expectedMatchId: string,
): CricketLiveApiPlayerPool {
  const pool = parseResponse(playerPoolSchema, value, "player-list");
  if (pool.match_id !== expectedMatchId) {
    throw new CricketLiveApiContractError(
      `CricketLiveAPI player-list response is for match ${pool.match_id}, not ${expectedMatchId}.`,
    );
  }
  return pool;
}

export function parseCricketLiveApiPlayingXI(
  value: unknown,
  expectedMatchId: string,
): CricketLiveApiPlayingXI {
  const playingXI = parseResponse(playingXISchema, value, "playing-XI");
  if (playingXI.match_id !== expectedMatchId) {
    throw new CricketLiveApiContractError(
      `CricketLiveAPI playing-XI response is for match ${playingXI.match_id}, not ${expectedMatchId}.`,
    );
  }
  return playingXI;
}

async function fetchProviderJson(path: string, apiKey = process.env.CRICKETLIVEAPI_API_KEY?.trim()): Promise<unknown> {
  if (!apiKey) {
    throw new Error("CRICKETLIVEAPI_API_KEY is not configured.");
  }

  const response = await fetch(`https://cricketliveapi.com/api/v1/fantasy/${path}`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`CricketLiveAPI request failed with HTTP ${response.status}.`);
  }
  try {
    return await response.json();
  } catch {
    throw new CricketLiveApiContractError(
      "CricketLiveAPI returned a response that was not valid JSON.",
    );
  }
}

export async function fetchCricketLiveApiPlayerPool(
  matchId: string,
): Promise<CricketLiveApiPlayerPool> {
  return parseCricketLiveApiPlayerPool(
    await fetchProviderJson(`players/${encodeURIComponent(matchId)}`),
    matchId,
  );
}

export async function fetchCricketLiveApiPlayingXI(
  matchId: string,
): Promise<CricketLiveApiPlayingXI> {
  return parseCricketLiveApiPlayingXI(
    await fetchProviderJson(`playing-xi/${encodeURIComponent(matchId)}`),
    matchId,
  );
}

type FixtureParticipant = {
  cricketTeamId: string;
  cricketTeam: { shortName: string };
};

export type PlayerReadinessRow = {
  cricketTeamId: string;
  role: string;
  creditValue: number;
  isInSquad: boolean;
  provider: string | null;
  externalPlayerId: string | null;
};

export function validatePlayerPoolReadiness(
  participants: FixtureParticipant[],
  players: PlayerReadinessRow[],
  matchStatus: string,
  importErrors: string[] = [],
) {
  const errors = [...importErrors];
  if (participants.length !== 2 || new Set(participants.map(({ cricketTeamId }) => cricketTeamId)).size !== 2) {
    errors.push("The fixture must have exactly two distinct participant teams.");
  }
  if (["CANCELLED", "CANCELED", "ABANDONED", "POSTPONED", "POSTPONE"].includes(matchStatus.trim().toUpperCase())) {
    errors.push(`A ${matchStatus.toLowerCase()} match cannot be marked ready.`);
  }
  const participantTeamIds = new Set(participants.map(({ cricketTeamId }) => cricketTeamId));
  if (players.some((player) => player.isInSquad && !participantTeamIds.has(player.cricketTeamId))) {
    errors.push("The player pool contains a squad association outside the fixture participants.");
  }
  if (players.some((player) =>
    player.isInSquad &&
    (player.provider !== "CRICKETLIVEAPI" || !player.externalPlayerId)
  )) {
    errors.push("The player pool contains players without a CricketLiveAPI identity.");
  }

  for (const participant of participants) {
    const squad = players.filter((player) =>
      player.cricketTeamId === participant.cricketTeamId && player.isInSquad
    );
    if (squad.length < 11) {
      errors.push(`${participant.cricketTeam.shortName} has ${squad.length} valid roster entries; at least 11 are required.`);
    }
    if (squad.some((player) =>
      !Object.values(fantasyRoles).includes(player.role) ||
      !Number.isFinite(player.creditValue) ||
      player.creditValue < 0
    )) {
      errors.push(`${participant.cricketTeam.shortName} has players with an unsupported role or missing valid credits.`);
    }
  }

  return { ready: errors.length === 0, errors: [...new Set(errors)] };
}

export async function importCricketLiveApiPlayerPool(
  tx: Prisma.TransactionClient,
  input: {
    matchId: string;
    fixtureStatus: string;
    participants: FixtureParticipant[];
    pool: CricketLiveApiPlayerPool;
    syncedAt?: Date;
  },
) {
  const syncedAt = input.syncedAt ?? new Date();
  const errors: string[] = [];
  const warnings: string[] = [];
  const participantsByProviderKey = new Map(
    input.participants.map((participant) => [
      participant.cricketTeam.shortName,
      participant.cricketTeamId,
    ]),
  );
  if (input.participants.length !== 2 || participantsByProviderKey.size !== 2) {
    errors.push("The fixture must have exactly two distinct participant teams.");
  }

  const importedPlayerIds: string[] = [];
  for (const player of input.pool.data) {
    const cricketTeamId = participantsByProviderKey.get(providerTeamShortName(player.team_id));
    if (!cricketTeamId) {
      errors.push(`Player ${player.player_id} references team ID ${player.team_id}, which is not a fixture participant.`);
      continue;
    }

    const role = normalizeCricketLiveApiRole(player.role);
    if (!role) {
      const message = `Player ${player.player_id} has unsupported provider role "${player.role}".`;
      warnings.push(message);
      errors.push(message);
    }
    const creditValue = typeof player.credit === "number" &&
      Number.isFinite(player.credit) && player.credit >= 0
      ? player.credit
      : null;
    if (creditValue === null) {
      const message = `Player ${player.player_id} has no valid provider credit value.`;
      warnings.push(message);
      errors.push(message);
      continue;
    }
    const mappedRole = role ?? "UNKNOWN";
    const playerData = {
      name: player.name,
      shortName: player.short_name?.trim() || null,
      role: mappedRole,
      providerRole: player.role,
      creditValue,
      provider: "CRICKETLIVEAPI",
      externalPlayerId: player.player_id,
      imageUrl: player.image_url?.trim() || null,
      cricketTeamId,
    };
    const importedPlayer = await tx.player.upsert({
      where: {
        provider_externalPlayerId: {
          provider: "CRICKETLIVEAPI",
          externalPlayerId: player.player_id,
        },
      },
      create: playerData,
      update: playerData,
      select: { id: true },
    });
    await tx.matchPlayer.upsert({
      where: {
        matchId_playerId: {
          matchId: input.matchId,
          playerId: importedPlayer.id,
        },
      },
      create: {
        matchId: input.matchId,
        playerId: importedPlayer.id,
        cricketTeamId,
        role: mappedRole,
        creditValue,
        providerTeamName: player.team?.trim() || null,
        providerTeamShortName: player.team_short?.trim() || null,
        isInSquad: true,
        isPlayingXI: false,
        isCaptain: player.is_captain ?? false,
        isKeeper: player.is_keeper ?? false,
      },
      update: {
        cricketTeamId,
        role: mappedRole,
        creditValue,
        providerTeamName: player.team?.trim() || null,
        providerTeamShortName: player.team_short?.trim() || null,
        isInSquad: true,
        isPlayingXI: false,
        isCaptain: player.is_captain ?? false,
        isKeeper: player.is_keeper ?? false,
      },
    });
    importedPlayerIds.push(importedPlayer.id);
  }

  if (importedPlayerIds.length > 0 && errors.length === 0) {
    await tx.matchPlayer.updateMany({
      where: {
        matchId: input.matchId,
        playerId: { notIn: importedPlayerIds },
      },
      data: { isInSquad: false, isPlayingXI: false },
    });
  }

  const playerRows = await tx.matchPlayer.findMany({
    where: { matchId: input.matchId },
    select: {
      cricketTeamId: true,
      role: true,
      creditValue: true,
      isInSquad: true,
      player: { select: { provider: true, externalPlayerId: true } },
    },
  });
  const readiness = validatePlayerPoolReadiness(
    input.participants,
    playerRows.map((player) => ({
      cricketTeamId: player.cricketTeamId,
      role: player.role,
      creditValue: player.creditValue,
      isInSquad: player.isInSquad,
      provider: player.player.provider,
      externalPlayerId: player.player.externalPlayerId,
    })),
    input.fixtureStatus,
    errors,
  );
  await tx.match.update({
    where: { id: input.matchId },
    data: {
      dataStatus: readiness.ready ? "READY" : "INCOMPLETE",
      playersLastSyncedAt: syncedAt,
      playersSyncError: readiness.errors.length ? readiness.errors.join(" ").slice(0, 1000) : null,
    },
  });

  return {
    received: input.pool.data.length,
    imported: importedPlayerIds.length,
    warnings,
    errors: readiness.errors,
    ready: readiness.ready,
    syncedAt: syncedAt.toISOString(),
  };
}

export async function importCricketLiveApiPlayingXI(
  tx: Prisma.TransactionClient,
  matchId: string,
  playingXI: CricketLiveApiPlayingXI,
  syncedAt = new Date(),
) {
  const playerEntries = await tx.matchPlayer.findMany({
    where: { matchId, isInSquad: true },
    select: {
      playerId: true,
      cricketTeamId: true,
      role: true,
      player: { select: { provider: true, externalPlayerId: true } },
    },
  });
  const byPlayerId = new Map(
    playerEntries
      .filter((entry) =>
        entry.player.provider === "CRICKETLIVEAPI" &&
        entry.player.externalPlayerId !== null
      )
      .map((entry) => [entry.player.externalPlayerId!, entry]),
  );
  const errors: string[] = [];
  const team1 = playingXI.data.team1;
  const team2 = playingXI.data.team2;

  if (playingXI.data.confirmed) {
    if (team1.length !== 11 || team2.length !== 11) {
      errors.push("A confirmed playing XI must contain exactly 11 players for each team.");
    }
    const teamByArray = [team1, team2].map((teamPlayers, teamIndex) => {
      const associated = teamPlayers.map((player) => byPlayerId.get(player.player_id));
      if (associated.some((entry) => !entry)) {
        errors.push(`Playing XI team${teamIndex + 1} contains players missing from the imported player pool.`);
        return null;
      }
      const teamIds = new Set(associated.map((entry) => entry!.cricketTeamId));
      if (teamIds.size !== 1) {
        errors.push(`Playing XI team${teamIndex + 1} does not map to exactly one fixture participant.`);
        return null;
      }
      return [...teamIds][0] ?? null;
    });
    if (teamByArray[0] && teamByArray[0] === teamByArray[1]) {
      errors.push("Playing XI team1 and team2 resolve to the same fixture participant.");
    }
    if (playingXI.data.team1.some((player, index) => {
      const poolPlayer = byPlayerId.get(player.player_id);
      return poolPlayer && normalizeCricketLiveApiRole(player.role) !== poolPlayer.role;
    }) || playingXI.data.team2.some((player) => {
      const poolPlayer = byPlayerId.get(player.player_id);
      return poolPlayer && normalizeCricketLiveApiRole(player.role) !== poolPlayer.role;
    })) {
      errors.push("Playing XI roles are inconsistent with the imported player pool.");
    }
  }

  const confirmed = playingXI.data.confirmed && errors.length === 0;

  // Only replace the saved XI when the provider response is valid, or when
  // the provider explicitly says the XI is not confirmed. A malformed
  // "confirmed" response must not erase a previously valid playing XI.
  if (confirmed || !playingXI.data.confirmed) {
    await tx.matchPlayer.updateMany({
      where: { matchId },
      data: { isPlayingXI: false },
    });
  }

  if (confirmed) {
    for (const xiPlayer of [...team1, ...team2]) {
      const poolPlayer = byPlayerId.get(xiPlayer.player_id);
      if (!poolPlayer) continue;
      await tx.matchPlayer.update({
        where: {
          matchId_playerId: { matchId, playerId: poolPlayer.playerId },
        },
        data: {
          isPlayingXI: true,
          isCaptain: xiPlayer.is_captain ?? false,
          isKeeper: xiPlayer.is_keeper ?? false,
        },
      });
    }
  }

  await tx.match.update({
    where: { id: matchId },
    data: {
      // If a response claims to be confirmed but fails validation, preserve
      // the last known valid confirmation state and only record the error.
      ...(playingXI.data.confirmed && errors.length > 0
        ? {}
        : { playingXIConfirmed: confirmed }),
      playingXILastSyncedAt: syncedAt,
      playingXISyncError: errors.length ? errors.join(" ").slice(0, 1000) : null,
    },
  });
  return { confirmed, errors };
}
