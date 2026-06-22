import { config } from "./config";
import { hashPassword } from "./auth";
import { prisma } from "./prisma";

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function hoursAgo(n: number): Date {
  const d = new Date();
  d.setHours(d.getHours() - n);
  return d;
}

async function seedCreditRules() {
  const count = await prisma.creditRule.count();
  if (count > 0) return;

  await prisma.creditRule.createMany({
    data: [
      {
        code: "VISIT_VERIFIED_BASE",
        name: "按时到馆核销奖励",
        description: "用户按时到馆核销，奖励5分",
        eventType: "visit_verified",
        enabled: true,
        priority: 10,
        conditions: "{}",
        actionDelta: 5,
        actionExtra: "{}",
      },
      {
        code: "CONSECUTIVE_KEEP_3",
        name: "连续3次守约额外奖励",
        description: "连续守约满3次，额外奖励3分",
        eventType: "consecutive_keep",
        enabled: true,
        priority: 10,
        conditions: '{"minConsecutiveKeep":3}',
        actionDelta: 3,
        actionExtra: '{"stopAfterMatch":true}',
      },
      {
        code: "CONSECUTIVE_KEEP_5",
        name: "连续5次守约额外奖励",
        description: "连续守约满5次，额外奖励5分",
        eventType: "consecutive_keep",
        enabled: true,
        priority: 20,
        conditions: '{"minConsecutiveKeep":5}',
        actionDelta: 5,
        actionExtra: '{"stopAfterMatch":true}',
      },
      {
        code: "NO_SHOW_BASE",
        name: "爽约扣分",
        description: "个人爽约扣15分",
        eventType: "no_show",
        enabled: true,
        priority: 10,
        conditions: "{}",
        actionDelta: -15,
        actionExtra: '{"maxPenalty":-30}',
      },
      {
        code: "GROUP_NO_SHOW_BASE",
        name: "团体爽约重罚",
        description: "5人及以上团体爽约，基础扣20分，每超1人加扣3分",
        eventType: "group_no_show",
        enabled: true,
        priority: 10,
        conditions: '{"minGroupSize":5}',
        actionDelta: -20,
        actionExtra:
          '{"multiplier":{"field":"groupSize","factor":-3,"threshold":5},"maxPenalty":-50}',
      },
      {
        code: "CANCEL_LATE",
        name: "临时取消少量扣分",
        description: "预约时段前24小时内取消，扣3分",
        eventType: "cancel",
        enabled: true,
        priority: 20,
        conditions: '{"maxCancelAdvanceHours":24}',
        actionDelta: -3,
        actionExtra: '{"stopAfterMatch":true}',
      },
      {
        code: "CANCEL_VERY_LATE",
        name: "极晚取消较重扣分",
        description: "预约时段前6小时内取消，扣8分",
        eventType: "cancel",
        enabled: true,
        priority: 30,
        conditions: '{"maxCancelAdvanceHours":6}',
        actionDelta: -8,
        actionExtra: '{"stopAfterMatch":true}',
      },
      {
        code: "CANCEL_NORMAL",
        name: "正常取消不扣分",
        description: "提前超过24小时取消，不扣分",
        eventType: "cancel",
        enabled: true,
        priority: 10,
        conditions: '{"minCancelAdvanceHours":24}',
        actionDelta: 0,
        actionExtra: '{"stopAfterMatch":true}',
      },
    ],
  });
  console.log("seed credit rules done");
}

async function seedCreditTiers() {
  const count = await prisma.creditTier.count();
  if (count > 0) return;

  await prisma.creditTier.createMany({
    data: [
      {
        name: "excellent",
        displayName: "优秀",
        minScore: 90,
        maxScore: 100,
        controlStatus: "normal",
        requireAdvanceHours: 0,
        maxDailyReservations: 10,
        allowPeakTime: true,
        maxGroupSize: 20,
      },
      {
        name: "normal",
        displayName: "正常",
        minScore: 70,
        maxScore: 89,
        controlStatus: "normal",
        requireAdvanceHours: 0,
        maxDailyReservations: 5,
        allowPeakTime: true,
        maxGroupSize: 10,
      },
      {
        name: "restricted",
        displayName: "受限",
        minScore: 40,
        maxScore: 69,
        controlStatus: "restricted",
        requireAdvanceHours: 24,
        maxDailyReservations: 2,
        allowPeakTime: false,
        maxGroupSize: 3,
      },
      {
        name: "warning",
        displayName: "警告",
        minScore: 0,
        maxScore: 39,
        controlStatus: "restricted",
        requireAdvanceHours: 48,
        maxDailyReservations: 1,
        allowPeakTime: false,
        maxGroupSize: 2,
      },
      {
        name: "blacklist",
        displayName: "黑名单",
        minScore: -1,
        maxScore: -1,
        controlStatus: "blacklist",
        requireAdvanceHours: 0,
        maxDailyReservations: 0,
        allowPeakTime: false,
        maxGroupSize: 0,
      },
    ],
  });
  console.log("seed credit tiers done");
}

