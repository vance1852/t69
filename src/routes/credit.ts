import { Router } from "express";
import { z } from "zod";

import { authMiddleware, AuthRequest } from "../auth";
import { prisma } from "../prisma";
import {
  getOrCreateCreditAccount,
  cancelReservation,
  verifyReservation,
  processNoShowBatch,
  addToBlacklist,
  releaseBlacklist,
  checkExpiredBlacklists,
  recoverCreditByTime,
  submitAppeal,
  reviewAppeal,
  checkBookingEligibility,
} from "../credit/service";
import { getAllTiers } from "../credit/tiers";
import { applyCreditChanges } from "../credit/engine";
import { RuleContext } from "../credit/types";
import { refreshAccountTier } from "../credit/tiers";

const router = Router();
router.use(authMiddleware);

// ========== 信用账户查询 ==========

const accountQuerySchema = z.object({
  phone: z.string().min(1).max(32),
});

router.get("/account", async (req, res) => {
  const parsed = accountQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(422).json({ detail: "请提供手机号" });
  }
  const account = await prisma.creditAccount.findUnique({
    where: { phone: parsed.data.phone },
    include: {
      blacklists: {
        where: { status: "active" },
        take: 1,
        orderBy: { createdAt: "desc" },
      },
    },
  });
  if (!account) {
    return res.status(404).json({ detail: "未找到该手机号的信用账户" });
  }
  res.json({
    id: account.id,
    phone: account.phone,
    visitor_name: account.visitorName,
    credit_score: account.creditScore,
    credit_level: account.creditLevel,
    control_status: account.controlStatus,
    consecutive_keep: account.consecutiveKeep,
    created_at: account.createdAt,
    active_blacklist:
      account.blacklists.length > 0
        ? {
            id: account.blacklists[0].id,
            reason: account.blacklists[0].reason,
            start_at: account.blacklists[0].startAt,
            end_at: account.blacklists[0].endAt,
          }
        : null,
  });
});

router.get("/accounts", async (_req, res) => {
  const accounts = await prisma.creditAccount.findMany({
    orderBy: { creditScore: "asc" },
    take: 200,
  });
  res.json(
    accounts.map((a) => ({
      id: a.id,
      phone: a.phone,
      visitor_name: a.visitorName,
      credit_score: a.creditScore,
      credit_level: a.creditLevel,
      control_status: a.controlStatus,
      consecutive_keep: a.consecutiveKeep,
    })),
  );
});

// ========== 信用流水查询 ==========

router.get("/logs", async (req, res) => {
  const where: Record<string, unknown> = {};
  if (req.query.phone) {
    const account = await prisma.creditAccount.findUnique({
      where: { phone: String(req.query.phone) },
    });
    if (!account) return res.json([]);
    where.accountId = account.id;
  }
  if (req.query.accountId) where.accountId = Number(req.query.accountId);
  if (req.query.changeType) where.changeType = String(req.query.changeType);

  const logs = await prisma.creditLog.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 200,
    include: {
      reservation: { select: { id: true, visitDate: true, timeSlot: true } },
    },
  });
  res.json(
    logs.map((l) => ({
      id: l.id,
      account_id: l.accountId,
      reservation_id: l.reservationId,
      reservation: l.reservation
        ? {
            id: l.reservation.id,
            visit_date: l.reservation.visitDate,
            time_slot: l.reservation.timeSlot,
          }
        : null,
      change_type: l.changeType,
      delta: l.delta,
      before_score: l.beforeScore,
      after_score: l.afterScore,
      reason: l.reason,
      rule_code: l.ruleCode,
      operator_id: l.operatorId,
      created_at: l.createdAt,
    })),
  );
});

// ========== 爽约批量判定 ==========

const noShowSchema = z.object({
  visit_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time_slot: z.enum(["am", "pm"]),
  triggered_by: z.enum(["system", "manual"]).optional().default("manual"),
});

router.post("/no-show/batch", async (req: AuthRequest, res) => {
  const parsed = noShowSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(422)
      .json({ detail: "参数不合法", errors: parsed.error.flatten() });
  }
  try {
    const result = await processNoShowBatch(
      parsed.data.visit_date,
      parsed.data.time_slot,
      parsed.data.triggered_by,
      req.user?.id,
    );
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "处理失败";
    res.status(422).json({ detail: msg });
  }
});

