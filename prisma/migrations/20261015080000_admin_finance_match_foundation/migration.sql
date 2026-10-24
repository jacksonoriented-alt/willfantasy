-- This is additive: existing users, matches, teams, contests, and history are preserved.
CREATE TYPE "UserRole" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'CASH_AGENT', 'PAYOUT_OPERATOR', 'USER');
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DEACTIVATED');
CREATE TYPE "DepositStatus" AS ENUM ('PENDING', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'ESCALATED', 'CANCELLED');
CREATE TYPE "WithdrawalStatus" AS ENUM ('PENDING', 'UNDER_REVIEW', 'APPROVED', 'PAID', 'REJECTED', 'CANCELLED');
CREATE TYPE "WalletEntryType" AS ENUM ('DEPOSIT', 'WITHDRAWAL', 'CONTEST_ENTRY', 'CONTEST_REFUND', 'PRIZE_PAYOUT', 'ADJUSTMENT');
CREATE TYPE "MatchDataStatus" AS ENUM ('READY', 'INCOMPLETE', 'PROVIDER_UNAVAILABLE');

ALTER TABLE "User"
  ADD COLUMN "role" "UserRole" NOT NULL DEFAULT 'USER',
  ADD COLUMN "accountStatus" "AccountStatus" NOT NULL DEFAULT 'ACTIVE';

ALTER TABLE "Match"
  ADD COLUMN "provider" TEXT,
  ADD COLUMN "externalFixtureId" TEXT,
  ADD COLUMN "competition" TEXT,
  ADD COLUMN "format" TEXT,
  ADD COLUMN "isEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "isSuspended" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "archivedAt" TIMESTAMP(3),
  ADD COLUMN "dataStatus" "MatchDataStatus" NOT NULL DEFAULT 'PROVIDER_UNAVAILABLE',
  ADD COLUMN "lastSyncedAt" TIMESTAMP(3),
  ADD COLUMN "syncError" TEXT;

CREATE TABLE "MatchParticipant" (
  "matchId" TEXT NOT NULL,
  "cricketTeamId" TEXT NOT NULL,
  CONSTRAINT "MatchParticipant_pkey" PRIMARY KEY ("matchId", "cricketTeamId")
);

