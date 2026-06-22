import { prisma } from "../prisma";
import { applyCreditChanges } from "./engine";
import { RuleContext } from "./types";
import { refreshAccountTier, getTierByScore } from "./tiers";

export async function getOrCreateCreditAccount(
  phone: string,
  visitorName = "",
) {
  let account = await prisma.creditAccount.findUnique({ where: { phone } });
  if (!account) {
    account = await prisma.creditAccount.create({
      data: { phone, visitorName },
    });
  } else if (!account.visitorName && visitorName) {
    account = await prisma.creditAccount.update({
      where: { id: account.id },
      data: { visitorName },
    });
  }
  return account;
}

function getSlotEndDateTime(visitDate: string, timeSlot: string): Date {
  const [year, month, day] = visitDate.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  if (timeSlot === "am") {
    date.setHours(12, 0, 0, 0);
  } else {
    date.setHours(18, 0, 0, 0);
  }
  return date;
}

function hoursUntilSlotEnd(visitDate: string, timeSlot: string): number {
  const end = getSlotEndDateTime(visitDate, timeSlot).getTime();
  const now = Date.now();
  return Math.max(0, (end - now) / (1000 * 60 * 60));
}

export async function cancelReservation(
  reservationId: number,
  operatorId?: number,
) {
  const reservation = await prisma.reservation.findUnique({
    where: { id: reservationId },
    include: { museum: true },
  });
  if (!reservation) throw new Error("预约不存在");
  if (reservation.status !== "booked") {
    throw new Error("只有已预约状态可以取消");
  }

  const advanceHours = hoursUntilSlotEnd(
    reservation.visitDate,
    reservation.timeSlot,
  );
  const account = await getOrCreateCreditAccount(
    reservation.phone,
    reservation.visitorName,
  );

  const ctx: RuleContext = {
    accountId: account.id,
    phone: account.phone,
    reservationId: reservation.id,
    cancelAdvanceHours: advanceHours,
    operatorId,
  };

  await prisma.$transaction(async (tx) => {
    await tx.reservation.update({
      where: { id: reservationId },
      data: { status: "cancelled", cancelledAt: new Date() },
    });
  });

  await applyCreditChanges("cancel", ctx, "cancel");
  await refreshAccountTier(account.id);
  await notifyCreditChange(account.id, "cancel");

  return { reservationId, advanceHours };
}

export async function verifyReservation(
  reservationId: number,
  operatorId?: number,
) {
  const reservation = await prisma.reservation.findUnique({
    where: { id: reservationId },
  });
  if (!reservation) throw new Error("预约不存在");
  if (reservation.status !== "booked") {
    throw new Error("只有已预约状态可以核销");
  }

  const account = await getOrCreateCreditAccount(
    reservation.phone,
    reservation.visitorName,
  );

  const ctx: RuleContext = {
    accountId: account.id,
    phone: account.phone,
    reservationId: reservation.id,
    groupSize: reservation.groupSize,
    operatorId,
  };

  await prisma.$transaction(async (tx) => {
    await tx.reservation.update({
      where: { id: reservationId },
      data: { status: "visited", verifiedAt: new Date() },
    });
  });

  const result = await applyCreditChanges(
    "visit_verified",
    ctx,
    "visit_verified",
  );

  const updatedAccount = await prisma.creditAccount.findUnique({
    where: { id: account.id },
  });
  if (updatedAccount) {
    const keepCtx: RuleContext = {
      accountId: account.id,
      phone: account.phone,
      reservationId: reservation.id,
      consecutiveKeep: updatedAccount.consecutiveKeep,
      operatorId,
    };
    await applyCreditChanges("consecutive_keep", keepCtx, "consecutive_keep");
  }

  await refreshAccountTier(account.id);
  await notifyCreditChange(account.id, "visit_verified");

  return result;
}

export interface NoShowBatchResult {
  batchId: number;
  visitDate: string;
  timeSlot: string;
  totalCount: number;
  processedCount: number;
}

