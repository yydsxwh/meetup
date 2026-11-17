import { notFound, redirect } from "next/navigation";
import { CheckoutOrderForm } from "@/components/checkout-order-form";
import { getSession } from "@andyyyds/shared/auth";
import { prisma } from "@andyyyds/shared/db";
import { parseStoredAnswers } from "@andyyyds/shared/order-form";
import { productKeyFromType } from "@andyyyds/shared/pay-center-account";
import { getPaymentChannels } from "@andyyyds/shared/payments";
import { getOrderFormConfig } from "@andyyyds/shared/site-settings";
import { isForumMembershipProductType } from "@andyyyds/forum/lib/forum-membership-plans";
import { productDetailPath } from "@andyyyds/shared/product-types";
import { formatPrice } from "@andyyyds/shared/utils";

export const dynamic = "force-dynamic";

export default async function CheckoutPage({
  params,
}: {
  params: Promise<{ orderId: string }>;
}) {
  const { orderId } = await params;
  const session = await getSession();
  if (!session) redirect("/login");

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { course: true, coupon: true },
  });
  if (!order || order.userId !== session.id) notFound();

  if (order.status === "PAID") {
    // 约搭回活动详情；商城回订单；专栏回详情选子课；单课/资料进学习页
    if (order.course.productType === "MEETUP") {
      redirect(productDetailPath(order.course.slug, "MEETUP"));
    }
    if (order.course.productType === "PRODUCT") {
      redirect(`/orders/${order.id}`);
    }
    if (order.course.productType === "COLUMN") {
      redirect(productDetailPath(order.course.slug, "COLUMN"));
    }
    if (order.course.productType === "MATHCODE") {
      redirect("/products/mathcode");
    }
    if (isForumMembershipProductType(order.course.productType)) {
      redirect(`/forum/membership?order=${order.id}`);
    }
    redirect(`/learn/${order.course.slug}`);
  }

  const [channels, orderForm] = await Promise.all([
    getPaymentChannels(productKeyFromType(order.course.productType)),
    getOrderFormConfig(),
  ]);
  const initialAnswers = parseStoredAnswers(order.formAnswersJson).values;

  return (
    <div className="container py-8 sm:py-16">
      <div className="surface mx-auto max-w-lg rounded-[28px] p-5 sm:p-8">
        <h1 className="text-2xl font-semibold">确认订单</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">订单号 {order.orderNo}</p>
        <div className="mt-6 space-y-3 text-sm">
          <div className="flex justify-between gap-4">
            <span>商品</span>
            <span className="text-right font-medium">{order.course.title}</span>
          </div>
          {order.specLabel ? (
            <div className="flex justify-between gap-4">
              <span>规格</span>
              <span className="text-right text-[var(--muted)]">{order.specLabel}</span>
            </div>
          ) : null}
          {order.quantity > 1 ? (
            <div className="flex justify-between gap-4">
              <span>数量</span>
              <span>×{order.quantity}</span>
            </div>
          ) : null}
          {order.discount > 0 ? (
            <div className="flex justify-between gap-4">
              <span>
                优惠
                {order.coupon ? `（${order.coupon.code}）` : ""}
              </span>
              <span className="text-[var(--fire)]">
                -{formatPrice(order.discount)}
              </span>
            </div>
          ) : (
            <div className="flex justify-between gap-4">
              <span>优惠</span>
              <span>-{formatPrice(0)}</span>
            </div>
          )}
          <div className="flex justify-between gap-4 text-lg font-semibold">
            <span>应付</span>
            <span className="text-[var(--brand)]">{formatPrice(order.amount)}</span>
          </div>
          {isForumMembershipProductType(order.course.productType) ? (
            <div className="space-y-2 text-sm leading-6 text-[var(--muted)]">
              {order.course.originalPrice > order.amount ? (
                <p>原价 {formatPrice(order.course.originalPrice)}，本次实收已按全年八折。</p>
              ) : null}
              <p>{order.specLabel || "按北京时间的自然月计算。"}不自动续费。支付成功页不会直接开通，权益等服务器确认收款。</p>
              <p>开通后可以在其他大学发帖和评论，不代表已通过该校认证。</p>
            </div>
          ) : null}
        </div>
        <div className="mt-8">
          <CheckoutOrderForm
            orderId={order.id}
            amount={order.amount}
            channels={channels}
            orderForm={orderForm}
            initialAnswers={initialAnswers}
            skipForm={isForumMembershipProductType(order.course.productType)}
          />
        </div>
      </div>
    </div>
  );
}
