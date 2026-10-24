import assert from "node:assert/strict";
import test from "node:test";
import type { Prisma } from "@prisma/client";
import {
  CricketLiveApiContractError,
  providerTeamShortName,
} from "./cricketliveapi";
import {
  importCricketLiveApiPlayerPool,
  importCricketLiveApiPlayingXI,
  parseCricketLiveApiPlayerPool,
  parseCricketLiveApiPlayingXI,
  validatePlayerPoolReadiness,
  fetchCricketLiveApiPlayerPool,
} from "./cricketliveapi-players";

type StoredPlayer = {
  id: string;
  name: string;
  shortName: string | null;
  role: string;
  providerRole: string;
  creditValue: number;
  provider: string;
  externalPlayerId: string;
  imageUrl: string | null;
  cricketTeamId: string;
};
type StoredMatchPlayer = {
  matchId: string;
  playerId: string;
  cricketTeamId: string;
  role: string;
  creditValue: number;
  providerTeamName: string | null;
  providerTeamShortName: string | null;
  isInSquad: boolean;
  isPlayingXI: boolean;
  isCaptain: boolean;
  isKeeper: boolean;
};

function makeTransaction() {
  const players = new Map<string, StoredPlayer>();
  const matchPlayers = new Map<string, StoredMatchPlayer>();
  const matches = new Map<string, Record<string, unknown>>();
  let nextId = 1;
  const tx = {
    player: {
      upsert: async (args: {
        where: { provider_externalPlayerId: { externalPlayerId: string } };
        create: Omit<StoredPlayer, "id">;
        update: Omit<StoredPlayer, "id">;
      }) => {
        const externalId = args.where.provider_externalPlayerId.externalPlayerId;
        const existing = players.get(externalId);
        const player = existing
          ? { ...existing, ...args.update }
          : { id: `player-${nextId++}`, ...args.create };
        players.set(externalId, player);
        return { id: player.id };
      },
    },
    matchPlayer: {
      upsert: async (args: {
        where: { matchId_playerId: { matchId: string; playerId: string } };
        create: StoredMatchPlayer;
        update: Partial<StoredMatchPlayer>;
      }) => {
        const key = `${args.where.matchId_playerId.matchId}:${args.where.matchId_playerId.playerId}`;
        const existing = matchPlayers.get(key);
        const record = existing ? { ...existing, ...args.update } : { ...args.create };
        matchPlayers.set(key, record);
        return record;
      },
      updateMany: async (args: {
        where: {
          matchId: string;
          playerId?: { notIn: string[] };
        };
        data: Partial<StoredMatchPlayer>;
      }) => {
        let count = 0;
        for (const [key, record] of matchPlayers) {
          if (record.matchId !== args.where.matchId) continue;
          if (args.where.playerId?.notIn.includes(record.playerId)) continue;
          matchPlayers.set(key, { ...record, ...args.data });
          count += 1;
        }
        return { count };
      },
      update: async (args: {
        where: { matchId_playerId: { matchId: string; playerId: string } };
        data: Partial<StoredMatchPlayer>;
      }) => {
        const key = `${args.where.matchId_playerId.matchId}:${args.where.matchId_playerId.playerId}`;
        const existing = matchPlayers.get(key);
        if (!existing) throw new Error("Match player not found.");
        const record = { ...existing, ...args.data };
        matchPlayers.set(key, record);
        return record;
      },
      findMany: async (args: { where: { matchId: string; isInSquad?: boolean } }) =>
        [...matchPlayers.values()]
          .filter((record) =>
            record.matchId === args.where.matchId &&
            (args.where.isInSquad === undefined || record.isInSquad === args.where.isInSquad)
          )
          .map((record) => ({
            ...record,
            player: {
              provider: "CRICKETLIVEAPI",
              externalPlayerId: [...players.values()].find(({ id }) => id === record.playerId)?.externalPlayerId ?? null,
            },
          })),
    },
    match: {
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const record = { ...(matches.get(args.where.id) ?? {}), ...args.data };
        matches.set(args.where.id, record);
        return record;
      },
    },
  };
  return {
    tx: tx as unknown as Prisma.TransactionClient,
    players,
    matchPlayers,
    matches,
  };
}

function playerPool(overrides: {
  role?: string;
  teamId?: string;
  count?: number;
  players?: Record<string, unknown>[];
} = {}) {
  const roles = ["WK", "BAT", "AR", "BOWL"];
  const data = overrides.players ?? Array.from({ length: 22 }, (_, index) => ({
    player_id: String(index === 0 ? 14241 : 14241 + index),
    name: `Player ${index + 1}`,
    short_name: `P${index + 1}`,
    team_id: index < 11 ? "3" : "4",
    team: index < 11 ? "Pakistan" : "Opponent",
    team_short: index < 11 ? "PAK" : "OPP",
    role: index === 0 ? overrides.role ?? "AR" : roles[index % roles.length],
    role_full: "All-rounder",
    credit: 8,
    is_playing_xi: false,
    is_captain: false,
    is_keeper: false,
    image_url: "https://example.test/player.png",
  }));
  return {
    success: true,
    match_id: "170720",
    count: overrides.count ?? data.length,
    data: data.map((player, index) => ({
      ...player,
      ...(index === 0 && overrides.teamId ? { team_id: overrides.teamId } : {}),
    })),
  };
}