export async function processNoShowBatch(
  visitDate: string,
  timeSlot: string,
  triggeredBy: "system" | "manual" = "system",
  operatorId?: number,
): Promise<NoShowBatchResult> {
  const slotEnd = getSlotEndDateTime(visitDate, timeSlot);
  if (Date.now() < slotEnd.getTime()) {
    throw new Error("预约时段尚未结束，无法判定爽约");
  }

  const pending = await prisma.reservation.findMany({
    where: {
      visitDate,
      timeSlot,
      status: "booked",
    },
    include: { museum: true },
  });

  const batch = await prisma.noShowBatch.create({
    data: {
      visitDate,
      timeSlot,
      totalCount: pending.length,
      processedCount: 0,
      triggeredBy,
      operatorId,
      status: "processing",
    },
  });

  let processed = 0;

  for (const reservation of pending) {
    try {
      const account = await getOrCreateCreditAccount(
        reservation.phone,
        reservation.visitorName,
      );

      const eventType =
        reservation.groupSize >= 5 ? "group_no_show" : "no_show";
      const ctx: RuleContext = {
        accountId: account.id,
        phone: account.phone,
        reservationId: reservation.id,
        groupSize: reservation.groupSize,
        operatorId,
      };

      await prisma.$transaction(async (tx) => {
        await tx.reservation.update({
          where: { id: reservation.id },
          data: { status: "no_show", noShowBatchId: batch.id },
        });
      });

      await applyCreditChanges(eventType, ctx, eventType);
      await refreshAccountTier(account.id);
      await autoBlacklistCheck(account.id, operatorId);
      await notifyCreditChange(account.id, eventType);

      processed++;
    } catch (err) {
      console.error(`处理预约 ${reservation.id} 爽约失败:`, err);
    }
  }

  const finalBatch = await prisma.noShowBatch.update({
    where: { id: batch.id },
    data: { processedCount: processed, status: "done", finishedAt: new Date() },
  });

  return {
    batchId: finalBatch.id,
    visitDate: finalBatch.visitDate,
    timeSlot: finalBatch.timeSlot,
    totalCount: finalBatch.totalCount,
    processedCount: finalBatch.processedCount,
  };
}

export async function autoBlacklistCheck(
  accountId: number,
  operatorId?: number,
) {
  const account = await prisma.creditAccount.findUnique({
    where: { id: accountId },
  });
  if (!account) return;

  if (account.creditScore > 0) return;

  const existingActive = await prisma.blacklistRecord.findFirst({
    where: { accountId, status: "active" },
  });
  if (existingActive) return;

  const startAt = new Date();
  const endAt = new Date(startAt.getTime() + 7 * 24 * 60 * 60 * 1000);

  await prisma.blacklistRecord.create({
    data: {
      accountId,
      reason: "信用分降至0，自动加入黑名单7天",
      startAt,
      endAt,
      status: "active",
      operatorId,
    },
  });

  await refreshAccountTier(accountId);
}

export async function addToBlacklist(
  accountId: number,
  reason: string,
  days: number,
  operatorId?: number,
) {
  const startAt = new Date();
  const endAt = new Date(startAt.getTime() + days * 24 * 60 * 60 * 1000);

  const record = await prisma.blacklistRecord.create({
    data: {
      accountId,
      reason,
      startAt,
      endAt,
      status: "active",
      operatorId,
    },
  });

  await refreshAccountTier(accountId);
  return record;
}

export async function releaseBlacklist(
  recordId: number,
  releaseType: "expired" | "manual",
  releaseNote?: string,
  operatorId?: number,
) {
  const record = await prisma.blacklistRecord.findUnique({
    where: { id: recordId },
  });
  if (!record) throw new Error("黑名单记录不存在");

  const updated = await prisma.blacklistRecord.update({
    where: { id: recordId },
    data: {
      status: "released",
      releasedAt: new Date(),
      releaseType,
      releaseNote,
      operatorId,
    },
  });

  await refreshAccountTier(record.accountId);
  return updated;
}

export async function checkExpiredBlacklists() {
  const now = new Date();
  const expired = await prisma.blacklistRecord.findMany({
    where: {
      status: "active",
      endAt: { lte: now },
    },
  });

  for (const record of expired) {
    await releaseBlacklist(record.id, "expired", "黑名单期限届满自动解除");
  }

  return expired.length;
}

