/**
 * 用户已确认的论坛跨校会员价格规范，金额均为人民币分。
 * 本模块只提供套餐、周期文案和服务端金额。创建订单与授予权益在结账和支付履约里完成。
 */
const MONTHLY_PRICE_CENTS = 1_900;
const ANNUAL_REFERENCE_PRICE_CENTS = MONTHLY_PRICE_CENTS * 12;
const ANNUAL_PAY_PERCENT = 80;

export const FORUM_CROSS_SCHOOL_MEMBERSHIP_PRICING = Object.freeze({
  currency: "CNY" as const,
  monthlyPriceCents: MONTHLY_PRICE_CENTS,
  annualReferencePriceCents: ANNUAL_REFERENCE_PRICE_CENTS,
  annualPayPercent: ANNUAL_PAY_PERCENT,
  annualPriceCents: ANNUAL_REFERENCE_PRICE_CENTS * ANNUAL_PAY_PERCENT / 100,
  automaticRenewal: false as const,
});

/** 仅格式化整数分，不用浮点元金额参与支付计算。 */
export function formatForumMembershipYuan(cents: number, keepTwoDecimals = false): string {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new RangeError("金额必须是非负安全整数分");
  }
  const yuan = Math.trunc(cents / 100);
  const fraction = String(cents % 100).padStart(2, "0");
  return fraction === "00" && !keepTwoDecimals ? String(yuan) : `${yuan}.${fraction}`;
}

export const FORUM_CROSS_SCHOOL_MEMBERSHIP_PRICE_LABELS = Object.freeze({
  monthly: `${formatForumMembershipYuan(FORUM_CROSS_SCHOOL_MEMBERSHIP_PRICING.monthlyPriceCents)}元/月`,
  annual: `${formatForumMembershipYuan(FORUM_CROSS_SCHOOL_MEMBERSHIP_PRICING.annualPriceCents, true)}元/年`,
  annualReference: `${formatForumMembershipYuan(FORUM_CROSS_SCHOOL_MEMBERSHIP_PRICING.annualReferencePriceCents)}元/年`,
  annualDiscount: "全年八折",
  renewal: "不自动续费",
});

/** 挂在 Course.productType 上的壳商品，不进课程、资料或商城广场。 */
export const FORUM_MEMBERSHIP_PRODUCT_TYPE = "FORUM" as const;

export const FORUM_MEMBERSHIP_CHECKOUT_PATH = "/forum/membership";

export const FORUM_MEMBERSHIP_PLANS = Object.freeze({
  monthly: Object.freeze({
    key: "monthly" as const,
    slug: "forum-cross-school-monthly",
    months: 1,
    priceCents: FORUM_CROSS_SCHOOL_MEMBERSHIP_PRICING.monthlyPriceCents,
    originalPriceCents: FORUM_CROSS_SCHOOL_MEMBERSHIP_PRICING.monthlyPriceCents,
    title: "论坛跨校互动月会员",
    periodLabel: "1 个自然月（北京时间，月底按当月最后一天）",
  }),
  yearly: Object.freeze({
    key: "yearly" as const,
    slug: "forum-cross-school-yearly",
    months: 12,
    priceCents: FORUM_CROSS_SCHOOL_MEMBERSHIP_PRICING.annualPriceCents,
    originalPriceCents: FORUM_CROSS_SCHOOL_MEMBERSHIP_PRICING.annualReferencePriceCents,
    title: "论坛跨校互动年会员",
    periodLabel: "12 个自然月（北京时间，月底按当月最后一天）",
  }),
});

export type ForumMembershipPlan = (typeof FORUM_MEMBERSHIP_PLANS)[keyof typeof FORUM_MEMBERSHIP_PLANS];

export function isForumMembershipProductType(value: string): boolean {
  return value === FORUM_MEMBERSHIP_PRODUCT_TYPE;
}

export function forumMembershipPlanByKey(key: string): ForumMembershipPlan | null {
  if (key === "monthly" || key === "yearly") return FORUM_MEMBERSHIP_PLANS[key];
  return null;
}

export function forumMembershipPlanBySlug(slug: string): ForumMembershipPlan | null {
  return Object.values(FORUM_MEMBERSHIP_PLANS).find((plan) => plan.slug === slug) ?? null;
}

/** 报价只认服务端套餐。客户端传来的金额、月数和 isVip 不参与计算。 */
export function quoteForumCheckout(planKey: string, client: Record<string, unknown> = {}) {
  const plan = forumMembershipPlanByKey(planKey);
  if (!plan) return null;
  return {
    planKey: plan.key,
    slug: plan.slug,
    amountCents: plan.priceCents,
    originalPriceCents: plan.originalPriceCents,
    months: plan.months,
    currency: FORUM_CROSS_SCHOOL_MEMBERSHIP_PRICING.currency,
    automaticRenewal: false as const,
    ignoredClientAmount: client.amount ?? client.price ?? client.isVip ?? null,
  };
}
