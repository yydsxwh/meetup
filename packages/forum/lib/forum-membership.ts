/**
 * 论坛跨校会员的周期、支付资格和幂等授予。
 * 支付成功页、模拟支付、免费单和课程/识图订单都不能写入 forumCrossSchoolUntil。
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  type ForumMembershipPlan,
  forumMembershipPlanBySlug,
  FORUM_MEMBERSHIP_PRODUCT_TYPE,
  isForumMembershipProductType,
} from "./forum-membership-plans";

type Db = PrismaClient | Prisma.TransactionClient;

const SHANGHAI = "Asia/Shanghai";

export type ForumGrantOrder = {
  id: string;
  userId: string;
  amount: number;
  quantity: number;
  status: string;
  payChannel: string;
  courseId: string;
  paidAt?: Date | null;
  course?: { productType: string; slug: string } | null;
};

export function forumPayChannelAllowed(channel: string): boolean {
  const value = channel.trim().toUpperCase();
  if (!value || value === "MOCK" || value === "FREE" || value === "COUPON") return false;
  return value === "WECHAT" || value === "ALIPAY" || value.startsWith("WECHAT_") || value.startsWith("ALIPAY_");
}

/** 打开支付成功页不会开通。调用方必须先完成服务端验签和金额核对。 */
export function entitlementFromPaymentReturn(_search: URLSearchParams): null {
  return null;
}

function shanghaiParts(date: Date) {
  const bag: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone: SHANGHAI,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date)) {
    if (part.type !== "literal") bag[part.type] = part.value;
  }
  let hour = Number(bag.hour);
  if (hour === 24) hour = 0;
  return {
    year: Number(bag.year),
    month: Number(bag.month),
    day: Number(bag.day),
    hour,
    minute: Number(bag.minute),
    second: Number(bag.second),
  };
}

function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 按北京时间加自然月。1 月 31 日加一个月落到 2 月最后一天，不把一个月写成固定 30 天。 */
export function addCalendarMonths(from: Date, months: number): Date {
  if (!Number.isInteger(months) || months < 1 || months > 120) {
    throw new RangeError("会员周期必须是 1 到 120 个自然月");
  }
  const part = shanghaiParts(from);
  const index = part.month - 1 + months;
  const year = part.year + Math.floor(index / 12);
  const month = (index % 12) + 1;
  const day = Math.min(part.day, daysInMonth(year, month));
  return new Date(Date.UTC(year, month - 1, day, part.hour - 8, part.minute, part.second));
}

export function nextForumCrossSchoolUntil(input: {
  currentUntil: Date | null;
  months: number;
  now: Date;
}): Date {
  const base = input.currentUntil && input.currentUntil.getTime() > input.now.getTime()
    ? input.currentUntil
    : input.now;
  return addCalendarMonths(base, input.months);
}

export type MembershipGrantRow = {
  orderId: string;
  months: number;
  effectiveAt: Date;
  status: string;
};

/** 按付款时间重放仍有效的授予。退掉中间一笔后，后面的月数还在，但不再叠在已退期间上。 */
export function replayForumMembershipUntil(grants: readonly MembershipGrantRow[]): Date | null {
  const active = grants
    .filter((grant) => grant.status === "ACTIVE")
    .sort((a, b) => a.effectiveAt.getTime() - b.effectiveAt.getTime() || a.orderId.localeCompare(b.orderId));
  let until: Date | null = null;
  for (const grant of active) {
    const base = until && until.getTime() > grant.effectiveAt.getTime() ? until : grant.effectiveAt;
    until = addCalendarMonths(base, grant.months);
  }
  return until;
}

