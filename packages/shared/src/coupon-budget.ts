/**
 * 旧公共券码升级成独立券时的额度计划。
 *
 * 总承诺等于原来的 maxUses，不按「旧码一份 + 新券一份」相加。
 * 已支付订单、待支付订单、没有订单的核销记录互斥计数。
 * usedCount 高于这些证据时，剩余可发不确定，必须暂停补发。
 */

export type LegacyBudgetInput = {
  maxUses: number;
  usedCount: number;
  redemptionIds: string[];
  paidOrderIds: string[];
  pendingOrderIds: string[];
  existingHistoricalKeys: string[];
  existingIssuedCount: number;
};

export type HistoricalSlot = {
  kind: "paid" | "pending" | "redemption";
  id: string;
  key: string;
};

export type LegacyBudgetPlan = {
  issueCount: number;
  evidencedPaid: number;
  evidencedReserved: number;
  evidencedRedemptionsWithoutOrder: number;
  evidencedTotal: number;
  unexplainedUsedCount: number;
  blocked: boolean;
  blockReason: string;
  historicalToCreate: HistoricalSlot[];
  availableToCreate: number;
};

function unique(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function planLegacyCouponBudget(input: LegacyBudgetInput): LegacyBudgetPlan {
  const issueCount = Math.max(0, Math.floor(input.maxUses));
  const usedCount = Math.max(0, Math.floor(input.usedCount || 0));
  const paid = unique(input.paidOrderIds);
  const paidSet = new Set(paid);
  const pending = unique(input.pendingOrderIds).filter((id) => !paidSet.has(id));
  const evidencedOrders = paid.length + pending.length;
  const redemptionOnly = Math.max(0, unique(input.redemptionIds).length - evidencedOrders);
  const evidencedTotal = evidencedOrders + redemptionOnly;
  const unexplainedUsedCount = Math.max(0, usedCount - evidencedTotal);
  const blocked = unexplainedUsedCount > 0;
  const blockReason = blocked
    ? `已用次数 ${usedCount} 高于可核对的订单和核销 ${evidencedTotal}，暂停补发未领取券`
    : "";

  const existing = new Set(input.existingHistoricalKeys);
  const historicalToCreate: HistoricalSlot[] = [];
  if (!blocked) {
    for (const id of paid) {
      const key = `paid:${id}`;
      if (!existing.has(key)) historicalToCreate.push({ kind: "paid", id, key });
    }
    for (const id of pending) {
      const key = `pending:${id}`;
      if (!existing.has(key)) historicalToCreate.push({ kind: "pending", id, key });
    }
    const redemptionSlots = unique(input.redemptionIds).slice(0, redemptionOnly);
    for (const id of redemptionSlots) {
      const key = `redemption:${id}`;
      if (!existing.has(key)) {
        historicalToCreate.push({ kind: "redemption", id, key });
      }
    }
  }

  const existingIssued = Math.max(0, Math.floor(input.existingIssuedCount || 0));
  // 历史占用已经算进 evidencedTotal。未领取只补承诺减去占用、再减去已经发行的券。
  const availableToCreate = blocked
    ? 0
    : Math.max(0, issueCount - evidencedTotal - existingIssued);

  return {
    issueCount,
    evidencedPaid: paid.length,
    evidencedReserved: pending.length,
    evidencedRedemptionsWithoutOrder: redemptionOnly,
    evidencedTotal,
    unexplainedUsedCount,
    blocked,
    blockReason,
    historicalToCreate,
    availableToCreate,
  };
}

export function sharedRemaining(issueCount: number, consumed: number): number {
  return Math.max(0, Math.floor(issueCount) - Math.max(0, Math.floor(consumed)));
}
