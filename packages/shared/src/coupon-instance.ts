/**
 * 独立券：把旧公共券码升级成同一额度下的实例，并在下单时占用其中一张。
 * 不另造一份可消费预算，也不在前端用空数组冒充券。
 */

import { createHash } from "crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { planLegacyCouponBudget } from "./coupon-budget";
import {
  couponClaimAbsoluteUrl,
  couponTokenHint,
  decryptCouponToken,
  encryptCouponToken,
  generateCouponToken,
  hashCouponToken,
} from "./coupon-token";

type Db = PrismaClient | Prisma.TransactionClient;

export class CouponUseError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "CouponUseError";
    this.status = status;
  }
}

export function couponErrorPayload(error: unknown): { status: number; error: string } {
  if (error instanceof CouponUseError) {
    return { status: error.status, error: error.message };
  }
  return { status: 400, error: "优惠券操作失败，请稍后重试" };
}

const ACTIVE_USE = ["CLAIMED", "RESERVED", "REDEEMED"] as const;

function padSerial(n: number) {
  return String(n).padStart(6, "0");
}

function campaignCodeForCoupon(couponId: string) {
  const digest = createHash("sha256").update(couponId).digest("hex").slice(0, 12);
  return `C${digest.toUpperCase()}`;
}

function tokenFields() {
  const token = generateCouponToken();
  return {
    token,
    tokenHash: hashCouponToken(token),
    tokenEncrypted: encryptCouponToken(token),
    tokenHint: couponTokenHint(token),
  };
}

async function appendInstances(
  tx: Prisma.TransactionClient,
  campaign: { id: string; code: string; serialSeq: number },
  count: number,
  build: (serialNo: string, seq: number) => Prisma.CouponInstanceCreateManyInput,
) {
  if (count <= 0) return 0;
  const rows: Prisma.CouponInstanceCreateManyInput[] = [];
  for (let i = 1; i <= count; i += 1) {
    const seq = campaign.serialSeq + i;
    rows.push(build(`${campaign.code}-${padSerial(seq)}`, seq));
  }
  const moved = await tx.couponCampaign.updateMany({
    where: { id: campaign.id, serialSeq: campaign.serialSeq },
    data: { serialSeq: campaign.serialSeq + count },
  });
  if (moved.count !== 1) {
    throw new CouponUseError("COUPON_UPGRADE_CONFLICT");
  }
  await tx.couponInstance.createMany({ data: rows });
  return rows.length;
}

export type UpgradeResult = {
  campaignId: string;
  blocked: boolean;
  blockReason: string;
  issueCount: number;
  instanceCount: number;
  created: number;
  evidencedPaid: number;
  evidencedReserved: number;
  availableCount: number;
  done: boolean;
};

