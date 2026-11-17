/**
 * POST /api/orders/:orderId/pay —— 发起支付（核心）
 *
 * 请求体：channel / tradeType / allowNativeFallback
 * 微信响应 mode：wechat_need_oauth | wechat_jsapi | wechat_h5 | wechat
 *
 * 注意：同一商户订单号不能混用不同微信下单形态；冲突时引导重新下单。
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { createAlipayPagePay, createAlipayWapPay } from "@andyyyds/shared/alipay";
import { getSession } from "@andyyyds/shared/auth";
import { prisma } from "@andyyyds/shared/db";
import { answersComplete } from "@andyyyds/shared/order-form";
import { fulfillPaidOrder } from "@andyyyds/shared/orders";
import { lockOrderPaymentAttempt } from "@andyyyds/shared/order-payment-attempt";
import { productKeyFromType, readCenterAccount } from "@andyyyds/shared/pay-center-account";
import { checkoutAccountLoad } from "@andyyyds/shared/payment-account-lock";
import { getPaymentChannels, getPublicSiteUrl } from "@andyyyds/shared/payments";
import { isForumMembershipProductType } from "@andyyyds/forum/lib/forum-membership-plans";
import {
  isMathcodeProductType,
  paymentReturnPath,
} from "@andyyyds/shared/product-types";
import { getOrderFormConfig } from "@andyyyds/shared/site-settings";
import {
  createH5Payment,
  createJsapiPayment,
  createNativePayment,
  isWechatOAuthConfigured,
} from "@andyyyds/shared/wechat-pay";
import { resolveWechatPayTradeType } from "@andyyyds/shared/wechat-pay-trade";

const bodySchema = z
  .object({
    channel: z.enum(["WECHAT", "ALIPAY", "MOCK"]).optional(),
    /** native=扫码 jsapi=微信内 h5=手机浏览器 */
    tradeType: z.enum(["native", "jsapi", "h5"]).optional(),
    /** 手机端默认 false：直连失败时不自动落成扫码单，避免锁单 */
    allowNativeFallback: z.boolean().optional(),
  })
  .optional();

/** H5 下单需要付款人客户端 IP */
function clientIpFrom(req: Request) {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.headers.get("x-real-ip") || "127.0.0.1";
}

function uaFrom(req: Request) {
  return req.headers.get("user-agent") || "";
}

function isWeChatUa(ua: string) {
  return /MicroMessenger/i.test(ua);
}

function isMobileUa(ua: string) {
  return /Android|webOS|iPhone|iPod|iPad|Mobile|BlackBerry|IEMobile|Opera Mini/i.test(
    ua,
  );
}

function wechatOauthReturnPath(order: {
  id: string;
  orderNo: string;
  course: { productType: string };
}) {
  return paymentReturnPath({
    orderId: order.id,
    orderNo: order.orderNo,
    productType: order.course.productType,
  });
}