router.get("/no-show/batches", async (_req, res) => {
  const batches = await prisma.noShowBatch.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  res.json(
    batches.map((b) => ({
      id: b.id,
      visit_date: b.visitDate,
      time_slot: b.timeSlot,
      total_count: b.totalCount,
      processed_count: b.processedCount,
      triggered_by: b.triggeredBy,
      operator_id: b.operatorId,
      status: b.status,
      created_at: b.createdAt,
      finished_at: b.finishedAt,
    })),
  );
});

// ========== 预约核销与取消 ==========

router.post("/reservations/:id/verify", async (req: AuthRequest, res) => {
  try {
    const result = await verifyReservation(Number(req.params.id), req.user?.id);
    res.json({
      reservation_id: Number(req.params.id),
      final_score: result.finalScore,
      changes: result.changes,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "核销失败";
    res.status(422).json({ detail: msg });
  }
});

router.post("/reservations/:id/cancel", async (req: AuthRequest, res) => {
  try {
    const result = await cancelReservation(Number(req.params.id), req.user?.id);
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "取消失败";
    res.status(422).json({ detail: msg });
  }
});

// ========== 信用规则管理 ==========

const ruleSchema = z.object({
  code: z.string().min(1).max(64),
  name: z.string().min(1).max(128),
  description: z.string().max(512).optional().default(""),
  event_type: z.enum([
    "visit_verified",
    "no_show",
    "cancel",
    "consecutive_keep",
    "group_no_show",
    "credit_recover",
    "appeal_revert",
    "manual_adjust",
  ]),
  enabled: z.boolean().optional().default(true),
  priority: z.number().int().optional().default(0),
  conditions: z.record(z.unknown()).optional().default({}),
  action_delta: z.number().int(),
  action_extra: z.record(z.unknown()).optional().default({}),
});

router.get("/rules", async (_req, res) => {
  const rules = await prisma.creditRule.findMany({
    orderBy: { priority: "desc" },
  });
  res.json(
    rules.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      description: r.description,
      event_type: r.eventType,
      enabled: r.enabled,
      priority: r.priority,
      conditions: JSON.parse(r.conditions || "{}"),
      action_delta: r.actionDelta,
      action_extra: JSON.parse(r.actionExtra || "{}"),
    })),
  );
});

router.post("/rules", async (_req, res) => {
  const parsed = ruleSchema.safeParse(_req.body);
  if (!parsed.success) {
    return res
      .status(422)
      .json({ detail: "参数不合法", errors: parsed.error.flatten() });
  }
  const data = parsed.data;
  try {
    const created = await prisma.creditRule.create({
      data: {
        code: data.code,
        name: data.name,
        description: data.description,
        eventType: data.event_type,
        enabled: data.enabled,
        priority: data.priority,
        conditions: JSON.stringify(data.conditions),
        actionDelta: data.action_delta,
        actionExtra: JSON.stringify(data.action_extra),
      },
    });
    res.status(201).json({ id: created.id, code: created.code });
  } catch {
    res.status(422).json({ detail: "规则代码可能已存在" });
  }
});

router.put("/rules/:id", async (req, res) => {
  const parsed = ruleSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    return res.status(422).json({ detail: "参数不合法" });
  }
  const data = parsed.data;
  const update: Record<string, unknown> = {};
  if (data.name !== undefined) update.name = data.name;
  if (data.description !== undefined) update.description = data.description;
  if (data.event_type !== undefined) update.eventType = data.event_type;
  if (data.enabled !== undefined) update.enabled = data.enabled;
  if (data.priority !== undefined) update.priority = data.priority;
  if (data.conditions !== undefined)
    update.conditions = JSON.stringify(data.conditions);
  if (data.action_delta !== undefined) update.actionDelta = data.action_delta;
  if (data.action_extra !== undefined)
    update.actionExtra = JSON.stringify(data.action_extra);

  const updated = await prisma.creditRule.update({
    where: { id: Number(req.params.id) },
    data: update,
  });
  res.json({ id: updated.id, code: updated.code });
});

router.delete("/rules/:id", async (req, res) => {
  await prisma.creditRule.delete({ where: { id: Number(req.params.id) } });
  res.status(204).send();
});

// ========== 分级管控档位 ==========