async function upgradeOnce(
  tx: Prisma.TransactionClient,
  couponId: string,
  chunk: number,
): Promise<UpgradeResult> {
  const coupon = await tx.coupon.findUnique({
    where: { id: couponId },
    include: { products: true, redemptions: true },
  });
  if (!coupon) throw new CouponUseError("优惠券不存在", 404);

  const orders = await tx.order.findMany({
    where: { couponId: coupon.id },
    select: {
      id: true,
      userId: true,
      status: true,
      paidAt: true,
      createdAt: true,
      couponInstanceId: true,
    },
  });
  const paidOrders = orders.filter((order) => order.status === "PAID");
  const pendingOrders = orders.filter((order) => order.status === "PENDING");

  let campaign = await tx.couponCampaign.findUnique({
    where: { legacyCouponId: coupon.id },
  });
  if (!campaign) {
    campaign = await tx.couponCampaign.create({
      data: {
        code: campaignCodeForCoupon(coupon.id),
        name: coupon.title,
        description: "由旧公共券码升级。活动入口和单张券共用这一额度。",
        type: coupon.type,
        discountCents: coupon.discountCents,
        percentOff: coupon.percentOff,
        issueCount: Math.max(0, coupon.maxUses),
        maxPerUser: Math.max(1, coupon.maxPerUser || 1),
        minAmount: coupon.minAmount,
        productScope: coupon.productScope || "ALL",
        startsAt: coupon.startsAt,
        expiresAt: coupon.expiresAt,
        claimStartsAt: coupon.startsAt,
        claimEndsAt: coupon.expiresAt,
        isActive: coupon.isActive,
        createdById: coupon.createdById || "",
        legacyCouponId: coupon.id,
        ...(coupon.productScope === "SELECTED"
          ? {
              products: {
                create: coupon.products.map((product) => ({ courseId: product.courseId })),
              },
            }
          : {}),
      },
    });
  }

  const existing = await tx.couponInstance.findMany({
    where: { campaignId: campaign.id },
    select: {
      source: true,
      redeemedOrderId: true,
      reservedOrderId: true,
      legacyRedemptionId: true,
    },
  });
  const historicalKeys = existing.flatMap((row) => {
    const keys: string[] = [];
    // 下单占用的实例 source 仍是 ISSUED，也要算进已占用，避免再插一条相同订单的历史券。
    if (row.redeemedOrderId) keys.push(`paid:${row.redeemedOrderId}`);
    if (row.reservedOrderId) keys.push(`pending:${row.reservedOrderId}`);
    if (row.legacyRedemptionId) keys.push(`redemption:${row.legacyRedemptionId}`);
    return keys;
  });
  const existingIssuedCount = existing.filter((row) => row.source === "ISSUED").length;
  const plan = planLegacyCouponBudget({
    maxUses: campaign.issueCount,
    usedCount: coupon.usedCount,
    redemptionIds: coupon.redemptions.map((row) => row.id),
    paidOrderIds: paidOrders.map((order) => order.id),
    pendingOrderIds: pendingOrders.map((order) => order.id),
    existingHistoricalKeys: historicalKeys,
    existingIssuedCount,
  });

  if (plan.blocked) {
    if (campaign.budgetHoldReason !== plan.blockReason) {
      await tx.couponCampaign.update({
        where: { id: campaign.id },
        data: { budgetHoldReason: plan.blockReason },
      });
    }
    const instanceCount = existing.length;
    return {
      campaignId: campaign.id,
      blocked: true,
      blockReason: plan.blockReason,
      issueCount: plan.issueCount,
      instanceCount,
      created: 0,
      evidencedPaid: plan.evidencedPaid,
      evidencedReserved: plan.evidencedReserved,
      availableCount: 0,
      done: false,
    };
  }

  if (campaign.budgetHoldReason) {
    await tx.couponCampaign.update({
      where: { id: campaign.id },
      data: { budgetHoldReason: "" },
    });
    campaign = { ...campaign, budgetHoldReason: "" };
  }

  let created = 0;
  let serialSeq = campaign.serialSeq;
  const historical = plan.historicalToCreate;
  if (historical.length > 0) {
    const paidById = new Map(paidOrders.map((order) => [order.id, order]));
    const pendingById = new Map(pendingOrders.map((order) => [order.id, order]));
    const redemptionById = new Map(coupon.redemptions.map((row) => [row.id, row]));
    created += await appendInstances(
      tx,
      { id: campaign.id, code: campaign.code, serialSeq },
      historical.length,
      (serialNo, index) => {
        const slot = historical[index - serialSeq - 1];
        if (!slot) throw new CouponUseError("升级序号错位");
        const secret = tokenFields();
        const base = {
          campaignId: campaign!.id,
          serialNo,
          tokenHash: secret.tokenHash,
          tokenEncrypted: secret.tokenEncrypted,
          tokenHint: secret.tokenHint,
          legacyCouponId: coupon.id,
        };
        if (slot.kind === "paid") {
          const order = paidById.get(slot.id);
          if (!order) throw new CouponUseError("找不到已支付订单");
          return {
            ...base,
            status: "REDEEMED",
            source: "LEGACY_PAID",
            claimedByUserId: order.userId,
            claimedAt: order.paidAt || order.createdAt,
            redeemedByUserId: order.userId,
            redeemedAt: order.paidAt || order.createdAt,
            redeemedOrderId: order.id,
          };
        }
        if (slot.kind === "pending") {
          const order = pendingById.get(slot.id);
          if (!order) throw new CouponUseError("找不到待支付订单");
          return {
            ...base,
            status: "RESERVED",
            source: "LEGACY_PENDING",
            claimedByUserId: order.userId,
            reservedOrderId: order.id,
            reservedAt: order.createdAt,
          };
        }
        const redemption = redemptionById.get(slot.id);
        if (!redemption) throw new CouponUseError("找不到核销记录");
        return {
          ...base,
          status: "REDEEMED",
          source: "LEGACY_REDEMPTION",
          claimedByUserId: redemption.userId,
          claimedAt: redemption.createdAt,
          redeemedByUserId: redemption.userId,
          redeemedAt: redemption.createdAt,
          legacyRedemptionId: redemption.id,
        };
      },
    );
    serialSeq += historical.length;
    for (const slot of historical) {
      if (slot.kind !== "paid" && slot.kind !== "pending") continue;
      const instance = await tx.couponInstance.findFirst({
        where: {
          campaignId: campaign.id,
          OR: [{ redeemedOrderId: slot.id }, { reservedOrderId: slot.id }],
        },
        select: { id: true },
      });
      if (!instance) continue;
      await tx.order.updateMany({
        where: { id: slot.id, couponInstanceId: null },
        data: { couponInstanceId: instance.id },
      });
    }
  }

  const room = Math.min(chunk, plan.availableToCreate);
  if (room > 0) {
    created += await appendInstances(
      tx,
      { id: campaign.id, code: campaign.code, serialSeq },
      room,
      (serialNo) => {
        const secret = tokenFields();
        return {
          campaignId: campaign!.id,
          serialNo,
          tokenHash: secret.tokenHash,
          tokenEncrypted: secret.tokenEncrypted,
          tokenHint: secret.tokenHint,
          status: coupon.isActive ? "AVAILABLE" : "DISABLED",
          source: "ISSUED",
          legacyCouponId: coupon.id,
          disabledAt: coupon.isActive ? null : new Date(),
        };
      },
    );
  }

  if (coupon.usedCount < plan.evidencedTotal) {
    await tx.coupon.update({
      where: { id: coupon.id },
      data: { usedCount: plan.evidencedTotal },
    });
  }

  const [instanceCount, availableCount] = await Promise.all([
    tx.couponInstance.count({ where: { campaignId: campaign.id } }),
    tx.couponInstance.count({
      where: { campaignId: campaign.id, status: "AVAILABLE" },
    }),
  ]);

  return {
    campaignId: campaign.id,
    blocked: false,
    blockReason: "",
    issueCount: plan.issueCount,
    instanceCount,
    created,
    evidencedPaid: plan.evidencedPaid,
    evidencedReserved: plan.evidencedReserved,
    availableCount,
    done: instanceCount >= plan.issueCount,
  };
}