CREATE TABLE "Wallet" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'INR',
  "balanceMinor" BIGINT NOT NULL DEFAULT 0,
  "reservedMinor" BIGINT NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WalletLedgerEntry" (
  "id" TEXT NOT NULL,
  "walletId" TEXT NOT NULL,
  "type" "WalletEntryType" NOT NULL,
  "amountMinor" BIGINT NOT NULL,
  "currency" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "reference" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WalletLedgerEntry_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DepositRequest" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "amountMinor" BIGINT NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'INR',
  "paymentMethod" TEXT NOT NULL,
  "paymentReference" TEXT NOT NULL,
  "paidAt" TIMESTAMP(3),
  "receiptObjectKey" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "providerTransactionId" TEXT,
  "status" "DepositStatus" NOT NULL DEFAULT 'PENDING',
  "assignedAgentId" TEXT,
  "decisionReason" TEXT,
  "verifiedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DepositRequest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WithdrawalRequest" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "amountMinor" BIGINT NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'INR',
  "payoutMethod" TEXT NOT NULL,
  "providerDestinationToken" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "providerPayoutId" TEXT,
  "status" "WithdrawalStatus" NOT NULL DEFAULT 'PENDING',
  "reviewedById" TEXT,
  "decisionReason" TEXT,
  "payoutReference" TEXT,
  "paidAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WithdrawalRequest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CashAgentProfile" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "transactionLimitMinor" BIGINT,
  "permissions" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CashAgentProfile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PlatformExpense" (
  "id" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "amountMinor" BIGINT NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'INR',
  "reference" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "notes" TEXT,
  "recordedById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlatformExpense_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AuditChainState" (
  "id" INTEGER NOT NULL DEFAULT 1,
  "lastSequence" INTEGER NOT NULL DEFAULT 0,
  "lastHash" TEXT NOT NULL DEFAULT '',
  CONSTRAINT "AuditChainState_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AuditEvent" (
  "sequence" INTEGER NOT NULL,
  "id" TEXT NOT NULL,
  "actorUserId" TEXT,
  "action" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT,
  "details" JSONB NOT NULL,
  "previousHash" TEXT NOT NULL,
  "eventHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Match_provider_externalFixtureId_key" ON "Match"("provider", "externalFixtureId");
CREATE INDEX "Match_isEnabled_startsAt_idx" ON "Match"("isEnabled", "startsAt");
CREATE INDEX "Wallet_currency_idx" ON "Wallet"("currency");
CREATE UNIQUE INDEX "Wallet_userId_currency_key" ON "Wallet"("userId", "currency");
CREATE UNIQUE INDEX "WalletLedgerEntry_idempotencyKey_key" ON "WalletLedgerEntry"("idempotencyKey");
CREATE INDEX "WalletLedgerEntry_walletId_createdAt_idx" ON "WalletLedgerEntry"("walletId", "createdAt");
CREATE INDEX "WalletLedgerEntry_type_createdAt_idx" ON "WalletLedgerEntry"("type", "createdAt");
CREATE UNIQUE INDEX "DepositRequest_idempotencyKey_key" ON "DepositRequest"("idempotencyKey");
CREATE UNIQUE INDEX "DepositRequest_providerTransactionId_key" ON "DepositRequest"("providerTransactionId");
CREATE INDEX "DepositRequest_status_createdAt_idx" ON "DepositRequest"("status", "createdAt");
CREATE INDEX "DepositRequest_userId_createdAt_idx" ON "DepositRequest"("userId", "createdAt");
CREATE INDEX "DepositRequest_assignedAgentId_status_idx" ON "DepositRequest"("assignedAgentId", "status");
CREATE INDEX "DepositRequest_paymentReference_idx" ON "DepositRequest"("paymentReference");
CREATE UNIQUE INDEX "WithdrawalRequest_idempotencyKey_key" ON "WithdrawalRequest"("idempotencyKey");
CREATE UNIQUE INDEX "WithdrawalRequest_providerPayoutId_key" ON "WithdrawalRequest"("providerPayoutId");
CREATE INDEX "WithdrawalRequest_status_createdAt_idx" ON "WithdrawalRequest"("status", "createdAt");
CREATE INDEX "WithdrawalRequest_userId_createdAt_idx" ON "WithdrawalRequest"("userId", "createdAt");
CREATE UNIQUE INDEX "CashAgentProfile_userId_key" ON "CashAgentProfile"("userId");
CREATE UNIQUE INDEX "PlatformExpense_idempotencyKey_key" ON "PlatformExpense"("idempotencyKey");
CREATE INDEX "PlatformExpense_currency_createdAt_idx" ON "PlatformExpense"("currency", "createdAt");
CREATE INDEX "PlatformExpense_category_createdAt_idx" ON "PlatformExpense"("category", "createdAt");
CREATE UNIQUE INDEX "AuditEvent_eventHash_key" ON "AuditEvent"("eventHash");
CREATE UNIQUE INDEX "AuditEvent_sequence_key" ON "AuditEvent"("sequence");
CREATE INDEX "AuditEvent_createdAt_idx" ON "AuditEvent"("createdAt");
CREATE INDEX "AuditEvent_actorUserId_createdAt_idx" ON "AuditEvent"("actorUserId", "createdAt");
CREATE INDEX "AuditEvent_entityType_entityId_idx" ON "AuditEvent"("entityType", "entityId");

ALTER TABLE "MatchParticipant" ADD CONSTRAINT "MatchParticipant_matchId_fkey"
  FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MatchParticipant" ADD CONSTRAINT "MatchParticipant_cricketTeamId_fkey"
  FOREIGN KEY ("cricketTeamId") REFERENCES "CricketTeam"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WalletLedgerEntry" ADD CONSTRAINT "WalletLedgerEntry_walletId_fkey"
  FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DepositRequest" ADD CONSTRAINT "DepositRequest_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DepositRequest" ADD CONSTRAINT "DepositRequest_assignedAgentId_fkey"
  FOREIGN KEY ("assignedAgentId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WithdrawalRequest" ADD CONSTRAINT "WithdrawalRequest_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WithdrawalRequest" ADD CONSTRAINT "WithdrawalRequest_reviewedById_fkey"
  FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CashAgentProfile" ADD CONSTRAINT "CashAgentProfile_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PlatformExpense" ADD CONSTRAINT "PlatformExpense_recordedById_fkey"
  FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_nonnegative_balances_check"
  CHECK ("balanceMinor" >= 0 AND "reservedMinor" >= 0);
ALTER TABLE "DepositRequest" ADD CONSTRAINT "DepositRequest_positive_amount_check"
  CHECK ("amountMinor" > 0);
ALTER TABLE "WithdrawalRequest" ADD CONSTRAINT "WithdrawalRequest_positive_amount_check"
  CHECK ("amountMinor" > 0);
ALTER TABLE "PlatformExpense" ADD CONSTRAINT "PlatformExpense_positive_amount_check"
  CHECK ("amountMinor" > 0);