async function wechatH5RedirectUrl(order: {
  id: string;
  orderNo: string;
  course: { productType: string };
}) {
  const siteUrl = await getPublicSiteUrl();
  if (order.course.productType === "MATHCODE") {
    return `${siteUrl}${paymentReturnPath({
      orderId: order.id,
      orderNo: order.orderNo,
      productType: order.course.productType,
    })}`;
  }
  return `${siteUrl}/checkout/return?out_trade_no=${order.orderNo}`;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ orderId: string }> },
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }

  const { orderId } = await params;
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { course: true, user: true },
  });

  if (!order || order.userId !== session.id) {
    return NextResponse.json({ error: "订单不存在" }, { status: 404 });
  }
  const payProduct = productKeyFromType(order.course.productType);

  if (order.status === "PAID") {
    return NextResponse.json({
      mode: "paid",
      slug: order.course.slug,
      productType: order.course.productType,
      status: "PAID",
    });
  }

  // 识图壳和论坛跨校会员没有收货表单；套用商城必填项会让人付不了。
  if (!isMathcodeProductType(order.course.productType) && !isForumMembershipProductType(order.course.productType)) {
    const orderForm = await getOrderFormConfig();
    if (!answersComplete(orderForm, order.formAnswersJson)) {
      return NextResponse.json(
        { error: "请先填写完整的购买信息" },
        { status: 400 },
      );
    }
  }

  const ua = uaFrom(req);
  let channel: "WECHAT" | "ALIPAY" | "MOCK" = "WECHAT";
  let tradeType: "native" | "jsapi" | "h5" = "native";
  let allowNativeFallback = !isMobileUa(ua) && !isWeChatUa(ua);
  try {
    const parsed = bodySchema.parse(await req.json().catch(() => ({})));
    channel = parsed?.channel || "WECHAT";
    tradeType = parsed?.tradeType || "native";
    if (typeof parsed?.allowNativeFallback === "boolean") {
      allowNativeFallback = parsed.allowNativeFallback;
    }
  } catch {
    channel = "WECHAT";
    tradeType = "native";
  }

  if (channel === "WECHAT") {
    tradeType = resolveWechatPayTradeType({
      requested: tradeType,
      allowNativeFallback,
      ua,
    });
  }

  const channels = await getPaymentChannels(payProduct);

  if (process.env.NODE_ENV === "production" && (channel === "MOCK" || channels.mockOnly)) {
    return NextResponse.json({ error: "生产环境不能模拟收款" }, { status: 409 });
  }

  if (
    isForumMembershipProductType(order.course.productType) &&
    (channel === "MOCK" || channels.mockOnly)
  ) {
    return NextResponse.json(
      {
        error: "论坛跨校会员需要已接通的微信或支付宝，模拟支付不能开通。",
        code: "PAYMENT_NOT_CONFIGURED",
      },
      { status: 503 },
    );
  }

  if (channel === "MOCK" || channels.mockOnly) {
    if (!channels.mockOnly && channel === "MOCK") {
      return NextResponse.json(
        channels.unavailable
          ? { error: "支付暂时不可用" }
          : channels.invalid
            ? { error: "指定支付账户无效，没有改用其他商户" }
            : channels.closed
              ? { error: "该产品已暂停收款" }
              : { error: "线上已启用真实支付，请使用微信或支付宝" },
        { status: channels.unavailable ? 503 : channels.closed || channels.invalid ? 409 : 400 },
      );
    }
    const paid = await fulfillPaidOrder({
      orderId: order.id,
      payChannel: "MOCK",
    });
    return NextResponse.json({
      mode: "mock",
      status: "PAID",
      slug: paid.course.slug,
      productType: paid.course.productType,
    });
  }

  try {
    if (channel === "WECHAT") {
      const wechatAttempt = await prisma.orderPaymentAttempt.findUnique({
        where: { orderId_provider: { orderId: order.id, provider: "WECHAT" } },
      });
      const started = Boolean(wechatAttempt) || order.payChannel.startsWith("WECHAT");
      if (!started) {
        const blocked = await centerBlock(payProduct, "WECHAT");
        if (blocked) return blocked;
        if (!channels.wechat) {
          return NextResponse.json({ error: "未启用微信支付" }, { status: 400 });
        }
      }
      const lock = checkoutAccountLoad(wechatAttempt, order, "WECHAT");

      if (tradeType === "jsapi") {
        const openid = order.user.wechatOpenId?.trim() || "";
        if (!openid) {
          const oauthReady = await isWechatOAuthConfigured();
          if (oauthReady) {
            return NextResponse.json({
              mode: "wechat_need_oauth",
              oauthUrl: `/api/auth/wechat?purpose=bind&returnUrl=${encodeURIComponent(wechatOauthReturnPath(order))}`,
              status: "PENDING",
              orderNo: order.orderNo,
              amount: order.amount,
              slug: order.course.slug,
      productType: order.course.productType,
            });
          }
          // 无 AppSecret：微信内无法 JSAPI，改走 H5（若商户已开通）；再不行走明确错误
          tradeType = "h5";
        } else {
          if (
            order.codeUrl &&
            order.payChannel &&
            order.payChannel !== "WECHAT_JSAPI"
          ) {
            return NextResponse.json({
              mode: "wechat_trade_conflict",
              error:
                "本订单已用其他支付方式发起过，请返回课程重新下单后再支付",
              codeUrl:
                allowNativeFallback &&
                (order.payChannel === "WECHAT" ||
                  order.payChannel === "WECHAT_NATIVE")
                  ? order.codeUrl
                  : "",
              status: order.status,
              orderNo: order.orderNo,
              amount: order.amount,
              slug: order.course.slug,
      productType: order.course.productType,
            });
          }
          const startedPay = await createJsapiPayment({
            product: payProduct,
            orderNo: order.orderNo,
            description: order.course.title,
            amountCents: order.amount,
            openid,
            lock,
          });
          await rememberAttempt(order, {
            provider: "WECHAT",
            method: "JSAPI",
            profileId: startedPay.profileId,
            profileVersion: startedPay.profileVersion,
            merchantId: startedPay.merchantId,
            appId: startedPay.appId,
          });
          await prisma.order.update({
            where: { id: order.id },
            data: {
              payChannel: "WECHAT_JSAPI",
              codeUrl: `prepay:${startedPay.prepayId}`,
              ...lockFields(order, startedPay.profileId, startedPay.merchantId),
            },
          });
          const payParams = startedPay.payParams;
          return NextResponse.json({
            mode: "wechat_jsapi",
            status: "PENDING",
            orderNo: order.orderNo,
            payParams,
            amount: order.amount,
            slug: order.course.slug,
      productType: order.course.productType,
          });
        }
      }

      if (tradeType === "h5") {
        if (
          order.codeUrl &&
          order.payChannel &&
          order.payChannel !== "WECHAT_H5"
        ) {
          if (
            order.payChannel === "WECHAT" ||
            order.payChannel === "WECHAT_NATIVE"
          ) {
            if (allowNativeFallback) {
              return NextResponse.json({
                mode: "wechat",
                status: order.status,
                orderNo: order.orderNo,
                codeUrl: order.codeUrl,
                amount: order.amount,
                slug: order.course.slug,
      productType: order.course.productType,
                hint: "请长按识别二维码，或使用微信扫一扫完成支付",
              });
            }
            return NextResponse.json(
              {
                error:
                  "本订单已生成扫码单。请返回课程重新下单，即可在手机上直接调起微信支付",
              },
              { status: 400 },
            );
          }
          if (order.payChannel === "WECHAT_JSAPI") {
            return NextResponse.json(
              {
                error:
                  "本订单已在微信内发起过支付。请打开微信完成支付，或返回课程重新下单",
              },
              { status: 400 },
            );
          }
        }
        if (order.codeUrl && order.payChannel === "WECHAT_H5") {
          const redirectUrl = encodeURIComponent(
            await wechatH5RedirectUrl(order),
          );
          const payUrl = order.codeUrl.includes("redirect_url=")
            ? order.codeUrl
            : `${order.codeUrl}${order.codeUrl.includes("?") ? "&" : "?"}redirect_url=${redirectUrl}`;
          return NextResponse.json({
            mode: "wechat_h5",
            status: order.status,
            orderNo: order.orderNo,
            mwebUrl: payUrl,
            amount: order.amount,
            slug: order.course.slug,
      productType: order.course.productType,
          });
        }
        try {
          const startedPay = await createH5Payment({
            product: payProduct,
            orderNo: order.orderNo,
            description: order.course.title,
            amountCents: order.amount,
            clientIp: clientIpFrom(req),
            appName: order.course.title,
            lock,
          });
          await rememberAttempt(order, {
            provider: "WECHAT",
            method: "H5",
            profileId: startedPay.profileId,
            profileVersion: startedPay.profileVersion,
            merchantId: startedPay.merchantId,
            appId: startedPay.appId,
          });
          const mwebUrl = startedPay.mwebUrl;
          await prisma.order.update({
            where: { id: order.id },
            data: { payChannel: "WECHAT_H5", codeUrl: mwebUrl, ...lockFields(order, startedPay.profileId, startedPay.merchantId) },
          });
          const redirectUrl = encodeURIComponent(
            await wechatH5RedirectUrl(order),
          );
          const payUrl = `${mwebUrl}${mwebUrl.includes("?") ? "&" : "?"}redirect_url=${redirectUrl}`;
          return NextResponse.json({
            mode: "wechat_h5",
            status: "PENDING",
            orderNo: order.orderNo,
            mwebUrl: payUrl,
            amount: order.amount,
            slug: order.course.slug,
      productType: order.course.productType,
          });
        } catch (h5Error) {
          const message =
            h5Error instanceof Error ? h5Error.message : "H5 支付不可用";
          if (allowNativeFallback) {
            tradeType = "native";
          } else {
            const oauthReady = await isWechatOAuthConfigured();
            return NextResponse.json(
              {
                error: oauthReady
                  ? `无法调起手机支付：${message}。请在微信内打开本站完成支付，或返回课程重新下单。`
                  : `无法调起手机直接支付：${message}。请在系统设置填写公众号 AppSecret，并在微信商户平台开通 H5 支付；微信内打开时可直接调起支付。`,
                needAppSecret: !oauthReady,
              },
              { status: 400 },
            );
          }
        }
      }

      // Native 扫码（桌面，或 JSAPI/H5 降级）
      if (
        order.codeUrl &&
        (order.payChannel === "WECHAT" ||
          order.payChannel === "WECHAT_NATIVE")
      ) {
        return NextResponse.json({
          mode: "wechat",
          status: order.status,
          orderNo: order.orderNo,
          codeUrl: order.codeUrl,
          amount: order.amount,
          slug: order.course.slug,
      productType: order.course.productType,
        });
      }
      if (
        order.codeUrl &&
        order.payChannel &&
        order.payChannel !== "WECHAT" &&
        order.payChannel !== "WECHAT_NATIVE"
      ) {
        return NextResponse.json(
          {
            error:
              "本订单已用手机支付方式发起过。若未完成支付，请返回课程重新下单；或在微信内完成先前的支付。",
          },
          { status: 400 },
        );
      }

      const startedPay = await createNativePayment({
        product: payProduct,
        orderNo: order.orderNo,
        description: order.course.title,
        amountCents: order.amount,
        lock,
      });
      await rememberAttempt(order, {
        provider: "WECHAT",
        method: "NATIVE",
        profileId: startedPay.profileId,
        profileVersion: startedPay.profileVersion,
        merchantId: startedPay.merchantId,
        appId: startedPay.appId,
      });
      const codeUrl = startedPay.codeUrl;
      await prisma.order.update({
        where: { id: order.id },
        data: { payChannel: "WECHAT_NATIVE", codeUrl, ...lockFields(order, startedPay.profileId, startedPay.merchantId) },
      });
      return NextResponse.json({
        mode: "wechat",
        status: "PENDING",
        orderNo: order.orderNo,
        codeUrl,
        amount: order.amount,
        slug: order.course.slug,
      productType: order.course.productType,
      });
    }

    if (channel === "ALIPAY") {
      const alipayAttempt = await prisma.orderPaymentAttempt.findUnique({
        where: { orderId_provider: { orderId: order.id, provider: "ALIPAY" } },
      });
      if (!alipayAttempt && !order.payChannel.startsWith("ALIPAY")) {
        const blocked = await centerBlock(payProduct, "ALIPAY");
        if (blocked) return blocked;
        if (!channels.alipay) {
          return NextResponse.json({ error: "未启用支付宝支付" }, { status: 400 });
        }
      }
      if (order.codeUrl && order.payChannel.startsWith("ALIPAY")) {
        return NextResponse.json({
          mode: "alipay",
          status: order.status,
          orderNo: order.orderNo,
          payUrl: order.codeUrl,
          amount: order.amount,
          slug: order.course.slug,
          productType: order.course.productType,
        });
      }
      const useWap = isMobileUa(ua) || isWeChatUa(ua);
      const lock = checkoutAccountLoad(alipayAttempt, order, "ALIPAY");
      const payInput = {
        orderNo: order.orderNo,
        subject: order.course.title,
        amountCents: order.amount,
        product: payProduct,
        lock,
      };
      let payUrl = "";
      let payChannel = "ALIPAY";
      let profileId = "";
      let profileVersion = 0;
      let merchantId = "";
      let appId = "";
      let method = "PAGE";
      try {
        if (useWap) {
          const wap = await createAlipayWapPay(payInput);
          payUrl = wap.payUrl;
          payChannel = "ALIPAY_WAP";
          method = "WAP";
          profileId = wap.profileId;
          profileVersion = wap.profileVersion;
          merchantId = wap.merchantId;
          appId = wap.appId;
        } else {
          const page = await createAlipayPagePay(payInput);
          payUrl = page.payUrl;
          payChannel = "ALIPAY_PAGE";
          profileId = page.profileId;
          profileVersion = page.profileVersion;
          merchantId = page.merchantId;
          appId = page.appId;
        }
      } catch (alipayError) {
        // 手机网站支付未开通时，回退电脑网站支付
        if (useWap) {
          const page = await createAlipayPagePay(payInput);
          payUrl = page.payUrl;
          payChannel = "ALIPAY_PAGE";
          method = "PAGE";
          profileId = page.profileId;
          profileVersion = page.profileVersion;
          merchantId = page.merchantId;
          appId = page.appId;
        } else {
          throw alipayError;
        }
      }
      await rememberAttempt(order, {
        provider: "ALIPAY",
        method,
        profileId,
        profileVersion,
        merchantId,
        appId,
      });
      await prisma.order.update({
        where: { id: order.id },
        data: { payChannel, codeUrl: payUrl, ...lockFields(order, profileId, merchantId) },
      });
      return NextResponse.json({
        mode: "alipay",
        status: "PENDING",
        orderNo: order.orderNo,
        payUrl,
        amount: order.amount,
        slug: order.course.slug,
      productType: order.course.productType,
      });
    }

    return NextResponse.json({ error: "不支持的支付方式" }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "发起支付失败";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

/** 支付中心已接通时，这个渠道的关闭、无效或读失败不能落到模拟支付。 */
async function centerBlock(product: string, provider: "WECHAT" | "ALIPAY") {
  const account = await readCenterAccount(product, provider);
  if (account.kind === "SKIP" || account.kind === "READY" || account.kind === "UNCONFIGURED") return null;
  if (account.kind === "OFF") return NextResponse.json({ error: "该渠道已暂停收款" }, { status: 409 });
  if (account.kind === "INVALID") {
    return NextResponse.json({ error: "指定支付账户无效，没有改用其他商户" }, { status: 409 });
  }
  if (account.kind === "UNAVAILABLE") return NextResponse.json({ error: "支付暂时不可用" }, { status: 503 });
  return NextResponse.json({ error: "该渠道未配置，没有改用模拟支付" }, { status: 409 });
}

/** 第一笔快照只写一次。真正的绑定在 OrderPaymentAttempt，后续尝试不能靠改这两个字段换商户。 */
function lockFields(order: { payProfileId: string }, profileId: string, merchantId: string) {
  if (order.payProfileId || !profileId) return {};
  return { payProfileId: profileId, payMerchantId: merchantId };
}

async function rememberAttempt(order: { id: string; orderNo: string; amount: number }, input: {
  provider: "WECHAT" | "ALIPAY";
  method: string;
  profileId: string;
  profileVersion: number;
  merchantId: string;
  appId: string;
}) {
  await lockOrderPaymentAttempt(prisma, {
    orderId: order.id,
    provider: input.provider,
    method: input.method,
    profileId: input.profileId,
    profileVersion: input.profileVersion,
    merchantId: input.merchantId,
    appId: input.appId,
    amountCents: order.amount,
    outTradeNo: order.orderNo,
  });
}