export async function upgradeLegacyCoupon(
  db: Db,
  couponId: string,
  opts?: { chunk?: number },
): Promise<UpgradeResult> {
  const chunk = Math.min(500, Math.max(1, Math.floor(opts?.chunk ?? 200)));
  const run = (tx: Prisma.TransactionClient) => upgradeOnce(tx, couponId, chunk);
  if ("$transaction" in db) {
    return db.$transaction((tx) => run(tx), { timeout: 30_000 });
  }
  return run(db as Prisma.TransactionClient);
}

export async function upgradeLegacyCouponRetry(
  db: PrismaClient,
  couponId: string,
  opts?: { chunk?: number },
) {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await upgradeLegacyCoupon(db, couponId, opts);
    } catch (error) {
      last = error;
      if (!(error instanceof CouponUseError) || error.message !== "COUPON_UPGRADE_CONFLICT") {
        throw error;
      }
    }
  }
  throw last;
}

export async function upgradeAllLegacyCoupons(db: PrismaClient, chunk = 200) {
  const coupons = await db.coupon.findMany({ select: { id: true }, orderBy: { createdAt: "asc" } });
  const results = [];
  for (const coupon of coupons) {
    let result = await upgradeLegacyCouponRetry(db, coupon.id, { chunk });
    let guard = 0;
    while (!result.done && !result.blocked && guard < 10000) {
      result = await upgradeLegacyCouponRetry(db, coupon.id, { chunk });
      guard += 1;
      if (result.created === 0) break;
    }
    results.push(result);
  }
  return results;
}