const participants = [
  { cricketTeamId: "team-3", cricketTeam: { shortName: providerTeamShortName("3") } },
  { cricketTeamId: "team-4", cricketTeam: { shortName: providerTeamShortName("4") } },
];

test("imports the verified player-list shape and repeated syncs are idempotent", async () => {
  const db = makeTransaction();
  const pool = parseCricketLiveApiPlayerPool(playerPool(), "170720");
  const first = await importCricketLiveApiPlayerPool(db.tx, {
    matchId: "match-1",
    fixtureStatus: "UPCOMING",
    participants,
    pool,
  });
  const second = await importCricketLiveApiPlayerPool(db.tx, {
    matchId: "match-1",
    fixtureStatus: "UPCOMING",
    participants,
    pool,
  });

  assert.equal(first.ready, true);
  assert.equal(second.ready, true);
  assert.equal(db.players.size, 22);
  assert.equal(db.matchPlayers.size, 22);
  assert.equal(db.matches.get("match-1")?.dataStatus, "READY");
});

test("rejects incomplete player lists, missing response fields, and duplicate provider IDs", () => {
  assert.throws(
    () => parseCricketLiveApiPlayerPool(playerPool({ count: 23 }), "170720"),
    CricketLiveApiContractError,
  );
  assert.throws(
    () => parseCricketLiveApiPlayerPool({
      success: true,
      match_id: "170720",
      count: 1,
      data: [{ player_id: 14241, team_id: 3, role: "AR", credit: 8 }],
    }, "170720"),
    CricketLiveApiContractError,
  );
  const duplicated = playerPool({ players: [
    { ...(playerPool().data[0] as object) },
    { ...(playerPool().data[0] as object) },
  ] });
  assert.throws(() => parseCricketLiveApiPlayerPool(duplicated, "170720"), /duplicate player IDs/);
});

test("unknown roles and team mapping failures keep the pool incomplete", async () => {
  const unknownRoleDb = makeTransaction();
  const unknownRole = await importCricketLiveApiPlayerPool(unknownRoleDb.tx, {
    matchId: "match-1",
    fixtureStatus: "UPCOMING",
    participants,
    pool: parseCricketLiveApiPlayerPool(playerPool({ role: "UNKNOWN_ROLE" }), "170720"),
  });
  assert.equal(unknownRole.ready, false);
  assert.match(unknownRole.warnings.join(" "), /unsupported provider role/);
  assert.equal([...unknownRoleDb.players.values()][0]?.role, "UNKNOWN");

  const wrongTeamDb = makeTransaction();
  const wrongTeam = await importCricketLiveApiPlayerPool(wrongTeamDb.tx, {
    matchId: "match-1",
    fixtureStatus: "UPCOMING",
    participants,
    pool: parseCricketLiveApiPlayerPool(playerPool({ teamId: "999" }), "170720"),
  });
  assert.equal(wrongTeam.ready, false);
  assert.match(wrongTeam.errors.join(" "), /not a fixture participant/);
  assert.notEqual(wrongTeamDb.matches.get("match-1")?.dataStatus, "READY");
});

test("requires valid per-team roster counts and excludes postponed or abandoned matches", () => {
  const result = validatePlayerPoolReadiness(
    participants,
    Array.from({ length: 22 }, (_, index) => ({
      cricketTeamId: index < 11 ? "team-3" : "team-4",
      role: "BATTER",
      creditValue: 8,
      isInSquad: true,
      provider: "CRICKETLIVEAPI",
      externalPlayerId: `player-${index + 1}`,
    })),
    "POSTPONED",
  );
  assert.equal(result.ready, false);
  assert.ok(result.errors.some((error) => error.includes("postponed")));
});

test("keeps an unconfirmed playing XI separate from the full player pool", async () => {
  const db = makeTransaction();
  await importCricketLiveApiPlayerPool(db.tx, {
    matchId: "match-1",
    fixtureStatus: "UPCOMING",
    participants,
    pool: parseCricketLiveApiPlayerPool(playerPool(), "170720"),
  });
  const xi = parseCricketLiveApiPlayingXI({
    success: true,
    match_id: "170720",
    data: { confirmed: false, team1: [], team2: [] },
  }, "170720");
  const result = await importCricketLiveApiPlayingXI(db.tx, "match-1", xi);

  assert.equal(result.confirmed, false);
  assert.equal(db.matchPlayers.size, 22);
  assert.ok([...db.matchPlayers.values()].every(({ isInSquad, isPlayingXI }) => isInSquad && !isPlayingXI));
  assert.equal(db.matches.get("match-1")?.playingXIConfirmed, false);
});

