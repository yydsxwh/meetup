/**
 * 订单履约（支付成功后的统一入口）
 *
 * 无论来自：微信回调 / 支付宝回调 / 模拟支付 / 主动查单，
 * 都应调用 fulfillPaidOrder，保证：
 * - 幂等（已支付再调一次不重复开通）
 * - 写 PAID、开通 enrollment、优惠券核销、平台/商家/代理分成、三级分销
 * - 专栏套餐：同时开通所含每门单课
 *
 * 改需求时：加「发短信 / 发邮件」等副作用，优先放在本函数事务成功之后。
 */

import { parseKnowledgeGrant, syncCourseKnowledgeGrant } from "@andyyyds/courses/lib/knowledge-grant";
import { grantProductAccess } from "@andyyyds/courses/lib/course-bundle";
import { grantForumCrossSchoolPaidOrder, forumMembershipPayable } from "@andyyyds/forum/lib/forum-membership";
import { isForumMembershipProductType } from "@andyyyds/forum/lib/forum-membership-plans";
import { grantMathcodePaidOrder } from "@andyyyds/mathcode/lib/mathcode-billing";
import { redeemReservedInstance } from "./coupon-instance";
import { prisma } from "./db";
import { settlePaidOrderSplit } from "./platform-settlement";

type FulfillInput = {
  orderId: string;
  /** 记录到订单上的渠道标记，如 WECHAT_JSAPI / ALIPAY_WAP */
  payChannel?: string;
  /** 微信/支付宝侧交易号，便于对账 */
  providerTradeNo?: string;
  /** 支付通知里的币种。论坛会员只接受 CNY；缺省时沿用订单的人民币分。 */
  currency?: string | null;
};

/**
 * 将订单标记为已支付并开通学习权限（幂等：已支付直接返回）。
 */
async function notifyKnowledgeCommunity(orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { course: true, user: { select: { accountSub: true } } },
  });
  if (!order || order.status !== "PAID") return;
  const grant = parseKnowledgeGrant(order.course.knowledgeGrantJson);
  // 赠送失败不回滚已经支付的订单。知识社区按订单号幂等，之后可以重放。
  await syncCourseKnowledgeGrant({
    orderId: order.id,
    accountSub: order.user.accountSub,
    grant,
    action: "granted",
  });
}

export async function fulfillPaidOrder(input: FulfillInput) {
  const existing = await prisma.order.findUnique({
    where: { id: input.orderId },
    include: { course: true },
  });
  if (!existing) {
    throw new Error("ORDER_NOT_FOUND");
  }
  // 已支付：仍补开 enrollment（含专栏子课；历史异常订单可能 PAID 却未报名）
  if (existing.status === "PAID") {
    await grantProductAccess(prisma, {
      userId: existing.userId,
      productId: existing.courseId,
    });
    // 识图壳：已支付回放也要补发页数（MathcodeGrant 按 orderId 幂等）
    await grantMathcodePaidOrder(prisma, existing);
    await notifyKnowledgeCommunity(existing.id);
    await grantForumCrossSchoolPaidOrder(prisma, existing, { currency: input.currency });
    return existing;
  }

  const paid = await prisma.$transaction(async (tx) => {
    // 事务内再读一次，防止并发回调双写
    const current = await tx.order.findUnique({ where: { id: input.orderId } });
    if (!current) throw new Error("ORDER_NOT_FOUND");
    if (current.status === "PAID") {
      await grantProductAccess(tx, {
        userId: current.userId,
        productId: current.courseId,
      });
      const paidAgain = await tx.order.findUniqueOrThrow({
        where: { id: input.orderId },
        include: { course: true },
      });
      await grantMathcodePaidOrder(tx, paidAgain);
      await grantForumCrossSchoolPaidOrder(tx, paidAgain, { currency: input.currency });
      return paidAgain;
    }

    if (isForumMembershipProductType(existing.course.productType)) {
      const payable = forumMembershipPayable({
        productType: existing.course.productType,
        slug: existing.course.slug,
        amount: current.amount,
        quantity: current.quantity,
        payChannel: input.payChannel || current.payChannel,
        currency: input.currency,
      });
      if (!payable.ok) throw new Error("FORUM_MEMBERSHIP_NOT_PAYABLE");
    }

    const paid = await tx.order.update({
      where: { id: input.orderId },
      data: {
        status: "PAID",
        paidAt: new Date(),
        ...(input.payChannel ? { payChannel: input.payChannel } : {}),
        ...(input.providerTradeNo
          ? { providerTradeNo: input.providerTradeNo }
          : {}),
      },
      include: { course: true },
    });

    // 优惠券：有实例则先核销这一张，再让旧计数跟上。同一事务只加一次。
    if (paid.couponInstanceId) {
      await redeemReservedInstance(tx, {
        orderId: paid.id,
        userId: paid.userId,
      });
    }
    if (paid.couponId) {
      await tx.coupon.update({
        where: { id: paid.couponId },
        data: { usedCount: { increment: 1 } },
      });
      const redeemed = await tx.couponRedemption.findUnique({
        where: {
          couponId_userId: { couponId: paid.couponId, userId: paid.userId },
        },
      });
      if (!redeemed) {
        await tx.couponRedemption.create({
          data: { couponId: paid.couponId, userId: paid.userId },
        });
      }
    }

    // 开通本商品 + 专栏所含单课
    await grantProductAccess(tx, {
      userId: paid.userId,
      productId: paid.courseId,
    });
    // 识图会员 / 按页：写入 150 页或 guestPages（同一订单只发一次）
    await grantMathcodePaidOrder(tx, paid);
    // 论坛跨校会员：只认受控套餐和已核对的支付渠道，同一订单不重复顺延。
    await grantForumCrossSchoolPaidOrder(tx, paid, { currency: input.currency });

    // 商城销量占位：支付成功后累加「已售」
    if (paid.course.productType === "PRODUCT") {
      await tx.course.update({
        where: { id: paid.courseId },
        data: { studentCount: { increment: Math.max(1, paid.quantity || 1) } },
      });
    }

    // 平台抽成 / 商家实得 / 推荐人&代理分成 + 三级分销
    await settlePaidOrderSplit(tx, {
      id: paid.id,
      userId: paid.userId,
      amount: paid.amount,
      courseId: paid.courseId,
      referralCode: paid.referralCode,
    });

    return tx.order.findUniqueOrThrow({
      where: { id: paid.id },
      include: { course: true },
    });
  }, { maxWait: 10_000, timeout: 20_000 });
  await notifyKnowledgeCommunity(input.orderId);
  return paid;
}