const tierSchema = z.object({
  name: z.string().min(1).max(64),
  display_name: z.string().min(1).max(64),
  min_score: z.number().int().min(0).max(100),
  max_score: z.number().int().min(0).max(100),
  control_status: z
    .enum(["normal", "restricted", "blacklist"])
    .default("normal"),
  require_advance_hours: z.number().int().min(0).optional().default(0),
  max_daily_reservations: z.number().int().min(0).optional().default(5),
  allow_peak_time: z.boolean().optional().default(true),
  max_group_size: z.number().int().min(1).optional().default(10),
});

router.get("/tiers", async (_req, res) => {
  const tiers = await getAllTiers();
  res.json(
    tiers.map((t) => ({
      name: t.name,
      display_name: t.displayName,
      min_score: t.minScore,
      max_score: t.maxScore,
      control_status: t.controlStatus,
      require_advance_hours: t.requireAdvanceHours,
      max_daily_reservations: t.maxDailyReservations,
      allow_peak_time: t.allowPeakTime,
      max_group_size: t.maxGroupSize,
    })),
  );
});

router.post("/tiers", async (_req, res) => {
  const parsed = tierSchema.safeParse(_req.body);
  if (!parsed.success) {
    return res
      .status(422)
      .json({ detail: "参数不合法", errors: parsed.error.flatten() });
  }
  const d = parsed.data;
  try {
    const created = await prisma.creditTier.create({
      data: {
        name: d.name,
        displayName: d.display_name,
        minScore: d.min_score,
        maxScore: d.max_score,
        controlStatus: d.control_status,
        requireAdvanceHours: d.require_advance_hours,
        maxDailyReservations: d.max_daily_reservations,
        allowPeakTime: d.allow_peak_time,
        maxGroupSize: d.max_group_size,
      },
    });
    res.status(201).json({ id: created.id, name: created.name });
  } catch {
    res.status(422).json({ detail: "档位名称可能已存在" });
  }
});

router.put("/tiers/:id", async (req, res) => {
  const parsed = tierSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    return res.status(422).json({ detail: "参数不合法" });
  }
  const d = parsed.data;
  const update: Record<string, unknown> = {};
  if (d.display_name !== undefined) update.displayName = d.display_name;
  if (d.min_score !== undefined) update.minScore = d.min_score;
  if (d.max_score !== undefined) update.maxScore = d.max_score;
  if (d.control_status !== undefined) update.controlStatus = d.control_status;
  if (d.require_advance_hours !== undefined)
    update.requireAdvanceHours = d.require_advance_hours;
  if (d.max_daily_reservations !== undefined)
    update.maxDailyReservations = d.max_daily_reservations;
  if (d.allow_peak_time !== undefined) update.allowPeakTime = d.allow_peak_time;
  if (d.max_group_size !== undefined) update.maxGroupSize = d.max_group_size;

  const updated = await prisma.creditTier.update({
    where: { id: Number(req.params.id) },
    data: update,
  });
  res.json({ id: updated.id, name: updated.name });
});

// ========== 黑名单管理 ==========

const blacklistAddSchema = z.object({
  phone: z.string().min(1).max(32),
  reason: z.string().min(1).max(255),
  days: z.number().int().min(1),
});

router.get("/blacklists", async (req, res) => {
  const where: Record<string, unknown> = {};
  if (req.query.status) where.status = String(req.query.status);
  else where.status = "active";

  const records = await prisma.blacklistRecord.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { account: { select: { phone: true, visitorName: true } } },
  });
  res.json(
    records.map((r) => ({
      id: r.id,
      account_id: r.accountId,
      phone: r.account?.phone ?? "",
      visitor_name: r.account?.visitorName ?? "",
      reason: r.reason,
      start_at: r.startAt,
      end_at: r.endAt,
      status: r.status,
      released_at: r.releasedAt,
      release_type: r.releaseType,
      release_note: r.releaseNote,
      operator_id: r.operatorId,
      created_at: r.createdAt,
    })),
  );
});

router.post("/blacklists", async (req: AuthRequest, res) => {
  const parsed = blacklistAddSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(422)
      .json({ detail: "参数不合法", errors: parsed.error.flatten() });
  }
  const account = await getOrCreateCreditAccount(parsed.data.phone);
  const record = await addToBlacklist(
    account.id,
    parsed.data.reason,
    parsed.data.days,
    req.user?.id,
  );
  res.status(201).json({
    id: record.id,
    account_id: record.accountId,
    phone: parsed.data.phone,
    reason: record.reason,
    start_at: record.startAt,
    end_at: record.endAt,
  });
});

