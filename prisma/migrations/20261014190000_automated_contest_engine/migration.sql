ALTER TABLE "Contest"
  ADD COLUMN "sourceType" TEXT NOT NULL DEFAULT 'MEGA',
  ADD COLUMN "templateId" TEXT,
  ADD COLUMN "instanceNumber" INTEGER,
  ADD COLUMN "entryFeePaise" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "commissionBps" INTEGER NOT NULL DEFAULT 2000,
  ADD COLUMN "prizePercentages" JSONB,
  ADD COLUMN "sponsorContributionPaise" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "prizePoolPaise" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "targetPrizePoolPaise" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "startsAt" TIMESTAMP(3),
  ADD COLUMN "registrationDeadline" TIMESTAMP(3),
  ADD COLUMN "publishedAt" TIMESTAMP(3),
  ADD COLUMN "settledAt" TIMESTAMP(3);

UPDATE "Contest" AS contest
SET
  "entryFeePaise" = contest."entryFee"::BIGINT * 100,
  "prizePoolPaise" = contest."prizePool"::BIGINT * 100,
  "startsAt" = match."startsAt",
  "publishedAt" = contest."createdAt",
  "prizePercentages" = CASE contest."type"
    WHEN 'WINNER_TAKES_ALL' THEN '[100]'::jsonb
    WHEN 'TOP_3' THEN '[50,30,20]'::jsonb
    WHEN 'TOP_5' THEN '[40,25,15,10,10]'::jsonb
    WHEN 'TOP_10' THEN '[25,15,10,10,8,7,6,6,6,7]'::jsonb
    WHEN 'HEAD_TO_HEAD' THEN '[100]'::jsonb
    ELSE '[10,10,10,10,10,10,10,10,10,10]'::jsonb
  END
FROM "Match" AS match
WHERE match."id" = contest."matchId";