async function seedCreditAccounts() {
  const count = await prisma.creditAccount.count();
  if (count > 0) return;

  await prisma.creditAccount.createMany({
    data: [
      {
        phone: "13800001111",
        visitorName: "张敏",
        creditScore: 100,
        creditLevel: "excellent",
        controlStatus: "normal",
        consecutiveKeep: 5,
      },
      {
        phone: "13800002222",
        visitorName: "李伟",
        creditScore: 85,
        creditLevel: "normal",
        controlStatus: "normal",
        consecutiveKeep: 2,
      },
      {
        phone: "13800003333",
        visitorName: "王芳",
        creditScore: 55,
        creditLevel: "restricted",
        controlStatus: "restricted",
        consecutiveKeep: 0,
      },
      {
        phone: "13800004444",
        visitorName: "赵强",
        creditScore: 25,
        creditLevel: "warning",
        controlStatus: "restricted",
        consecutiveKeep: 0,
      },
      {
        phone: "13800005555",
        visitorName: "陈刚",
        creditScore: 0,
        creditLevel: "blacklist",
        controlStatus: "blacklist",
        consecutiveKeep: 0,
      },
      {
        phone: "13800006666",
        visitorName: "刘华",
        creditScore: 95,
        creditLevel: "excellent",
        controlStatus: "normal",
        consecutiveKeep: 8,
      },
      {
        phone: "13800007777",
        visitorName: "孙丽",
        creditScore: 75,
        creditLevel: "normal",
        controlStatus: "normal",
        consecutiveKeep: 1,
      },
      {
        phone: "13800008888",
        visitorName: "周杰",
        creditScore: 60,
        creditLevel: "restricted",
        controlStatus: "restricted",
        consecutiveKeep: 0,
      },
    ],
  });
  console.log("seed credit accounts done");
}

