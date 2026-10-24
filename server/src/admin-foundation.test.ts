import assert from "node:assert/strict";
import test from "node:test";
import { calculateFinancialMetrics } from "./admin-foundation";

test("financial reporting excludes pending deposits and wallet liabilities from profit", () => {
  const metrics = calculateFinancialMetrics({
    approvedDepositsMinor: 12_250n,
    pendingDepositsMinor: 4_900n,
    grossContestEntryFeesMinor: 1_225_000n,
    refundsMinor: 4_900n,
    platformCommissionMinor: 245_000n,
    expensesMinor: 20_000n,
    walletBalanceMinor: 50_000n,
    walletReservedMinor: 15_000n,
  });

  assert.equal(metrics.approvedDepositsMinor, 12_250n);
  assert.equal(metrics.pendingDepositsMinor, 4_900n);
  assert.equal(metrics.netProfitMinor, 225_000n);
  assert.equal(metrics.walletLiabilityMinor, 65_000n);
  assert.equal(metrics.netProfitMinor, metrics.platformCommissionMinor - metrics.expensesMinor);
});
