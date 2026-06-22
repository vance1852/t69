import { prisma } from "../prisma";
import { CreditEventType, RuleContext, CreditChangeResult } from "./types";

function parseJsonSafe(str: string): Record<string, unknown> {
  try {
    return JSON.parse(str) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function matchCondition(
  conditions: Record<string, unknown>,
  ctx: RuleContext,
): boolean {
  if (!conditions || Object.keys(conditions).length === 0) return true;

  for (const [key, value] of Object.entries(conditions)) {
    switch (key) {
      case "minGroupSize":
        if ((ctx.groupSize ?? 1) < Number(value)) return false;
        break;
      case "maxCancelAdvanceHours":
        if (
          ctx.cancelAdvanceHours === undefined ||
          ctx.cancelAdvanceHours > Number(value)
        )
          return false;
        break;
      case "minCancelAdvanceHours":
        if (
          ctx.cancelAdvanceHours === undefined ||
          ctx.cancelAdvanceHours < Number(value)
        )
          return false;
        break;
      case "minConsecutiveKeep":
        if ((ctx.consecutiveKeep ?? 0) < Number(value)) return false;
        break;
      default:
        if (value !== null && value !== undefined) {
          const ctxVal =
            ctx.extra?.[key] ??
            (ctx as unknown as Record<string, unknown>)[key];
          if (ctxVal !== value) return false;
        }
    }
  }
  return true;
}

function computeDelta(
  baseDelta: number,
  actionExtra: Record<string, unknown>,
  ctx: RuleContext,
): number {
  let delta = baseDelta;

  const multiplier = actionExtra.multiplier;
  if (typeof multiplier === "object" && multiplier !== null) {
    const m = multiplier as Record<string, unknown>;
    if (m.field === "groupSize" && typeof m.factor === "number") {
      const groupSize = ctx.groupSize ?? 1;
      const threshold = typeof m.threshold === "number" ? m.threshold : 1;
      if (groupSize >= threshold) {
        delta = delta + (groupSize - threshold) * m.factor;
      }
    }
  }

  const maxPenalty = actionExtra.maxPenalty;
  if (typeof maxPenalty === "number" && delta < maxPenalty) {
    delta = maxPenalty;
  }
  const minDelta = actionExtra.minDelta;
  if (typeof minDelta === "number" && delta < minDelta && delta < 0) {
    delta = minDelta;
  }

  return delta;
}

export async function evaluateRules(
  eventType: CreditEventType,
  ctx: RuleContext,
): Promise<CreditChangeResult[]> {
  const rules = await prisma.creditRule.findMany({
    where: { eventType, enabled: true },
    orderBy: { priority: "desc" },
  });

  const account = await prisma.creditAccount.findUnique({
    where: { id: ctx.accountId },
  });
  if (!account) return [];

  const results: CreditChangeResult[] = [];
  let currentScore = account.creditScore;

  for (const rule of rules) {
    const conditions = parseJsonSafe(rule.conditions);
    if (!matchCondition(conditions, ctx)) continue;

    const actionExtra = parseJsonSafe(rule.actionExtra);
    const delta = computeDelta(rule.actionDelta, actionExtra, ctx);

    if (delta === 0) continue;

    const beforeScore = currentScore;
    currentScore = Math.max(0, Math.min(100, currentScore + delta));
    const afterScore = currentScore;

    results.push({
      delta: afterScore - beforeScore,
      beforeScore,
      afterScore,
      ruleCode: rule.code,
      reason: rule.name,
    });

    if (actionExtra.stopAfterMatch) break;
  }

  return results;
}

export async function applyCreditChanges(
  eventType: CreditEventType,
  ctx: RuleContext,
  changeType: string,
): Promise<{
  accountId: number;
  finalScore: number;
  changes: CreditChangeResult[];
}> {
  const account = await prisma.creditAccount.findUnique({
    where: { id: ctx.accountId },
  });
  if (!account) {
    throw new Error(`Credit account not found for id: ${ctx.accountId}`);
  }

  const changes = await evaluateRules(eventType, ctx);

  if (changes.length === 0) {
    return {
      accountId: account.id,
      finalScore: account.creditScore,
      changes: [],
    };
  }

  const finalScore = changes[changes.length - 1].afterScore;

  await prisma.$transaction(async (tx) => {
    for (const change of changes) {
      await tx.creditLog.create({
        data: {
          accountId: account.id,
          reservationId: ctx.reservationId,
          changeType,
          delta: change.delta,
          beforeScore: change.beforeScore,
          afterScore: change.afterScore,
          reason: change.reason,
          ruleCode: change.ruleCode,
          operatorId: ctx.operatorId,
        },
      });
    }

    const updateData: {
      creditScore: number;
      consecutiveKeep?: number;
    } = { creditScore: finalScore };

    if (eventType === "visit_verified") {
      updateData.consecutiveKeep = account.consecutiveKeep + 1;
    } else if (eventType === "no_show" || eventType === "group_no_show") {
      updateData.consecutiveKeep = 0;
    }

    await tx.creditAccount.update({
      where: { id: account.id },
      data: updateData,
    });
  });

  return { accountId: account.id, finalScore, changes };
}