async function seedHistoricalReservations() {
  const count = await prisma.reservation.count();
  if (count > 50) return;

  const museums = await prisma.museum.findMany();
  if (museums.length === 0) return;

  const accounts = await prisma.creditAccount.findMany();
  const accountMap = new Map(accounts.map((a) => [a.phone, a]));

  const reservations: Array<{
    museumId: number;
    visitorName: string;
    phone: string;
    visitDate: string;
    timeSlot: string;
    passType: string;
    groupSize: number;
    status: string;
    createdAt?: Date;
    verifiedAt?: Date | null;
    cancelledAt?: Date | null;
  }> = [];

  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = (() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  })();

  const museum = museums[0];
  {
    reservations.push({
      museumId: museum.id,
      visitorName: "张敏",
      phone: "13800001111",
      visitDate: daysAgo(5),
      timeSlot: "am",
      passType: "annual",
      groupSize: 2,
      status: "visited",
      createdAt: hoursAgo(24 * 5 + 20),
      verifiedAt: hoursAgo(24 * 5 + 4),
    });

    reservations.push({
      museumId: museum.id,
      visitorName: "张敏",
      phone: "13800001111",
      visitDate: daysAgo(3),
      timeSlot: "pm",
      passType: "annual",
      groupSize: 1,
      status: "visited",
      createdAt: hoursAgo(24 * 3 + 20),
      verifiedAt: hoursAgo(24 * 3 + 6),
    });

    reservations.push({
      museumId: museum.id,
      visitorName: "王芳",
      phone: "13800003333",
      visitDate: daysAgo(10),
      timeSlot: "am",
      passType: "single",
      groupSize: 1,
      status: "no_show",
      createdAt: hoursAgo(24 * 10 + 20),
    });

    reservations.push({
      museumId: museum.id,
      visitorName: "王芳",
      phone: "13800003333",
      visitDate: daysAgo(7),
      timeSlot: "pm",
      passType: "single",
      groupSize: 1,
      status: "no_show",
      createdAt: hoursAgo(24 * 7 + 20),
    });

    reservations.push({
      museumId: museum.id,
      visitorName: "赵强",
      phone: "13800004444",
      visitDate: daysAgo(14),
      timeSlot: "am",
      passType: "single",
      groupSize: 6,
      status: "no_show",
      createdAt: hoursAgo(24 * 14 + 20),
    });

    reservations.push({
      museumId: museum.id,
      visitorName: "赵强",
      phone: "13800004444",
      visitDate: daysAgo(5),
      timeSlot: "pm",
      passType: "single",
      groupSize: 1,
      status: "no_show",
      createdAt: hoursAgo(24 * 5 + 20),
    });

    reservations.push({
      museumId: museum.id,
      visitorName: "陈刚",
      phone: "13800005555",
      visitDate: daysAgo(20),
      timeSlot: "am",
      passType: "single",
      groupSize: 8,
      status: "no_show",
      createdAt: hoursAgo(24 * 20 + 20),
    });

    reservations.push({
      museumId: museum.id,
      visitorName: "陈刚",
      phone: "13800005555",
      visitDate: daysAgo(12),
      timeSlot: "pm",
      passType: "single",
      groupSize: 1,
      status: "no_show",
      createdAt: hoursAgo(24 * 12 + 20),
    });

    reservations.push({
      museumId: museum.id,
      visitorName: "陈刚",
      phone: "13800005555",
      visitDate: daysAgo(6),
      timeSlot: "am",
      passType: "single",
      groupSize: 1,
      status: "no_show",
      createdAt: hoursAgo(24 * 6 + 20),
    });

    reservations.push({
      museumId: museum.id,
      visitorName: "李伟",
      phone: "13800002222",
      visitDate: daysAgo(2),
      timeSlot: "am",
      passType: "single",
      groupSize: 1,
      status: "visited",
      createdAt: hoursAgo(24 * 2 + 20),
      verifiedAt: hoursAgo(24 * 2 + 4),
    });

    reservations.push({
      museumId: museum.id,
      visitorName: "孙丽",
      phone: "13800007777",
      visitDate: daysAgo(4),
      timeSlot: "pm",
      passType: "single",
      groupSize: 2,
      status: "cancelled",
      createdAt: hoursAgo(24 * 4 + 20),
      cancelledAt: hoursAgo(24 * 4 + 15),
    });

    reservations.push({
      museumId: museum.id,
      visitorName: "刘华",
      phone: "13800006666",
      visitDate: daysAgo(1),
      timeSlot: "am",
      passType: "annual",
      groupSize: 4,
      status: "visited",
      createdAt: hoursAgo(24 * 1 + 20),
      verifiedAt: hoursAgo(24 * 1 + 3),
    });

    reservations.push({
      museumId: museum.id,
      visitorName: "周杰",
      phone: "13800008888",
      visitDate: daysAgo(8),
      timeSlot: "am",
      passType: "single",
      groupSize: 1,
      status: "no_show",
      createdAt: hoursAgo(24 * 8 + 20),
    });

    reservations.push({
      museumId: museum.id,
      visitorName: "周杰",
      phone: "13800008888",
      visitDate: tomorrow,
      timeSlot: "pm",
      passType: "single",
      groupSize: 1,
      status: "booked",
    });

    reservations.push({
      museumId: museum.id,
      visitorName: "张敏",
      phone: "13800001111",
      visitDate: tomorrow,
      timeSlot: "am",
      passType: "annual",
      groupSize: 2,
      status: "booked",
    });
  }

  const todayBookings: Array<{
    museumId: number;
    visitorName: string;
    phone: string;
    visitDate: string;
    timeSlot: string;
    passType: string;
    groupSize: number;
    status: string;
    createdAt?: Date;
    verifiedAt?: Date | null;
    cancelledAt?: Date | null;
  }> = [
    {
      museumId: museums[0].id,
      visitorName: "张敏",
      phone: "13800001111",
      visitDate: today,
      timeSlot: "am",
      passType: "annual",
      groupSize: 2,
      status: "booked",
    },
    {
      museumId: museums[0].id,
      visitorName: "李伟",
      phone: "13800002222",
      visitDate: today,
      timeSlot: "pm",
      passType: "single",
      groupSize: 1,
      status: "visited",
    },
    {
      museumId: museums[1].id,
      visitorName: "王芳",
      phone: "13800003333",
      visitDate: today,
      timeSlot: "am",
      passType: "single",
      groupSize: 1,
      status: "booked",
    },
  ];

  const allData = [...reservations, ...todayBookings].map((r) => ({
    museumId: r.museumId,
    visitorName: r.visitorName,
    phone: r.phone,
    visitDate: r.visitDate,
    timeSlot: r.timeSlot,
    passType: r.passType,
    groupSize: r.groupSize,
    status: r.status,
    createdAt: r.createdAt,
    verifiedAt: r.verifiedAt,
    cancelledAt: r.cancelledAt,
  }));

  const created = await prisma.reservation.createMany({ data: allData });
  console.log(`seed ${created.count} historical reservations done`);
}

