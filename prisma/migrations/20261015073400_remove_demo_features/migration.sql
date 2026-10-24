DELETE FROM "ContestPayout";
DELETE FROM "ContestEntry";
DELETE FROM "ContestFinancialEntry";
UPDATE "Contest"
SET
  "status" = CASE
    WHEN "status" IN ('FULL', 'SETTLED') OR "settledAt" IS NOT NULL THEN 'CLOSED'
    ELSE "status"
  END,
  "settledAt" = NULL,
  "prizePool" = 0,
  "prizePoolPaise" = 0,
  "sponsorContributionPaise" = 0,
  "targetPrizePoolPaise" = 0;

DELETE FROM "FantasyTeam"
WHERE "matchId" IN (
  SELECT "id" FROM "Match" WHERE "title" = 'India vs Australia — Demo Match'
)
OR "userId" IN (
  SELECT "id" FROM "User" WHERE "email" = 'demo@willfantasy.local'
)
OR "id" IN (
  SELECT selection."fantasyTeamId"
  FROM "FantasyTeamPlayer" AS selection
  JOIN "Player" AS player ON player."id" = selection."playerId"
  WHERE player."name" LIKE 'Demo %'
);

DELETE FROM "Contest"
WHERE "matchId" IN (
  SELECT "id" FROM "Match" WHERE "title" = 'India vs Australia — Demo Match'
);
DELETE FROM "Match" WHERE "title" = 'India vs Australia — Demo Match';
DELETE FROM "Player" WHERE "name" LIKE 'Demo %';
DELETE FROM "User" WHERE "email" = 'demo@willfantasy.local';

DROP TABLE "WalletTransaction";

ALTER TABLE "User" DROP COLUMN "demoCredits";
ALTER TABLE "ContestTemplate" DROP COLUMN "entryFeeCredits";
ALTER TABLE "ContestFinancialEntry" DROP COLUMN "demoOnly";
ALTER TABLE "ContestPayout" DROP COLUMN "amountCredits";