CREATE TABLE "ContestTemplate" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "entryFeePaise" BIGINT NOT NULL,
  "entryFeeCredits" INTEGER NOT NULL,
  "capacity" INTEGER NOT NULL,
  "contestFormat" TEXT NOT NULL,
  "commissionBps" INTEGER NOT NULL DEFAULT 2000,
  "payoutPercentages" JSONB NOT NULL,
  "minimumEntriesToOpen" INTEGER NOT NULL DEFAULT 2,
  "registrationLeadMinutes" INTEGER NOT NULL DEFAULT 15,
  "openWindowMinutes" INTEGER NOT NULL DEFAULT 10080,
  "matchEligibility" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ContestTemplate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ContestEngineSetting" (
  "id" INTEGER NOT NULL DEFAULT 1,
  "autoGenerationEnabled" BOOLEAN NOT NULL DEFAULT true,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ContestEngineSetting_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ContestGenerationRun" (
  "id" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "scanned" INTEGER NOT NULL DEFAULT 0,
  "created" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'RUNNING',
  "error" TEXT,
  CONSTRAINT "ContestGenerationRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ContestFinancialEntry" (
  "id" TEXT NOT NULL,
  "contestId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "amountPaise" BIGINT NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'INR',
  "idempotencyKey" TEXT NOT NULL,
  "demoOnly" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ContestFinancialEntry_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ContestPayout" (
  "id" TEXT NOT NULL,
  "contestId" TEXT NOT NULL,
  "entryId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "amountPaise" BIGINT NOT NULL,
  "amountCredits" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ContestPayout_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ContestTemplate_code_key" ON "ContestTemplate"("code");
CREATE INDEX "ContestGenerationRun_startedAt_idx" ON "ContestGenerationRun"("startedAt");
CREATE UNIQUE INDEX "ContestFinancialEntry_idempotencyKey_key" ON "ContestFinancialEntry"("idempotencyKey");
CREATE INDEX "ContestFinancialEntry_contestId_createdAt_idx" ON "ContestFinancialEntry"("contestId", "createdAt");
CREATE UNIQUE INDEX "ContestPayout_contestId_entryId_key" ON "ContestPayout"("contestId", "entryId");
CREATE INDEX "ContestPayout_userId_createdAt_idx" ON "ContestPayout"("userId", "createdAt");
CREATE UNIQUE INDEX "Contest_templateId_matchId_instanceNumber_key" ON "Contest"("templateId", "matchId", "instanceNumber");

ALTER TABLE "Contest" ADD CONSTRAINT "Contest_templateId_fkey"
  FOREIGN KEY ("templateId") REFERENCES "ContestTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ContestFinancialEntry" ADD CONSTRAINT "ContestFinancialEntry_contestId_fkey"
  FOREIGN KEY ("contestId") REFERENCES "Contest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ContestPayout" ADD CONSTRAINT "ContestPayout_contestId_fkey"
  FOREIGN KEY ("contestId") REFERENCES "Contest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ContestPayout" ADD CONSTRAINT "ContestPayout_entryId_fkey"
  FOREIGN KEY ("entryId") REFERENCES "ContestEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ContestPayout" ADD CONSTRAINT "ContestPayout_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "ContestFinancialEntry"
  ("id", "contestId", "type", "amountPaise", "currency", "idempotencyKey", "demoOnly")
SELECT
  md5(entry."id" || ':gross'),
  entry."contestId",
  'ENTRY_GROSS',
  contest."entryFeePaise",
  'INR',
  'entry:' || entry."id" || ':gross',
  true
FROM "ContestEntry" AS entry
JOIN "Contest" AS contest ON contest."id" = entry."contestId"
UNION ALL
SELECT
  md5(entry."id" || ':commission'),
  entry."contestId",
  'PLATFORM_COMMISSION',
  contest."entryFeePaise" * contest."commissionBps" / 10000,
  'INR',
  'entry:' || entry."id" || ':commission',
  true
FROM "ContestEntry" AS entry
JOIN "Contest" AS contest ON contest."id" = entry."contestId"
UNION ALL
SELECT
  md5(entry."id" || ':prize'),
  entry."contestId",
  'PRIZE_CONTRIBUTION',
  contest."entryFeePaise" - contest."entryFeePaise" * contest."commissionBps" / 10000,
  'INR',
  'entry:' || entry."id" || ':prize',
  true
FROM "ContestEntry" AS entry
JOIN "Contest" AS contest ON contest."id" = entry."contestId";

INSERT INTO "ContestEngineSetting" ("id", "autoGenerationEnabled", "updatedAt")
VALUES (1, true, CURRENT_TIMESTAMP);

INSERT INTO "ContestTemplate"
  ("id", "code", "name", "enabled", "entryFeePaise", "entryFeeCredits", "capacity", "contestFormat", "commissionBps", "payoutPercentages", "minimumEntriesToOpen", "registrationLeadMinutes", "openWindowMinutes", "matchEligibility", "updatedAt")
VALUES
  ('template-19-quick-clash', 'QUICK_CLASH_19', '₹19 Quick Clash', true, 1900, 19, 20, 'TOP_3', 2000, '[50,30,20]'::jsonb, 2, 15, 10080, '{"matchStatuses":["UPCOMING"]}'::jsonb, CURRENT_TIMESTAMP),
  ('template-49-winner', 'WINNER_TAKES_ALL_49', '₹49 Winner Takes All', true, 4900, 49, 250, 'WINNER_TAKES_ALL', 2000, '[100]'::jsonb, 2, 15, 10080, '{"matchStatuses":["UPCOMING"]}'::jsonb, CURRENT_TIMESTAMP),
  ('template-70-top10', 'TOP_10_SHOWDOWN_70', '₹70 Top 10 Showdown', true, 7000, 70, 100, 'TOP_10', 2000, '[25,15,10,10,8,7,6,6,6,7]'::jsonb, 2, 15, 10080, '{"matchStatuses":["UPCOMING"]}'::jsonb, CURRENT_TIMESTAMP),
  ('template-100-power-play', 'POWER_PLAY_100', '₹100 Power Play', true, 10000, 100, 100, 'TOP_10', 2000, '[25,15,10,10,8,7,6,6,6,7]'::jsonb, 2, 15, 10080, '{"matchStatuses":["UPCOMING"]}'::jsonb, CURRENT_TIMESTAMP),
  ('template-250-high-stakes', 'HIGH_STAKES_250', '₹250 High Stakes', true, 25000, 250, 50, 'TOP_5', 2000, '[40,25,15,10,10]'::jsonb, 2, 15, 10080, '{"matchStatuses":["UPCOMING"]}'::jsonb, CURRENT_TIMESTAMP),
  ('template-500-elite', 'ELITE_CHALLENGE_500', '₹500 Elite Challenge', true, 50000, 500, 20, 'TOP_3', 2000, '[50,30,20]'::jsonb, 2, 15, 10080, '{"matchStatuses":["UPCOMING"]}'::jsonb, CURRENT_TIMESTAMP);