router.post("/blacklists/:id/release", async (req: AuthRequest, res) => {
  const note = req.body.release_note
    ? String(req.body.release_note)
    : "人工解除";
  try {
    const record = await releaseBlacklist(
      Number(req.params.id),
      "manual",
      note,
      req.user?.id,
    );
    res.json({ id: record.id, status: record.status });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "解除失败";
    res.status(422).json({ detail: msg });
  }
});

router.post("/blacklists/check-expired", async (_req, res) => {
  const count = await checkExpiredBlacklists();
  res.json({ released_count: count });
});

// ========== 申诉管理 ==========

const appealCreateSchema = z.object({
  phone: z.string().min(1).max(32),
  reservation_id: z.number().int().optional().nullable(),
  reason: z.string().min(1).max(512),
  evidence: z.string().optional().default(""),
});

const appealReviewSchema = z.object({
  approved: z.boolean(),
  review_note: z.string().min(1).max(512),
});

router.get("/appeals", async (req, res) => {
  const where: Record<string, unknown> = {};
  if (req.query.status) where.status = String(req.query.status);
  if (req.query.phone) {
    const account = await prisma.creditAccount.findUnique({
      where: { phone: String(req.query.phone) },
    });
    if (!account) return res.json([]);
    where.accountId = account.id;
  }

  const appeals = await prisma.creditAppeal.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 200,
    include: {
      account: { select: { phone: true, visitorName: true } },
      reservation: { select: { id: true, visitDate: true, timeSlot: true } },
    },
  });
  res.json(
    appeals.map((a) => ({
      id: a.id,
      account_id: a.accountId,
      phone: a.account?.phone ?? "",
      visitor_name: a.account?.visitorName ?? "",
      reservation_id: a.reservationId,
      reservation: a.reservation
        ? {
            id: a.reservation.id,
            visit_date: a.reservation.visitDate,
            time_slot: a.reservation.timeSlot,
          }
        : null,
      reason: a.reason,
      evidence: a.evidence,
      status: a.status,
      review_note: a.reviewNote,
      reviewer_id: a.reviewerId,
      reviewed_at: a.reviewedAt,
      created_at: a.createdAt,
    })),
  );
});

router.post("/appeals", async (_req, res) => {
  const parsed = appealCreateSchema.safeParse(_req.body);
  if (!parsed.success) {
    return res
      .status(422)
      .json({ detail: "参数不合法", errors: parsed.error.flatten() });
  }
  const account = await getOrCreateCreditAccount(parsed.data.phone);
  const appeal = await submitAppeal(
    account.id,
    parsed.data.reservation_id ?? null,
    parsed.data.reason,
    parsed.data.evidence,
  );
  res.status(201).json({
    id: appeal.id,
    account_id: appeal.accountId,
    reservation_id: appeal.reservationId,
    status: appeal.status,
  });
});

router.post("/appeals/:id/review", async (req: AuthRequest, res) => {
  const parsed = appealReviewSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(422)
      .json({ detail: "参数不合法", errors: parsed.error.flatten() });
  }
  try {
    const result = await reviewAppeal(
      Number(req.params.id),
      parsed.data.approved,
      parsed.data.review_note,
      req.user?.id,
    );
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "审核失败";
    res.status(422).json({ detail: msg });
  }
});

// ========== 信用恢复 ==========

router.post("/credit/recover/time-based", async (_req, res) => {
  const recovered = await recoverCreditByTime();
  res.json({ recovered_account_ids: recovered, count: recovered.length });
});

const adjustSchema = z.object({
  phone: z.string().min(1).max(32),
  delta: z.number().int(),
  reason: z.string().min(1).max(255),
});

router.post("/credit/adjust", async (req: AuthRequest, res) => {
  const parsed = adjustSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(422)
      .json({ detail: "参数不合法", errors: parsed.error.flatten() });
  }
  const account = await getOrCreateCreditAccount(parsed.data.phone);
  const beforeScore = account.creditScore;
  const afterScore = Math.max(
    0,
    Math.min(100, beforeScore + parsed.data.delta),
  );

  await prisma.$transaction(async (tx) => {
    await tx.creditLog.create({
      data: {
        accountId: account.id,
        changeType: "manual_adjust",
        delta: afterScore - beforeScore,
        beforeScore,
        afterScore,
        reason: parsed.data.reason,
        ruleCode: "MANUAL",
        operatorId: req.user?.id,
      },
    });
    await tx.creditAccount.update({
      where: { id: account.id },
      data: { creditScore: afterScore },
    });
  });

  await refreshAccountTier(account.id);
  res.json({
    phone: parsed.data.phone,
    before_score: beforeScore,
    after_score: afterScore,
    delta: afterScore - beforeScore,
  });
});