export function forumMembershipPayable(input: {
  productType: string;
  slug: string;
  amount: number;
  quantity: number;
  payChannel: string;
  currency?: string | null;
}): { ok: true; plan: ForumMembershipPlan } | { ok: false; reason: string } {
  if (!isForumMembershipProductType(input.productType)) return { ok: false, reason: "not-forum" };
  const plan = forumMembershipPlanBySlug(input.slug);
  if (!plan) return { ok: false, reason: "unknown-plan" };
  if (input.quantity !== 1) return { ok: false, reason: "quantity" };
  if (input.amount !== plan.priceCents) return { ok: false, reason: "amount" };
  if (input.currency && input.currency.toUpperCase() !== "CNY") return { ok: false, reason: "currency" };
  if (!forumPayChannelAllowed(input.payChannel)) return { ok: false, reason: "channel" };
  return { ok: true, plan };
}

async function runInTx<T>(db: Db, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  if ("$connect" in db && typeof db.$transaction === "function") {
    return (db as PrismaClient).$transaction(fn);
  }
  return fn(db as Prisma.TransactionClient);
}

async function recomputeUntil(tx: Prisma.TransactionClient, userId: string) {
  const grants = await tx.forumCrossSchoolGrant.findMany({ where: { userId } });
  const until = replayForumMembershipUntil(grants);
  await tx.user.update({
    where: { id: userId },
    data: { forumCrossSchoolUntil: until },
  });
  return until;
}

/**
 * 只接受已经标成 PAID、金额和渠道都核对过的论坛订单。
 * 同一 orderId 已有记录时直接返回，不再顺延。
 */
export async function grantForumCrossSchoolPaidOrder(
  db: Db,
  order: ForumGrantOrder,
  options?: { currency?: string | null },
): Promise<"granted" | "replay" | "ignored" | "rejected"> {
  if (order.status !== "PAID") return "ignored";
  const course = order.course || await db.course.findUnique({
    where: { id: order.courseId },
    select: { productType: true, slug: true },
  });
  if (!course || course.productType !== FORUM_MEMBERSHIP_PRODUCT_TYPE) return "ignored";
  const payable = forumMembershipPayable({
    productType: course.productType,
    slug: course.slug,
    amount: order.amount,
    quantity: order.quantity,
    payChannel: order.payChannel,
    currency: options?.currency,
  });
  if (!payable.ok) return "rejected";
  const plan = payable.plan;

  return runInTx(db, async (tx) => {
    const existing = await tx.forumCrossSchoolGrant.findUnique({ where: { orderId: order.id } });
    if (existing) return "replay";
    const effectiveAt = order.paidAt ?? new Date();
    await tx.forumCrossSchoolGrant.create({
      data: {
        orderId: order.id,
        userId: order.userId,
        planKey: plan.key,
        months: plan.months,
        amountCents: plan.priceCents,
        currency: "CNY",
        effectiveAt,
        status: "ACTIVE",
      },
    });
    await recomputeUntil(tx, order.userId);
    return "granted";
  });
}

/** 全额退款或取消已支付订单后重算到期时间。未支付订单没有授予记录。 */
export async function markForumMembershipOrderRefunded(
  db: Db,
  orderId: string,
): Promise<"refunded" | "unpaid" | "ignored"> {
  return runInTx(db, async (tx) => {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: { course: { select: { productType: true } } },
    });
    if (!order || order.course.productType !== FORUM_MEMBERSHIP_PRODUCT_TYPE) return "ignored";
    if (order.status === "PENDING") return "unpaid";
    if (order.status !== "PAID" && order.status !== "REFUNDED" && order.status !== "CANCELLED") {
      return "ignored";
    }
    if (order.status === "PAID") {
      await tx.order.update({ where: { id: orderId }, data: { status: "REFUNDED" } });
    }
    const grant = await tx.forumCrossSchoolGrant.findUnique({ where: { orderId } });
    if (grant && grant.status !== "REVOKED") {
      await tx.forumCrossSchoolGrant.update({
        where: { orderId },
        data: { status: "REVOKED", revokedAt: new Date() },
      });
    }
    await recomputeUntil(tx, order.userId);
    return "refunded";
  });
}