async function seedCreditLogs() {
  const count = await prisma.creditLog.count();
  if (count > 0) return;

  const accounts = await prisma.creditAccount.findMany();

  const logDefs: Array<{
    phone: string;
    changeType: string;
    delta: number;
    beforeScore: number;
    afterScore: number;
    reason: string;
    ruleCode?: string;
    hoursAgo: number;
    matchStatus?: string;
    matchIndex?: number;
  }> = [
    { phone: "13800001111", changeType: "visit_verified", delta: 5, beforeScore: 95, afterScore: 100, reason: "按时到馆核销奖励", ruleCode: "VISIT_VERIFIED_BASE", hoursAgo: 24 * 3, matchStatus: "visited", matchIndex: 0 },
    { phone: "13800001111", changeType: "consecutive_keep", delta: 5, beforeScore: 95, afterScore: 100, reason: "连续5次守约额外奖励", ruleCode: "CONSECUTIVE_KEEP_5", hoursAgo: 24 * 3, matchStatus: "visited", matchIndex: 0 },
    { phone: "13800003333", changeType: "no_show", delta: -15, beforeScore: 85, afterScore: 70, reason: "爽约扣分", ruleCode: "NO_SHOW_BASE", hoursAgo: 24 * 10, matchStatus: "no_show", matchIndex: 0 },
    { phone: "13800003333", changeType: "no_show", delta: -15, beforeScore: 70, afterScore: 55, reason: "爽约扣分", ruleCode: "NO_SHOW_BASE", hoursAgo: 24 * 7, matchStatus: "no_show", matchIndex: 1 },
    { phone: "13800004444", changeType: "group_no_show", delta: -23, beforeScore: 100, afterScore: 77, reason: "团体爽约重罚", ruleCode: "GROUP_NO_SHOW_BASE", hoursAgo: 24 * 14, matchStatus: "no_show", matchIndex: 0 },
    { phone: "13800004444", changeType: "no_show", delta: -15, beforeScore: 77, afterScore: 62, reason: "爽约扣分", ruleCode: "NO_SHOW_BASE", hoursAgo: 24 * 10, matchStatus: "no_show", matchIndex: 1 },
    { phone: "13800004444", changeType: "no_show", delta: -15, beforeScore: 62, afterScore: 47, reason: "爽约扣分", ruleCode: "NO_SHOW_BASE", hoursAgo: 24 * 8, matchStatus: "no_show", matchIndex: 2 },
    { phone: "13800004444", changeType: "no_show", delta: -15, beforeScore: 47, afterScore: 32, reason: "爽约扣分", ruleCode: "NO_SHOW_BASE", hoursAgo: 24 * 5, matchStatus: "no_show", matchIndex: 3 },
    { phone: "13800004444", changeType: "credit_recover", delta: 5, beforeScore: 20, afterScore: 25, reason: "每30天良好表现信用恢复", ruleCode: "TIME_RECOVER", hoursAgo: 24 * 2 },
    { phone: "13800005555", changeType: "group_no_show", delta: -29, beforeScore: 100, afterScore: 71, reason: "团体爽约重罚", ruleCode: "GROUP_NO_SHOW_BASE", hoursAgo: 24 * 20, matchStatus: "no_show", matchIndex: 0 },
    { phone: "13800005555", changeType: "no_show", delta: -15, beforeScore: 71, afterScore: 56, reason: "爽约扣分", ruleCode: "NO_SHOW_BASE", hoursAgo: 24 * 15, matchStatus: "no_show", matchIndex: 1 },
    { phone: "13800005555", changeType: "no_show", delta: -15, beforeScore: 56, afterScore: 41, reason: "爽约扣分", ruleCode: "NO_SHOW_BASE", hoursAgo: 24 * 12, matchStatus: "no_show", matchIndex: 2 },
    { phone: "13800005555", changeType: "no_show", delta: -15, beforeScore: 41, afterScore: 26, reason: "爽约扣分", ruleCode: "NO_SHOW_BASE", hoursAgo: 24 * 9, matchStatus: "no_show", matchIndex: 3 },
    { phone: "13800005555", changeType: "no_show", delta: -15, beforeScore: 26, afterScore: 11, reason: "爽约扣分", ruleCode: "NO_SHOW_BASE", hoursAgo: 24 * 6, matchStatus: "no_show", matchIndex: 4 },
    { phone: "13800005555", changeType: "no_show", delta: -11, beforeScore: 11, afterScore: 0, reason: "爽约扣分", ruleCode: "NO_SHOW_BASE", hoursAgo: 24 * 3, matchStatus: "no_show", matchIndex: 5 },
    { phone: "13800008888", changeType: "no_show", delta: -15, beforeScore: 90, afterScore: 75, reason: "爽约扣分", ruleCode: "NO_SHOW_BASE", hoursAgo: 24 * 12, matchStatus: "no_show", matchIndex: 0 },
    { phone: "13800008888", changeType: "no_show", delta: -15, beforeScore: 75, afterScore: 60, reason: "爽约扣分", ruleCode: "NO_SHOW_BASE", hoursAgo: 24 * 8, matchStatus: "no_show", matchIndex: 1 },
  ];

  const accountMap = new Map(accounts.map((a) => [a.phone, a]));
  const logs: Array<{
    accountId: number;
    reservationId?: number;
    changeType: string;
    delta: number;
    beforeScore: number;
    afterScore: number;
    reason: string;
    ruleCode?: string;
    createdAt: Date;
  }> = [];

  for (const def of logDefs) {
    const acc = accountMap.get(def.phone);
    if (!acc) continue;

    let reservationId: number | undefined;
    if (def.matchStatus) {
      const reservations = await prisma.reservation.findMany({
        where: { phone: def.phone, status: def.matchStatus },
        orderBy: { id: "asc" },
      });
      const idx = def.matchIndex ?? 0;
      if (reservations[idx]) {
        reservationId = reservations[idx].id;
      }
    }

    logs.push({
      accountId: acc.id,
      reservationId,
      changeType: def.changeType,
      delta: def.delta,
      beforeScore: def.beforeScore,
      afterScore: def.afterScore,
      reason: def.reason,
      ruleCode: def.ruleCode,
      createdAt: hoursAgo(def.hoursAgo),
    });
  }

  await prisma.creditLog.createMany({ data: logs });
  console.log(`seed ${logs.length} credit logs done`);
}

