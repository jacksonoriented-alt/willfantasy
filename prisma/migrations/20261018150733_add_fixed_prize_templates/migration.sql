-- AlterTable
ALTER TABLE "Contest" ADD COLUMN     "fixedPrizeTiers" JSONB,
ADD COLUMN     "prizeMode" TEXT NOT NULL DEFAULT 'PERCENTAGE',
ADD COLUMN     "prizeTemplate" TEXT;
