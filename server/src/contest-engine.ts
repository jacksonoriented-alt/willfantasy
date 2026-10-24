export type ContestRankedEntry = {
  entryId: string;
  joinedAt: Date;
  score: number;
};

export type ContestPayout = {
  entryId: string;
  rank: number;
  amountPaise: bigint;
};

export type ContestFinancials = {
  grossEntryRevenuePaise: bigint;
  commissionPaise: bigint;
  distributablePrizePaise: bigint;
};

export function validatePayoutPercentages(value: unknown): value is number[] {
  return Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 100 &&
    value.every((percentage) =>
      Number.isInteger(percentage) && percentage >= 0 && percentage <= 100
    ) &&
    value.reduce((sum, percentage) => sum + percentage, 0) === 100;
}

export function getPayoutPositionCount(entryCount: number, type: string) {
  if (type === "TOP_10_PERCENT") return Math.floor((entryCount + 9) / 10);
  if (type === "TOP_20_PERCENT") return Math.floor((entryCount + 4) / 5);
  return 0;
}

export function getPayoutPercentagesForEntryCount(
  entryCount: number,
  type: string,
  configuredPercentages: number[],
) {
  if (!Number.isSafeInteger(entryCount) || entryCount < 0) {
    throw new Error("Entry count must be a non-negative safe integer.");
  }
  if (!validatePayoutPercentages(configuredPercentages)) {
    throw new Error("Payout percentages must be whole numbers that total exactly 100.");
  }
  if (type !== "TOP_10_PERCENT" && type !== "TOP_20_PERCENT") {
    return configuredPercentages.slice(0, Math.min(entryCount, configuredPercentages.length));
  }
  const positions = Math.min(100, getPayoutPositionCount(entryCount, type));
  if (positions === 0) return [];
  const weights = Array.from(
    { length: positions },
    (_, index) => configuredPercentages[index % configuredPercentages.length] ?? 0,
  );
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  const payouts = weights.map((weight, index) => ({
    index,
    percentage: Math.floor(weight * 100 / weightTotal),
    remainder: (weight * 100) % weightTotal,
  }));
  const remaining = 100 - payouts.reduce((sum, payout) => sum + payout.percentage, 0);
  for (const payout of [...payouts]
    .sort((left, right) => right.remainder - left.remainder || left.index - right.index)
    .slice(0, remaining)) {
    const target = payouts[payout.index];
    if (target) target.percentage += 1;
  }
  return payouts.map((payout) => payout.percentage);
}

export function getMaxEntriesPerUser(capacity: number) {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new Error("Contest capacity must be a positive integer.");
  }
  if (capacity < 50) return 1;
  if (capacity < 100) return 6;
  return 25;
}

export function calculateContestFinancials(
  paidEntries: number,
  entryFeePaise: bigint,
  commissionBps: number,
  sponsorContributionPaise = 0n,
): ContestFinancials {
  if (!Number.isSafeInteger(paidEntries) || paidEntries < 0) {
    throw new Error("Paid entry count must be a non-negative safe integer.");
  }
  if (entryFeePaise < 0n || sponsorContributionPaise < 0n) {
    throw new Error("Contest amounts cannot be negative.");
  }
  if (!Number.isInteger(commissionBps) || commissionBps < 0 || commissionBps > 10000) {
    throw new Error("Commission must be an integer basis-point rate from 0 to 10000.");
  }

  const grossEntryRevenuePaise = BigInt(paidEntries) * entryFeePaise;
  const commissionPaise = grossEntryRevenuePaise * BigInt(commissionBps) / 10000n;
  return {
    grossEntryRevenuePaise,
    commissionPaise,
    distributablePrizePaise:
      grossEntryRevenuePaise - commissionPaise + sponsorContributionPaise,
  };
}

export function calculateContestPayouts(
  rankedEntries: ContestRankedEntry[],
  payoutPercentages: number[],
  prizePoolPaise: bigint,
): ContestPayout[] {
  if (!validatePayoutPercentages(payoutPercentages)) {
    throw new Error("Payout percentages must be whole numbers that total exactly 100.");
  }
  if (prizePoolPaise < 0n) throw new Error("Prize pool cannot be negative.");
  if (rankedEntries.length === 0) return [];

  const winnersCount = Math.min(rankedEntries.length, payoutPercentages.length);
  const eligiblePercentages = payoutPercentages.slice(0, winnersCount);
  const eligibleTotal = eligiblePercentages.reduce((sum, value) => sum + value, 0);
  if (eligibleTotal === 0) return [];

  const normalizedShares = eligiblePercentages.map((share, index) => ({
    index,
    share: BigInt(share) * 10000n / BigInt(eligibleTotal),
    remainder: BigInt(share) * 10000n % BigInt(eligibleTotal),
  }));
  const normalizedRemainder = 10000n -
    normalizedShares.reduce((sum, item) => sum + item.share, 0n);
  for (let index = 0; BigInt(index) < normalizedRemainder; index += 1) {
    const target = [...normalizedShares].sort((a, b) =>
      a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1
    )[index];
    if (target) target.share += 1n;
  }

  const ranked = [...rankedEntries].sort((a, b) =>
    b.score - a.score ||
    a.joinedAt.getTime() - b.joinedAt.getTime() ||
    a.entryId.localeCompare(b.entryId)
  );
  const allocations: {
    entry: ContestRankedEntry;
    rank: number;
    amountPaise: bigint;
    remainder: bigint;
    denominator: bigint;
  }[] = [];
  let allocated = 0n;

  for (let index = 0; index < winnersCount;) {
    let tiedThrough = index;
    while (
      tiedThrough + 1 < winnersCount &&
      ranked[tiedThrough + 1]?.score === ranked[index]?.score
    ) {
      tiedThrough += 1;
    }

    const groupShares = normalizedShares
      .slice(index, tiedThrough + 1)
      .reduce((sum, item) => sum + item.share, 0n);
    const denominator = 10000n * BigInt(tiedThrough - index + 1);

    for (let offset = index; offset <= tiedThrough; offset += 1) {
      const entry = ranked[offset];
      if (!entry) continue;
      const numerator = prizePoolPaise * groupShares;
      const amountPaise = numerator / denominator;
      allocations.push({
        entry,
        rank: index + 1,
        amountPaise,
        remainder: numerator % denominator,
        denominator,
      });
      allocated += amountPaise;
    }
    index = tiedThrough + 1;
  }

  const remainderOrder = [...allocations].sort((a, b) => {
    const left = a.remainder * b.denominator;
    const right = b.remainder * a.denominator;
    if (left !== right) return left > right ? -1 : 1;
    return a.entry.joinedAt.getTime() - b.entry.joinedAt.getTime() ||
      a.entry.entryId.localeCompare(b.entry.entryId);
  });
  for (let index = 0; allocated < prizePoolPaise && index < remainderOrder.length; index += 1) {
    const allocation = remainderOrder[index];
    if (!allocation) break;
    allocation.amountPaise += 1n;
    allocated += 1n;
  }

  return allocations.map(({ entry, rank, amountPaise }) => ({
    entryId: entry.entryId,
    rank,
    amountPaise,
  })).sort((a, b) =>
    a.rank - b.rank ||
    ranked.findIndex((entry) => entry.entryId === a.entryId) -
      ranked.findIndex((entry) => entry.entryId === b.entryId)
  );
}
