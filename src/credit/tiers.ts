import { prisma } from "../prisma";

export interface TierInfo {
  name: string;
  displayName: string;
  minScore: number;
  maxScore: number;
  controlStatus: string;
  requireAdvanceHours: number;
  maxDailyReservations: number;
  allowPeakTime: boolean;
  maxGroupSize: number;
}

export async function getTierByScore(
  score: number,
  skipBlacklist = false,
): Promise<TierInfo | null> {
  const tiers = await prisma.creditTier.findMany({
    orderBy: { minScore: "desc" },
  });
  for (const tier of tiers) {
    if (skipBlacklist && tier.controlStatus === "blacklist") continue;
    if (tier.minScore <= score && tier.maxScore >= score) {
      return {
        name: tier.name,
        displayName: tier.displayName,
        minScore: tier.minScore,
        maxScore: tier.maxScore,
        controlStatus: tier.controlStatus,
        requireAdvanceHours: tier.requireAdvanceHours,
        maxDailyReservations: tier.maxDailyReservations,
        allowPeakTime: tier.allowPeakTime,
        maxGroupSize: tier.maxGroupSize,
      };
    }
  }
  return null;
}

export async function refreshAccountTier(
  accountId: number,
): Promise<{ controlStatus: string; creditLevel: string }> {
  const account = await prisma.creditAccount.findUnique({
    where: { id: accountId },
  });
  if (!account) throw new Error("Account not found");

  const activeBlacklist = await prisma.blacklistRecord.findFirst({
    where: {
      accountId,
      status: "active",
      startAt: { lte: new Date() },
      endAt: { gt: new Date() },
    },
  });

  if (activeBlacklist) {
    const updated = await prisma.creditAccount.update({
      where: { id: accountId },
      data: { controlStatus: "blacklist", creditLevel: "blacklist" },
    });
    return {
      controlStatus: updated.controlStatus,
      creditLevel: updated.creditLevel,
    };
  }

  const tier = await getTierByScore(account.creditScore, true);
  if (!tier) {
    return {
      controlStatus: account.controlStatus,
      creditLevel: account.creditLevel,
    };
  }

  const updated = await prisma.creditAccount.update({
    where: { id: accountId },
    data: { controlStatus: tier.controlStatus, creditLevel: tier.name },
  });
  return {
    controlStatus: updated.controlStatus,
    creditLevel: updated.creditLevel,
  };
}

export async function getAllTiers(): Promise<TierInfo[]> {
  const tiers = await prisma.creditTier.findMany({
    orderBy: { minScore: "desc" },
  });
  return tiers.map((t) => ({
    name: t.name,
    displayName: t.displayName,
    minScore: t.minScore,
    maxScore: t.maxScore,
    controlStatus: t.controlStatus,
    requireAdvanceHours: t.requireAdvanceHours,
    maxDailyReservations: t.maxDailyReservations,
    allowPeakTime: t.allowPeakTime,
    maxGroupSize: t.maxGroupSize,
  }));
}
