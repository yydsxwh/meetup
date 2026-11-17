/**
 * 微信、支付宝回调的共同规则。
 * 已付款先返回幂等结果。未付款只接受原尝试账户验过的成功通知，而且只履约一次。
 */

export type NotifyOrder = {
  id: string;
  orderNo: string;
  amount: number;
  status: string;
  payChannel: string;
  payMerchantId: string;
};

export type NotifyDecision =
  | { action: "already-paid" }
  | { action: "ignore" }
  | { action: "reject"; reason: string }
  | { action: "fulfill"; providerTradeNo: string; payChannel: string };

export function decidePaymentNotify(input: {
  order: NotifyOrder;
  provider: "WECHAT" | "ALIPAY";
  success: boolean;
  amountCents: number | null;
  merchantId: string;
  appId: string;
  providerTradeNo: string;
  lockedMerchantId: string;
  lockedAppId: string;
}): NotifyDecision {
  if (input.order.status === "PAID") return { action: "already-paid" };
  if (input.order.orderNo && input.provider === "WECHAT" && input.merchantId && input.lockedMerchantId && input.merchantId !== input.lockedMerchantId) {
    return { action: "reject", reason: "回调商户与下单账户不一致" };
  }
  if (input.provider === "ALIPAY" && input.appId && input.lockedAppId && input.appId !== input.lockedAppId) {
    return { action: "reject", reason: "回调应用与下单账户不一致" };
  }
  if (input.provider === "ALIPAY" && input.merchantId && input.lockedMerchantId && input.merchantId !== input.lockedMerchantId) {
    return { action: "reject", reason: "回调应用与下单账户不一致" };
  }
  if (!input.success) return { action: "ignore" };
  if (input.amountCents != null && input.amountCents !== input.order.amount) {
    return { action: "reject", reason: "金额不匹配" };
  }
  return {
    action: "fulfill",
    providerTradeNo: input.providerTradeNo,
    payChannel: input.provider,
  };
}
