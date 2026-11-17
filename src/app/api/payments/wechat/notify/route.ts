/**
 * POST /api/payments/wechat/notify
 *
 * 订单号在密文里，先解密才能找到订单。
 * 已付款立刻回成功，不再访问支付中心。
 * 未付款必须对上这笔尝试的商户和应用；别的密钥解开不算付款。
 */

import { NextResponse } from "next/server";
import { markForumMembershipOrderRefunded } from "@andyyyds/forum/lib/forum-membership";
import { isForumMembershipProductType } from "@andyyyds/forum/lib/forum-membership-plans";
import { prisma } from "@andyyyds/shared/db";
import { fulfillPaidOrder } from "@andyyyds/shared/orders";
import { productKeyFromType } from "@andyyyds/shared/pay-center-account";
import { notifyAccountLoad } from "@andyyyds/shared/payment-account-lock";
import { decidePaymentNotify } from "@andyyyds/shared/payment-notify";
import {
  identifyWechatNotification,
  verifyWechatNotifySignature,
  wechatConfigsForLock,
} from "@andyyyds/shared/wechat-pay";

export const runtime = "nodejs";

function ok() {
  return NextResponse.json({ code: "SUCCESS", message: "成功" });
}

function fail(message: string, status = 500) {
  return NextResponse.json({ code: "FAIL", message }, { status });
}

export async function POST(req: Request) {
  try {
    const rawBody = await req.text();
    const headers = Object.fromEntries(req.headers.entries());
    const body = JSON.parse(rawBody) as { event_type?: string };
    const isRefund = typeof body.event_type === "string" && body.event_type.startsWith("REFUND");
    let identified;
    try {
      identified = await identifyWechatNotification(rawBody, headers);
    } catch (error) {
      const message = error instanceof Error ? error.message : "报文无法核对";
      return fail(message, 400);
    }
    const orderNo = identified.out_trade_no || "";
    if (!orderNo) return fail("缺少商户订单号", 400);

    const order = await prisma.order.findUnique({
      where: { orderNo },
      include: { course: { select: { productType: true } }, paymentAttempts: true },
    });
    if (!order) return fail("订单不存在", 404);
    if (order.status === "PAID" && !isRefund) return ok();

    const attempt = order.paymentAttempts.find((item) => item.provider === "WECHAT") ?? null;
    const lock = notifyAccountLoad(attempt, order, "WECHAT");
    if (!lock) return fail("没有这笔微信付款", 400);
    const allowed = await wechatConfigsForLock(productKeyFromType(order.course.productType), lock);
    const sameAccount = allowed.some((item) => item.mchId === identified.merchantId && item.appId === identified.appId);
    if (!sameAccount) return fail("回调商户与下单账户不一致", 400);
    const platformKeys = allowed.map((item) => item.platformPublicKey).filter(Boolean);
    if (platformKeys.length > 0) {
      const signed = platformKeys.some((key) => verifyWechatNotifySignature({
        rawBody,
        headers,
        platformPublicKey: key,
      }));
      if (!signed) return fail("签名未通过", 400);
    }

    // 退款同样先核对原支付账户与签名，不能被已付款的幂等返回吞掉。
    if (isRefund) {
      if (!isForumMembershipProductType(order.course.productType) || identified.refund_status !== "SUCCESS") return ok();
      if (identified.amount?.currency && identified.amount.currency !== "CNY") return fail("币种不匹配", 400);
      if (identified.amount?.refund !== order.amount || identified.amount?.total !== order.amount) return ok();
      await markForumMembershipOrderRefunded(prisma, order.id);
      return ok();
    }
    if (isForumMembershipProductType(order.course.productType)) {
      if (identified.amount?.total !== order.amount) return fail("金额不匹配", 400);
      if (identified.amount?.currency && identified.amount.currency !== "CNY") return fail("币种不匹配", 400);
    }

    const decision = decidePaymentNotify({
      order,
      provider: "WECHAT",
      success: identified.trade_state === "SUCCESS",
      amountCents: typeof identified.amount?.total === "number" ? identified.amount.total : null,
      merchantId: identified.merchantId,
      appId: identified.appId,
      providerTradeNo: identified.transaction_id || "",
      lockedMerchantId: attempt?.merchantId || order.payMerchantId,
      lockedAppId: attempt?.appId || allowed[0]?.appId || "",
    });
    if (decision.action === "already-paid" || decision.action === "ignore") return ok();
    if (decision.action === "reject") return fail(decision.reason, 400);

    await fulfillPaidOrder({
      orderId: order.id,
      payChannel: order.payChannel.startsWith("WECHAT") ? order.payChannel : "WECHAT",
      providerTradeNo: decision.providerTradeNo,
      currency: identified.amount?.currency,
    });
    return ok();
  } catch (error) {
    const message = error instanceof Error ? error.message : "处理失败";
    console.error("[wechat-notify]", message);
    return fail(message, 500);
  }
}
