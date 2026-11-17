import { createHmac, randomBytes } from "node:crypto";

export type KnowledgeGrantConfig = {
  communityId: string;
  durationDays?: number;
  endsAt?: string | null;
};

export function parseKnowledgeGrant(raw: string | null | undefined): KnowledgeGrantConfig | null {
  if (!raw?.trim()) return null;
  try {
    const value = JSON.parse(raw) as KnowledgeGrantConfig;
    if (!value || typeof value.communityId !== "string" || !value.communityId.trim()) return null;
    return {
      communityId: value.communityId.trim(),
      durationDays: typeof value.durationDays === "number" ? value.durationDays : undefined,
      endsAt: value.endsAt ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * 支付成功后通知知识社区发一条来源权益。
 * 没配地址或凭证时返回 not_configured，不把订单记成已赠送成功。
 * 同一订单的 eventId 固定，知识社区重复接收不会再发一次。
 */
export async function syncCourseKnowledgeGrant(input: {
  orderId: string;
  accountSub: string | null;
  grant: KnowledgeGrantConfig | null;
  action: "granted" | "revoked";
  fetchImpl?: typeof fetch;
}) {
  if (!input.grant) return { sent: false as const, reason: "no_grant" as const };
  if (!input.accountSub?.startsWith("usr_")) return { sent: false as const, reason: "unbound_account" as const };
  const base = process.env.KNOWLEDGE_INTERNAL_URL || process.env.KNOWLEDGE_URL || "";
  const secret = process.env.KNOWLEDGE_INTEGRATION_SECRET || "";
  if (!base.trim() || !secret.trim()) return { sent: false as const, reason: "not_configured" as const };
  const startsAt = new Date();
  const endsAt = input.grant.endsAt
    ? input.grant.endsAt
    : input.grant.durationDays
      ? new Date(startsAt.getTime() + input.grant.durationDays * 24 * 60 * 60 * 1000).toISOString()
      : null;
  const payload = {
    eventId: `${input.action}:${input.orderId}`,
    eventType: input.action === "granted" ? "course.entitlement.granted" : "course.entitlement.revoked",
    producer: "course",
    communityId: input.grant.communityId,
    accountUserId: input.accountSub,
    sourceProduct: "COURSE",
    sourceType: "order",
    sourceId: input.orderId,
    sourceLineId: "",
    sourceRevision: input.action === "granted" ? 1 : 2,
    startsAt: startsAt.toISOString(),
    endsAt,
    reason: input.action === "revoked" ? "course_refund" : undefined,
  };
  const raw = JSON.stringify(payload);
  const timestamp = String(Date.now());
  const nonce = randomBytes(8).toString("hex");
  const signature = createHmac("sha256", secret).update(`${timestamp}.${nonce}.${raw}`).digest("hex");
  try {
    const response = await (input.fetchImpl || fetch)(`${base.replace(/\/$/, "")}/api/v1/integrations/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-knowledge-timestamp": timestamp,
        "x-knowledge-nonce": nonce,
        "x-knowledge-signature": signature,
      },
      body: raw,
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return { sent: false as const, reason: "rejected" as const };
    return { sent: true as const, reason: "ok" as const };
  } catch {
    return { sent: false as const, reason: "unavailable" as const };
  }
}
