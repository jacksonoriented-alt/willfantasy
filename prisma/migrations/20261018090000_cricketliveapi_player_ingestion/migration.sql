ALTER TABLE "Player"
  ADD COLUMN "shortName" TEXT,
  ADD COLUMN "providerRole" TEXT,
  ADD COLUMN "provider" TEXT,
  ADD COLUMN "externalPlayerId" TEXT,
  ADD COLUMN "imageUrl" TEXT;

CREATE UNIQUE INDEX "Player_provider_externalPlayerId_key"
  ON "Player"("provider", "externalPlayerId");

ALTER TABLE "Match"
  ADD COLUMN "playersLastSyncedAt" TIMESTAMP(3),
  ADD COLUMN "playersSyncError" TEXT,
  ADD COLUMN "playingXIConfirmed" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "playingXILastSyncedAt" TIMESTAMP(3),
  ADD COLUMN "playingXISyncError" TEXT;

CREATE TABLE "MatchPlayer" (
  "matchId" TEXT NOT NULL,
  "playerId" TEXT NOT NULL,
  "cricketTeamId" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "creditValue" DOUBLE PRECISION NOT NULL,
  "providerTeamName" TEXT,
  "providerTeamShortName" TEXT,
  "isInSquad" BOOLEAN NOT NULL DEFAULT true,
  "isPlayingXI" BOOLEAN NOT NULL DEFAULT false,
  "isCaptain" BOOLEAN NOT NULL DEFAULT false,
  "isKeeper" BOOLEAN NOT NULL DEFAULT false,

  CONSTRAINT "MatchPlayer_pkey" PRIMARY KEY ("matchId", "playerId")
);

CREATE INDEX "MatchPlayer_matchId_cricketTeamId_isInSquad_idx"
  ON "MatchPlayer"("matchId", "cricketTeamId", "isInSquad");

ALTER TABLE "MatchPlayer"
  ADD CONSTRAINT "MatchPlayer_matchId_fkey"
    FOREIGN KEY ("matchId") REFERENCES "Match"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "MatchPlayer_playerId_fkey"
    FOREIGN KEY ("playerId") REFERENCES "Player"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "MatchPlayer_cricketTeamId_fkey"
    FOREIGN KEY ("cricketTeamId") REFERENCES "CricketTeam"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
