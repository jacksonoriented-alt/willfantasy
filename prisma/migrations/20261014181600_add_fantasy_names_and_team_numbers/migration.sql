ALTER TABLE "User" ADD COLUMN "fantasyName" TEXT;

UPDATE "User" SET "fantasyName" = "displayName" WHERE "fantasyName" IS NULL;

ALTER TABLE "User" ALTER COLUMN "fantasyName" SET NOT NULL;

ALTER TABLE "FantasyTeam" ADD COLUMN "teamNumber" INTEGER;

WITH numbered_teams AS (
    SELECT
        "id",
        ROW_NUMBER() OVER (
            PARTITION BY "userId", "matchId"
            ORDER BY "createdAt", "id"
        ) AS team_number
    FROM "FantasyTeam"
)
UPDATE "FantasyTeam"
SET "teamNumber" = numbered_teams.team_number
FROM numbered_teams
WHERE "FantasyTeam"."id" = numbered_teams."id";

ALTER TABLE "FantasyTeam" ALTER COLUMN "teamNumber" SET NOT NULL;

UPDATE "FantasyTeam" SET "name" = 'Team ' || "teamNumber";

CREATE UNIQUE INDEX "FantasyTeam_userId_matchId_teamNumber_key"
ON "FantasyTeam"("userId", "matchId", "teamNumber");
