import { NextResponse } from "next/server";
import { z } from "zod";
import { isForumMembershipProductType } from "@andyyyds/forum/lib/forum-membership-plans";
import { getSession } from "@andyyyds/shared/auth";
import { prisma } from "@andyyyds/shared/db";
import {
  stringifyStoredAnswers,
  validateOrderFormAnswers,
} from "@andyyyds/shared/order-form";
import { fulfillPaidOrder } from "@andyyyds/shared/orders";
import { productKeyFromType } from "@andyyyds/shared/pay-center-account";
import { notifyAccountLoad } from "@andyyyds/shared/payment-account-lock";
import { getOrderFormConfig } from "@andyyyds/shared/site-settings";
import { queryNativePaymentByOrderNo } from "@andyyyds/shared/wechat-pay";

const patchSchema = z.object({
  formAnswers: z.record(z.string(), z.string()),
});

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ orderId: string }> },
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }

  const { orderId } = await params;
  let order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      course: { select: { slug: true, title: true, productType: true } },
    },
  });

  if (!order || order.userId !== session.id) {
    return NextResponse.json({ error: "订单不存在" }, { status: 404 });
  }

  const wechatAttempt = await prisma.orderPaymentAttempt.findUnique({
    where: { orderId_provider: { orderId: order.id, provider: "WECHAT" } },
  });
  const wechatPending = Boolean(wechatAttempt) || order.payChannel.startsWith("WECHAT");
  if (order.status === "PENDING" && wechatPending) {
    try {
      const lock = notifyAccountLoad(wechatAttempt, order, "WECHAT");
      if (lock) {
        const wx = await queryNativePaymentByOrderNo(
          order.orderNo,
          productKeyFromType(order.course.productType),
          lock,
        );
        const merchantOk = !wx.mchid || !wechatAttempt?.merchantId || wx.mchid === wechatAttempt.merchantId;
        const amountMatches = typeof wx.amount?.total === "number" && wx.amount.total === order.amount;
        const currencyOk = !wx.amount?.currency || wx.amount.currency === "CNY";
        const forumVerified = !isForumMembershipProductType(order.course.productType) || (amountMatches && currencyOk);
        if (wx.trade_state === "SUCCESS" && merchantOk && forumVerified && (wx.amount?.total == null || amountMatches)) {
          order = await fulfillPaidOrder({
            orderId: order.id,
            payChannel: order.payChannel || "WECHAT",
            providerTradeNo: wx.transaction_id || "",
            currency: wx.amount?.currency,
          });
        }
      }
    } catch {
      // 查单失败保持未支付，下次轮询再试。不改用新商户。
    }
  }

  return NextResponse.json({
    id: order.id,
    orderNo: order.orderNo,
    status: order.status,
    amount: order.amount,
    payChannel: order.payChannel,
    codeUrl: order.codeUrl,
    slug: order.course.slug,
    title: order.course.title,
    productType: order.course.productType,
    paidAt: order.paidAt,
  });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ orderId: string }> },
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }

  const { orderId } = await params;
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order || order.userId !== session.id) {
    return NextResponse.json({ error: "订单不存在" }, { status: 404 });
  }
  if (order.status !== "PENDING") {
    return NextResponse.json({ error: "订单状态不可修改" }, { status: 400 });
  }

  try {
    const body = patchSchema.parse(await req.json());
    const orderForm = await getOrderFormConfig();
    const check = validateOrderFormAnswers(orderForm, body.formAnswers);
    if (!check.ok) {
      return NextResponse.json({ error: check.error }, { status: 400 });
    }

    await prisma.order.update({
      where: { id: order.id },
      data: { formAnswersJson: stringifyStoredAnswers(check.stored) },
    });

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "保存失败" }, { status: 400 });
  }
}