async function userUsage(tx: Prisma.TransactionClient, campaignId: string, userId: string) {
  return tx.couponInstance.count({
    where: {
      campaignId,
      claimedByUserId: userId,
      status: { in: [...ACTIVE_USE] },
    },
  });
}

export async function allocateSharedCoupon(
  tx: Prisma.TransactionClient,
  input: {
    couponId: string;
    userId: string;
    orderId: string;
    settle: "RESERVE" | "REDEEM";
    now?: Date;
  },
): Promise<{ mode: "legacy" } | { mode: "instance"; instanceId: string }> {
  const now = input.now || new Date();
  const campaign = await tx.couponCampaign.findUnique({
    where: { legacyCouponId: input.couponId },
  });
  if (!campaign || campaign.deletedAt || campaign.budgetHoldReason) {
    return { mode: "legacy" };
  }
  if (!campaign.isActive) throw new CouponUseError("优惠券已停用");
  if (campaign.startsAt && campaign.startsAt > now) throw new CouponUseError("优惠券尚未开始");
  if (campaign.expiresAt && campaign.expiresAt < now) throw new CouponUseError("优惠券已过期");

  const used = await userUsage(tx, campaign.id, input.userId);
  const mine = await tx.couponInstance.findFirst({
    where: {
      campaignId: campaign.id,
      claimedByUserId: input.userId,
      status: "CLAIMED",
    },
    orderBy: { serialNo: "asc" },
  });
  if (!mine && used >= Math.max(1, campaign.maxPerUser)) {
    throw new CouponUseError("该优惠券已使用过");
  }

  let instanceId = mine?.id || "";
  if (!instanceId) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = await tx.couponInstance.findFirst({
        where: { campaignId: campaign.id, status: "AVAILABLE" },
        orderBy: { serialNo: "asc" },
        select: { id: true },
      });
      if (!candidate) throw new CouponUseError("优惠券已领完");
      const taken = await tx.couponInstance.updateMany({
        where: { id: candidate.id, status: "AVAILABLE" },
        data: {
          status: input.settle === "REDEEM" ? "REDEEMED" : "RESERVED",
          claimedByUserId: input.userId,
          reservedOrderId: input.settle === "RESERVE" ? input.orderId : null,
          reservedAt: input.settle === "RESERVE" ? now : null,
          redeemedOrderId: input.settle === "REDEEM" ? input.orderId : null,
          redeemedByUserId: input.settle === "REDEEM" ? input.userId : null,
          redeemedAt: input.settle === "REDEEM" ? now : null,
          version: { increment: 1 },
        },
      });
      if (taken.count === 1) {
        instanceId = candidate.id;
        break;
      }
    }
  } else {
    const taken = await tx.couponInstance.updateMany({
      where: { id: instanceId, status: "CLAIMED", claimedByUserId: input.userId },
      data: {
        status: input.settle === "REDEEM" ? "REDEEMED" : "RESERVED",
        reservedOrderId: input.settle === "RESERVE" ? input.orderId : null,
        reservedAt: input.settle === "RESERVE" ? now : null,
        redeemedOrderId: input.settle === "REDEEM" ? input.orderId : null,
        redeemedByUserId: input.settle === "REDEEM" ? input.userId : null,
        redeemedAt: input.settle === "REDEEM" ? now : null,
        version: { increment: 1 },
      },
    });
    if (taken.count !== 1) throw new CouponUseError("优惠券占用失败，请重试");
  }
  if (!instanceId) throw new CouponUseError("优惠券占用失败，请重试");

  await tx.order.update({
    where: { id: input.orderId },
    data: { couponInstanceId: instanceId },
  });
  return { mode: "instance", instanceId };
}