export async function recoverCreditByTime() {
  const accounts = await prisma.creditAccount.findMany({
    where: { creditScore: { lt: 100 } },
  });

  const recovered: number[] = [];
  const now = new Date();

  for (const acc of accounts) {
    const lastRecover = acc.lastRecoverAt ?? acc.createdAt;
    const daysSince = Math.floor(
      (now.getTime() - lastRecover.getTime()) / (24 * 60 * 60 * 1000),
    );

    if (daysSince >= 30 && acc.creditScore < 100) {
      const recoverAmount = Math.min(5, 100 - acc.creditScore);
      const beforeScore = acc.creditScore;
      const afterScore = acc.creditScore + recoverAmount;

      await prisma.$transaction(async (tx) => {
        await tx.creditLog.create({
          data: {
            accountId: acc.id,
            changeType: "credit_recover",
            delta: recoverAmount,
            beforeScore,
            afterScore,
            reason: "每30天良好表现信用恢复",
            ruleCode: "TIME_RECOVER",
          },
        });
        await tx.creditAccount.update({
          where: { id: acc.id },
          data: { creditScore: afterScore, lastRecoverAt: now },
        });
      });

      await refreshAccountTier(acc.id);
      recovered.push(acc.id);
    }
  }

  return recovered;
}

export async function submitAppeal(
  accountId: number,
  reservationId: number | null,
  reason: string,
  evidence = "",
) {
  const appeal = await prisma.creditAppeal.create({
    data: {
      accountId,
      reservationId: reservationId ?? undefined,
      reason,
      evidence,
      status: "pending",
    },
  });

  if (reservationId) {
    await prisma.reservation.update({
      where: { id: reservationId },
      data: { appealId: appeal.id },
    });
  }

  return appeal;
}

export async function reviewAppeal(
  appealId: number,
  approved: boolean,
  reviewNote: string,
  reviewerId?: number,
) {
  const appeal = await prisma.creditAppeal.findUnique({
    where: { id: appealId },
    include: { account: true },
  });
  if (!appeal) throw new Error("申诉不存在");
  if (appeal.status !== "pending") throw new Error("申诉已处理");

  await prisma.creditAppeal.update({
    where: { id: appealId },
    data: {
      status: approved ? "approved" : "rejected",
      reviewNote,
      reviewerId,
      reviewedAt: new Date(),
    },
  });

  if (approved && appeal.reservationId) {
    const reservation = await prisma.reservation.findUnique({
      where: { id: appeal.reservationId },
    });

    if (reservation && reservation.status === "no_show") {
      const noShowLogs = await prisma.creditLog.findMany({
        where: {
          accountId: appeal.accountId,
          reservationId: appeal.reservationId,
          changeType: { in: ["no_show", "group_no_show"] },
        },
        orderBy: { createdAt: "desc" },
      });

      if (noShowLogs.length > 0) {
        const totalDelta = noShowLogs.reduce(
          (s, l) => s + Math.abs(l.delta),
          0,
        );
        const currentScore = appeal.account.creditScore;
        const beforeScore = currentScore;
        const afterScore = Math.min(100, currentScore + totalDelta);

        await prisma.$transaction(async (tx) => {
          await tx.creditLog.create({
            data: {
              accountId: appeal.accountId,
              reservationId: appeal.reservationId,
              changeType: "appeal_revert",
              delta: afterScore - beforeScore,
              beforeScore,
              afterScore,
              reason: `申诉通过撤销爽约扣分（申诉#${appealId}）`,
              ruleCode: "APPEAL_REVERT",
              operatorId: reviewerId,
            },
          });
          await tx.creditAccount.update({
            where: { id: appeal.accountId },
            data: { creditScore: afterScore },
          });
          await tx.reservation.update({
            where: { id: appeal.reservationId! },
            data: { status: "appealed" },
          });
        });

        await refreshAccountTier(appeal.accountId);
        await notifyCreditChange(appeal.accountId, "appeal_revert");
      }
    }
  }

  return { appealId, approved };
}

