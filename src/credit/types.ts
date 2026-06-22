export type CreditEventType =
  | "visit_verified"
  | "no_show"
  | "cancel"
  | "consecutive_keep"
  | "group_no_show"
  | "credit_recover"
  | "appeal_revert"
  | "manual_adjust";

export interface RuleContext {
  accountId: number;
  phone: string;
  reservationId?: number;
  groupSize?: number;
  cancelAdvanceHours?: number;
  consecutiveKeep?: number;
  operatorId?: number;
  extra?: Record<string, unknown>;
}

export interface CreditChangeResult {
  delta: number;
  beforeScore: number;
  afterScore: number;
  ruleCode?: string;
  reason: string;
}
