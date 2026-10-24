DROP INDEX IF EXISTS "ContestEntry_contestId_userId_key";

CREATE INDEX "ContestEntry_contestId_userId_idx"
ON "ContestEntry"("contestId", "userId");