export async function redeemReservedInstance(
  tx: Prisma.TransactionClient,
  input: { orderId: string; userId: string; now?: Date },
) {
  const now = input.now || new Date();
  const already = await tx.couponInstance.findFirst({
    where: { redeemedOrderId: input.orderId },
  });
  if (already) return already;
  const reserved = await tx.couponInstance.findFirst({
    where: { reservedOrderId: input.orderId, status: "RESERVED" },
  });
  if (!reserved) return null;
  if (reserved.claimedByUserId && reserved.claimedByUserId !== input.userId) {
    throw new CouponUseError("不能核销他人的优惠券");
  }
  const updated = await tx.couponInstance.updateMany({
    where: { id: reserved.id, status: "RESERVED", reservedOrderId: input.orderId },
    data: {
      status: "REDEEMED",
      redeemedByUserId: input.userId,
      redeemedAt: now,
      redeemedOrderId: input.orderId,
      reservedOrderId: null,
      reservedAt: null,
      version: { increment: 1 },
    },
  });
  if (updated.count === 0) {
    return tx.couponInstance.findFirst({ where: { redeemedOrderId: input.orderId } });
  }
  return tx.couponInstance.findUnique({ where: { id: reserved.id } });
}

export async function releaseReservedInstance(tx: Prisma.TransactionClient, orderId: string) {
  const reserved = await tx.couponInstance.findFirst({
    where: { reservedOrderId: orderId, status: "RESERVED" },
  });
  if (!reserved) return;
  const backToClaim = Boolean(reserved.claimedAt);
  await tx.couponInstance.updateMany({
    where: { id: reserved.id, status: "RESERVED", reservedOrderId: orderId },
    data: backToClaim
      ? {
          status: "CLAIMED",
          reservedOrderId: null,
          reservedAt: null,
          version: { increment: 1 },
        }
      : {
          status: "AVAILABLE",
          claimedByUserId: null,
          reservedOrderId: null,
          reservedAt: null,
          version: { increment: 1 },
        },
  });
}

export async function findInstanceByToken(db: Db, token: string) {
  return db.couponInstance.findUnique({
    where: { tokenHash: hashCouponToken(token.trim()) },
    include: {
      campaign: { include: { products: { select: { courseId: true } } } },
    },
  });
}

export async function previewInstanceByToken(db: Db, token: string, viewerId?: string) {
  const row = await findInstanceByToken(db, token);
  if (!row || row.campaign.deletedAt) {
    return { error: "优惠券不存在" as const, status: 404 as const };
  }
  const now = new Date();
  let status = row.status;
  if (
    status !== "DISABLED" &&
    status !== "REDEEMED" &&
    row.campaign.expiresAt &&
    row.campaign.expiresAt < now
  ) {
    status = "EXPIRED";
  }
  const mine = Boolean(viewerId && row.claimedByUserId === viewerId);
  let claimState: "open" | "mine" | "taken" | "blocked" = "open";
  let message = "";
  if (status === "DISABLED" || !row.campaign.isActive) {
    claimState = "blocked";
    message = "该优惠券已停用";
  } else if (status === "EXPIRED") {
    claimState = "blocked";
    message = "优惠券已过期";
  } else if (status === "REDEEMED" || status === "RESERVED" || status === "CLAIMED") {
    claimState = mine ? "mine" : "taken";
    message = mine ? "你已领取" : "该优惠券已被领取";
  } else if (row.campaign.claimStartsAt && row.campaign.claimStartsAt > now) {
    claimState = "blocked";
    message = "尚未开始领取";
  } else if (row.campaign.claimEndsAt && row.campaign.claimEndsAt < now) {
    claimState = "blocked";
    message = "领取已结束";
  }
  return {
    instanceId: row.id,
    serialNo: row.serialNo,
    tokenHint: row.tokenHint,
    status,
    source: row.source,
    claimState,
    message,
    campaign: {
      id: row.campaign.id,
      name: row.campaign.name,
      description: row.campaign.description,
      type: row.campaign.type,
      discountCents: row.campaign.discountCents,
      percentOff: row.campaign.percentOff,
      minAmount: row.campaign.minAmount,
      productScope: row.campaign.productScope,
      productIds: row.campaign.products.map((product) => product.courseId),
      maxPerUser: row.campaign.maxPerUser,
    },
  };
}

