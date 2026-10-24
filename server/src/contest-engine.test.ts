import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateContestFinancials,
  calculateContestPayouts,
  getMaxEntriesPerUser,
  getPayoutPercentagesForEntryCount,
  validatePayoutPercentages,
} from "./contest-engine";

test("calculates the documented 49-rupee contest commission exactly in paise", () => {
  assert.deepEqual(
    calculateContestFinancials(250, 4900n, 2000),
    {
      grossEntryRevenuePaise: 1_225_000n,
      commissionPaise: 245_000n,
      distributablePrizePaise: 980_000n,
    },
  );
});

test("adds only an explicitly configured sponsor contribution", () => {
  assert.deepEqual(
    calculateContestFinancials(250, 4900n, 2000, 20_000n),
    {
      grossEntryRevenuePaise: 1_225_000n,
      commissionPaise: 245_000n,
      distributablePrizePaise: 1_000_000n,
    },
  );
});

test("limits entries per user according to contest capacity", () => {
  assert.equal(getMaxEntriesPerUser(9), 1);
  assert.equal(getMaxEntriesPerUser(49), 1);
  assert.equal(getMaxEntriesPerUser(50), 6);
  assert.equal(getMaxEntriesPerUser(99), 6);
  assert.equal(getMaxEntriesPerUser(100), 25);
  assert.equal(getMaxEntriesPerUser(250), 25);
  assert.throws(() => getMaxEntriesPerUser(0), /positive integer/);
});

test("validates payout percentages and distributes paise deterministically", () => {
  assert.equal(validatePayoutPercentages([50, 30, 20]), true);
  assert.equal(validatePayoutPercentages([50, 30, 19]), false);
  const entries = [
    { entryId: "a", joinedAt: new Date(0), score: 10 },
    { entryId: "b", joinedAt: new Date(1), score: 9 },
    { entryId: "c", joinedAt: new Date(2), score: 8 },
  ];
  const payouts = calculateContestPayouts(entries, [50, 30, 20], 101n);
  assert.deepEqual(payouts.map(({ amountPaise }) => amountPaise), [51n, 30n, 20n]);
  assert.equal(payouts.reduce((sum, payout) => sum + payout.amountPaise, 0n), 101n);
});

test("top-percentage formats allocate the configured payout weights to the correct field percentage", () => {
  const topTen = getPayoutPercentagesForEntryCount(250, "TOP_10_PERCENT", Array(10).fill(10));
  assert.equal(topTen.length, 25);
  assert.deepEqual(topTen, Array(25).fill(4));
  const topTwenty = getPayoutPercentagesForEntryCount(250, "TOP_20_PERCENT", Array(20).fill(5));
  assert.equal(topTwenty.length, 50);
  assert.deepEqual(topTwenty, Array(50).fill(2));
  assert.deepEqual(
    getPayoutPercentagesForEntryCount(20, "TOP_10_PERCENT", [50, 30, 20]),
    [63, 37],
  );
});

test("ties share all payout positions occupied by the tied group; join time breaks remainder ties", () => {
  const entries = [
    { entryId: "later", joinedAt: new Date(1), score: 10 },
    { entryId: "earlier", joinedAt: new Date(0), score: 10 },
    { entryId: "third", joinedAt: new Date(2), score: 1 },
  ];
  const payouts = calculateContestPayouts(entries, [50, 30, 20], 101n);
  assert.deepEqual(payouts, [
    { entryId: "earlier", rank: 1, amountPaise: 41n },
    { entryId: "later", rank: 1, amountPaise: 40n },
    { entryId: "third", rank: 3, amountPaise: 20n },
  ]);
});