test("maps a confirmed XI through player IDs instead of assuming response team order", async () => {
  const db = makeTransaction();
  const pool = parseCricketLiveApiPlayerPool(playerPool(), "170720");
  await importCricketLiveApiPlayerPool(db.tx, {
    matchId: "match-1",
    fixtureStatus: "UPCOMING",
    participants,
    pool,
  });
  const byTeam = (teamId: string) => pool.data
    .filter((player) => player.team_id === teamId)
    .map((player) => ({
      player_id: player.player_id,
      name: player.name,
      role: player.role,
      is_captain: false,
      is_keeper: false,
      credit: player.credit,
      image_url: player.image_url,
    }));
  const xi = parseCricketLiveApiPlayingXI({
    success: true,
    match_id: "170720",
    data: { confirmed: true, team1: byTeam("4"), team2: byTeam("3") },
  }, "170720");

  const result = await importCricketLiveApiPlayingXI(db.tx, "match-1", xi);

  assert.deepEqual(result, { confirmed: true, errors: [] });
  assert.equal([...db.matchPlayers.values()].filter(({ isPlayingXI }) => isPlayingXI).length, 22);
  assert.equal(db.matches.get("match-1")?.playingXIConfirmed, true);
});

test("rejects unsuccessful and wrong-match API response bodies", () => {
  assert.throws(
    () => parseCricketLiveApiPlayerPool({ ...playerPool(), success: false }, "170720"),
    CricketLiveApiContractError,
  );
  assert.throws(
    () => parseCricketLiveApiPlayingXI({
      success: true,
      match_id: "170721",
      data: { confirmed: false, team1: [], team2: [] },
    }, "170720"),
    /not 170720/,
  );
});

test("surfaces provider HTTP errors without treating them as an empty player pool", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.CRICKETLIVEAPI_API_KEY;
  process.env.CRICKETLIVEAPI_API_KEY = "test-api-key";
  globalThis.fetch = async (input) => {
    assert.equal(String(input), "https://cricketliveapi.com/api/v1/fantasy/players/170720");
    return { ok: false, status: 503 } as Response;
  };
  try {
    await assert.rejects(fetchCricketLiveApiPlayerPool("170720"), /HTTP 503/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.CRICKETLIVEAPI_API_KEY;
    } else {
      process.env.CRICKETLIVEAPI_API_KEY = originalApiKey;
    }
  }
});

test("preserves the last valid playing XI when a confirmed response fails validation", async () => {
  const db = makeTransaction();
  const pool = parseCricketLiveApiPlayerPool(playerPool(), "170720");

  await importCricketLiveApiPlayerPool(db.tx, {
    matchId: "match-1",
    fixtureStatus: "UPCOMING",
    participants,
    pool,
  });

  const byTeam = (teamId: string) => pool.data
    .filter((player) => player.team_id === teamId)
    .map((player) => ({
      player_id: player.player_id,
      name: player.name,
      role: player.role,
      is_captain: false,
      is_keeper: false,
      credit: player.credit,
      image_url: player.image_url,
    }));

  const validXI = parseCricketLiveApiPlayingXI({
    success: true,
    match_id: "170720",
    data: {
      confirmed: true,
      team1: byTeam("3"),
      team2: byTeam("4"),
    },
  }, "170720");

  const firstResult = await importCricketLiveApiPlayingXI(
    db.tx,
    "match-1",
    validXI,
  );

  assert.equal(firstResult.confirmed, true);

  const previouslySelected = [...db.matchPlayers.values()]
    .filter(({ isPlayingXI }) => isPlayingXI)
    .map(({ playerId }) => playerId)
    .sort();

  assert.equal(previouslySelected.length, 22);

  const invalidXI = parseCricketLiveApiPlayingXI({
    success: true,
    match_id: "170720",
    data: {
      confirmed: true,
      team1: byTeam("3").slice(0, 10),
      team2: byTeam("4"),
    },
  }, "170720");

  const secondResult = await importCricketLiveApiPlayingXI(
    db.tx,
    "match-1",
    invalidXI,
  );

  const stillSelected = [...db.matchPlayers.values()]
    .filter(({ isPlayingXI }) => isPlayingXI)
    .map(({ playerId }) => playerId)
    .sort();

  assert.equal(secondResult.confirmed, false);
  assert.ok(secondResult.errors.length > 0);
  assert.deepEqual(stillSelected, previouslySelected);
  assert.equal(db.matches.get("match-1")?.playingXIConfirmed, true);
  assert.ok(db.matches.get("match-1")?.playingXISyncError);
});