export async function notifyCreditChange(accountId: number, type: string) {
  const account = await prisma.creditAccount.findUnique({
    where: { id: accountId },
  });
  if (!account) return;

  const titles: Record<string, string> = {
    no_show: "爽约扣分通知",
    group_no_show: "团体爽约严重扣分通知",
    cancel: "预约取消信用处理",
    visit_verified: "守约信用奖励",
    consecutive_keep: "连续守约奖励",
    credit_recover: "信用分恢复通知",
    appeal_revert: "申诉通过，信用分已恢复",
  };

  const contents: Record<string, string> = {
    no_show: `您有一次预约未按时到馆核销，已扣除相应信用分。当前信用分：${account.creditScore}`,
    group_no_show: `您的团体预约未按时到馆核销，已从重扣除信用分。当前信用分：${account.creditScore}`,
    cancel: `您已取消预约，根据取消提前时间处理信用。当前信用分：${account.creditScore}`,
    visit_verified: `您已按时到馆参观，获得信用奖励。当前信用分：${account.creditScore}`,
    consecutive_keep: `恭喜您保持连续守约，获得额外信用奖励。当前信用分：${account.creditScore}`,
    credit_recover: `由于近期良好表现，您的信用分已恢复。当前信用分：${account.creditScore}`,
    appeal_revert: `您的申诉已通过，爽约扣分已撤销，信用分已恢复。当前信用分：${account.creditScore}`,
  };

  await prisma.creditNotification.create({
    data: {
      accountId,
      type,
      title: titles[type] || "信用变动通知",
      content:
        contents[type] ||
        `您的信用分发生变动，当前信用分：${account.creditScore}`,
    },
  });
}

export interface BookingCheckResult {
  allowed: boolean;
  reason?: string;
  tier?: {
    name: string;
    displayName: string;
    requireAdvanceHours: number;
    maxDailyReservations: number;
    allowPeakTime: boolean;
    maxGroupSize: number;
  };
}

export async function checkBookingEligibility(
  phone: string,
  visitDate: string,
  timeSlot: string,
  groupSize = 1,
): Promise<BookingCheckResult> {
  const account = await prisma.creditAccount.findUnique({ where: { phone } });

  if (!account) {
    return { allowed: true };
  }

  await checkExpiredBlacklists();
  const refreshed = await prisma.creditAccount.findUnique({
    where: { id: account.id },
  });
  if (!refreshed) return { allowed: true };

  if (refreshed.controlStatus === "blacklist") {
    return { allowed: false, reason: "您已被列入黑名单，暂时无法预约" };
  }

  const tier = await getTierByScore(refreshed.creditScore, true);
  if (!tier) return { allowed: true };

  const result: BookingCheckResult = {
    allowed: true,
    tier: {
      name: tier.name,
      displayName: tier.displayName,
      requireAdvanceHours: tier.requireAdvanceHours,
      maxDailyReservations: tier.maxDailyReservations,
      allowPeakTime: tier.allowPeakTime,
      maxGroupSize: tier.maxGroupSize,
    },
  };

  if (tier.requireAdvanceHours > 0) {
    const [y, m, d] = visitDate.split("-").map(Number);
    const visitStart = new Date(y, m - 1, d, timeSlot === "am" ? 9 : 14, 0, 0);
    const hoursUntilVisit = Math.max(
      0,
      (visitStart.getTime() - Date.now()) / (1000 * 60 * 60),
    );
    if (hoursUntilVisit < tier.requireAdvanceHours) {
      result.allowed = false;
      result.reason = `您的信用等级需要至少提前${tier.requireAdvanceHours}小时预约`;
      return result;
    }
  }

  if (!tier.allowPeakTime) {
    const peakSlots = ["am"];
    if (peakSlots.includes(timeSlot)) {
      result.allowed = false;
      result.reason = "您的信用等级暂不可预约热门时段（上午场）";
      return result;
    }
  }

  if (tier.maxGroupSize > 0 && groupSize > tier.maxGroupSize) {
    result.allowed = false;
    result.reason = `您的信用等级最多可预约${tier.maxGroupSize}人的团体票`;
    return result;
  }

  const todayCount = await prisma.reservation.count({
    where: {
      phone,
      visitDate,
      status: { not: "cancelled" },
    },
  });
  if (
    tier.maxDailyReservations > 0 &&
    todayCount >= tier.maxDailyReservations
  ) {
    result.allowed = false;
    result.reason = `您的信用等级每日最多可预约${tier.maxDailyReservations}次`;
    return result;
  }

  return result;
}