// ========== 预约信用拦截检查 ==========

const bookingCheckSchema = z.object({
  phone: z.string().min(1).max(32),
  visit_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time_slot: z.enum(["am", "pm"]),
  group_size: z.number().int().min(1).optional().default(1),
});

router.post("/booking/check", async (req, res) => {
  const parsed = bookingCheckSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(422)
      .json({ detail: "参数不合法", errors: parsed.error.flatten() });
  }
  const result = await checkBookingEligibility(
    parsed.data.phone,
    parsed.data.visit_date,
    parsed.data.time_slot,
    parsed.data.group_size,
  );
  res.json(result);
});

// ========== 信用通知 ==========

router.get("/notifications", async (req, res) => {
  const where: Record<string, unknown> = {};
  if (req.query.phone) {
    const account = await prisma.creditAccount.findUnique({
      where: { phone: String(req.query.phone) },
    });
    if (!account) return res.json([]);
    where.accountId = account.id;
  }
  const notifs = await prisma.creditNotification.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  res.json(
    notifs.map((n) => ({
      id: n.id,
      account_id: n.accountId,
      type: n.type,
      title: n.title,
      content: n.content,
      read_at: n.readAt,
      created_at: n.createdAt,
    })),
  );
});

router.post("/notifications/:id/read", async (_req, res) => {
  const notif = await prisma.creditNotification.update({
    where: { id: Number(_req.params.id) },
    data: { readAt: new Date() },
  });
  res.json({ id: notif.id, read_at: notif.readAt });
});

// ========== 统计 ==========

router.get("/stats/overview", async (_req, res) => {
  const [
    totalAccounts,
    normalCount,
    restrictedCount,
    blacklistCount,
    totalLogs,
    totalAppeals,
    pendingAppeals,
  ] = await Promise.all([
    prisma.creditAccount.count(),
    prisma.creditAccount.count({ where: { controlStatus: "normal" } }),
    prisma.creditAccount.count({ where: { controlStatus: "restricted" } }),
    prisma.creditAccount.count({ where: { controlStatus: "blacklist" } }),
    prisma.creditLog.count(),
    prisma.creditAppeal.count(),
    prisma.creditAppeal.count({ where: { status: "pending" } }),
  ]);

  const totalReservations = await prisma.reservation.count();
  const noShowCount = await prisma.reservation.count({
    where: { status: "no_show" },
  });
  const noShowRate =
    totalReservations > 0 ? (noShowCount / totalReservations) * 100 : 0;

  res.json({
    total_accounts: totalAccounts,
    normal_count: normalCount,
    restricted_count: restrictedCount,
    blacklist_count: blacklistCount,
    total_credit_logs: totalLogs,
    total_appeals: totalAppeals,
    pending_appeals: pendingAppeals,
    total_reservations: totalReservations,
    no_show_count: noShowCount,
    no_show_rate: Number(noShowRate.toFixed(2)),
  });
});

router.get("/stats/no-show-trend", async (_req, res) => {
  const last30Days: Array<{ date: string; booked: number; no_show: number }> =
    [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const [booked, noShow] = await Promise.all([
      prisma.reservation.count({ where: { visitDate: dateStr } }),
      prisma.reservation.count({
        where: { visitDate: dateStr, status: "no_show" },
      }),
    ]);
    last30Days.push({ date: dateStr, booked, no_show: noShow });
  }
  res.json(last30Days);
});

router.get("/stats/tier-distribution", async (_req, res) => {
  const tiers = await prisma.creditTier.findMany({
    orderBy: { minScore: "desc" },
  });
  const result = [];
  for (const tier of tiers) {
    const count = await prisma.creditAccount.count({
      where: {
        creditScore: { gte: tier.minScore, lte: tier.maxScore },
      },
    });
    result.push({
      name: tier.name,
      display_name: tier.displayName,
      min_score: tier.minScore,
      max_score: tier.maxScore,
      count,
    });
  }
  res.json(result);
});

export default router;
