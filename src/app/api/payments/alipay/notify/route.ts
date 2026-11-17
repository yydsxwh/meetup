/**
 * POST /api/payments/alipay/notify
 *
 * 订单号在明文里。已付款先回 success，不依赖支付中心。
 * 未付款只用这笔尝试的支付宝公钥验签，别的应用签过不算。
 */

import { NextResponse } from "next/server";
import { isForumMembershipProductType } from "@andyyyds/forum/lib/forum-membership-plans";
import { alipayConfigsForLock, verifyAlipayNotify } from "@andyyyds/shared/alipay";
import { prisma } from "@andyyyds/shared/db";
import { fulfillPaidOrder } from "@andyyyds/shared/orders";
import { productKeyFromType } from "@andyyyds/shared/pay-center-account";
import { notifyAccountLoad } from "@andyyyds/shared/payment-account-lock";
import { decidePaymentNotify } from "@andyyyds/shared/payment-notify";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const params: Record<string, string> = {};
    form.forEach((value, key) => {
      params[key] = String(value);
    });

    const orderNo = params.out_trade_no;
    if (!orderNo) return new NextResponse("fail", { status: 400 });

    const order = await prisma.order.findUnique({
      where: { orderNo },
      include: { course: { select: { productType: true } }, paymentAttempts: true },
    });
    if (!order) return new NextResponse("fail", { status: 404 });
    if (order.status === "PAID") return new NextResponse("success");

    const attempt = order.paymentAttempts.find((item) => item.provider === "ALIPAY") ?? null;
    const lock = notifyAccountLoad(attempt, order, "ALIPAY");
    if (!lock) return new NextResponse("fail", { status: 400 });
    const configs = await alipayConfigsForLock(productKeyFromType(order.course.productType), lock);
    const matched = configs.find((item) => (!params.app_id || params.app_id === item.appId) && verifyAlipayNotify(params, item.alipayPublicKey));
    if (!matched) return new NextResponse("fail", { status: 400 });

    const total = Math.round(Number(params.total_amount || 0) * 100);
    const currency = params.trans_currency || params.currency || "";
    if (isForumMembershipProductType(order.course.productType) &&
      (total !== order.amount || (currency && currency !== "CNY"))) {
      return new NextResponse("fail", { status: 400 });
    }
    const decision = decidePaymentNotify({
      order,
      provider: "ALIPAY",
      success: params.trade_status === "TRADE_SUCCESS" || params.trade_status === "TRADE_FINISHED",
      amountCents: total || null,
      merchantId: matched.appId,
      appId: matched.appId,
      providerTradeNo: params.trade_no || "",
      lockedMerchantId: attempt?.merchantId || order.payMerchantId || matched.appId,
      lockedAppId: attempt?.appId || matched.appId,
    });
    if (decision.action === "already-paid" || decision.action === "ignore") return new NextResponse("success");
    if (decision.action === "reject") return new NextResponse("fail", { status: 400 });

    await fulfillPaidOrder({
      orderId: order.id,
      payChannel: order.payChannel.startsWith("ALIPAY") ? order.payChannel : "ALIPAY",
      providerTradeNo: decision.providerTradeNo,
      currency: currency || undefined,
    });
    return new NextResponse("success");
  } catch (error) {
    console.error("[alipay-notify]", error instanceof Error ? error.message : "处理失败");
    return new NextResponse("fail", { status: 500 });
  }
}