export async function claimInstanceByToken(
  db: PrismaClient,
  input: { token: string; userId: string; now?: Date },
) {
  const now = input.now || new Date();
  const token = input.token.trim();
  if (!token) throw new CouponUseError("领取链接无效");
  return db.$transaction(async (tx) => {
    const row = await findInstanceByToken(tx, token);
    if (!row || row.campaign.deletedAt) throw new CouponUseError("优惠券不存在", 404);
    if (row.claimedByUserId === input.userId && row.status !== "AVAILABLE") {
      return { ok: true as const, already: true, instanceId: row.id, campaignId: row.campaign.id };
    }
    if (row.status !== "AVAILABLE") throw new CouponUseError("该优惠券已被领取");
    if (!row.campaign.isActive) throw new CouponUseError("优惠券已停用");
    if (row.campaign.expiresAt && row.campaign.expiresAt < now) {
      throw new CouponUseError("优惠券已过期");
    }
    const used = await userUsage(tx, row.campaign.id, input.userId);
    if (used >= Math.max(1, row.campaign.maxPerUser)) {
      throw new CouponUseError("已达到领取上限");
    }
    const updated = await tx.couponInstance.updateMany({
      where: { id: row.id, status: "AVAILABLE", claimedByUserId: null },
      data: {
        status: "CLAIMED",
        claimedByUserId: input.userId,
        claimedAt: now,
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) throw new CouponUseError("该优惠券已被领取");
    return { ok: true as const, already: false, instanceId: row.id, campaignId: row.campaign.id };
  });
}

export async function instanceShareUrl(db: Db, instanceId: string, baseUrl: string) {
  const row = await db.couponInstance.findUnique({
    where: { id: instanceId },
    select: { tokenEncrypted: true, status: true, source: true, serialNo: true },
  });
  if (!row) throw new CouponUseError("优惠券不存在", 404);
  if (row.status !== "AVAILABLE" && row.status !== "CLAIMED") {
    throw new CouponUseError("这张券已领取或已核销，不能当作新券发给别人");
  }
  const token = decryptCouponToken(row.tokenEncrypted);
  return {
    url: couponClaimAbsoluteUrl(token, baseUrl),
    serialNo: row.serialNo,
    status: row.status,
    source: row.source,
  };
}

export async function campaignInstanceStats(db: Db, campaignId: string) {
  const grouped = await db.couponInstance.groupBy({
    by: ["status"],
    where: { campaignId },
    _count: { _all: true },
  });
  const counts: Record<string, number> = {};
  for (const row of grouped) counts[row.status] = row._count._all;
  const instanceCount = Object.values(counts).reduce((sum, n) => sum + n, 0);
  return {
    instanceCount,
    available: counts.AVAILABLE || 0,
    claimed: counts.CLAIMED || 0,
    reserved: counts.RESERVED || 0,
    redeemed: counts.REDEEMED || 0,
    expired: counts.EXPIRED || 0,
    disabled: counts.DISABLED || 0,
  };
}
