-- Separate deposited funds from winnings.
ALTER TABLE "Wallet"
  ADD COLUMN "depositedBalanceMinor" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "winningsBalanceMinor" BIGINT NOT NULL DEFAULT 0;

-- Prevent duplicate payment references, ignoring case and surrounding spaces.
CREATE UNIQUE INDEX "DepositRequest_paymentReference_normalized_key"
  ON "DepositRequest" (lower(trim("paymentReference")));