async function seedBlacklist() {
  const count = await prisma.blacklistRecord.count();
  if (count > 0) return;

  const blacklistAcc = await prisma.creditAccount.findUnique({
    where: { phone: "13800005555" },
  });
  if (!blacklistAcc) return;

  const now = new Date();
  await prisma.blacklistRecord.create({
    data: {
      accountId: blacklistAcc.id,
      reason: "多次爽约，信用分降至0，自动加入黑名单",
      startAt: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000),
      endAt: new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000),
      status: "active",
    },
  });
  console.log("seed blacklist done");
}

async function seedAppeals() {
  const count = await prisma.creditAppeal.count();
  if (count > 0) return;

  const wangFang = await prisma.creditAccount.findUnique({
    where: { phone: "13800003333" },
  });
  if (!wangFang) return;

  const noShowReservation = await prisma.reservation.findFirst({
    where: { phone: "13800003333", status: "no_show" },
    orderBy: { id: "desc" },
  });

  await prisma.creditAppeal.create({
    data: {
      accountId: wangFang.id,
      reservationId: noShowReservation?.id,
      reason: "当日因突发疾病未能前往，有医院挂号记录为证",
      evidence: "已上传医院挂号截图",
      status: "pending",
    },
  });
  console.log("seed appeals done");
}

async function seed() {
  const adminExists = await prisma.user.findUnique({
    where: { username: config.defaultAdmin.username },
  });
  if (!adminExists) {
    await prisma.user.create({
      data: {
        username: config.defaultAdmin.username,
        passwordHash: hashPassword(config.defaultAdmin.password),
        displayName: "平台管理员",
      },
    });
  }

  const museumCount = await prisma.museum.count();
  if (museumCount === 0) {
    await prisma.$transaction([
      prisma.museum.create({
        data: {
          name: "金陵历史博物馆",
          address: "中山东路 321 号",
          dailyCapacity: 800,
          status: "open",
        },
      }),
      prisma.museum.create({
        data: {
          name: "德基艺术博物馆",
          address: "中山路 18 号",
          dailyCapacity: 500,
          status: "open",
        },
      }),
      prisma.museum.create({
        data: {
          name: "黄河文化主题馆",
          address: "滨河大道 9 号",
          dailyCapacity: 600,
          status: "maintenance",
        },
      }),
      prisma.museum.create({
        data: {
          name: "近代工业遗产馆",
          address: "工农路 77 号",
          dailyCapacity: 300,
          status: "open",
        },
      }),
    ]);
  }

  await seedCreditRules();
  await seedCreditTiers();
  await seedCreditAccounts();
  await seedHistoricalReservations();
  await seedCreditLogs();
  await seedBlacklist();
  await seedAppeals();

  console.log("seed done");
}

seed()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
