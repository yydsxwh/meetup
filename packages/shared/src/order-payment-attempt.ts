/**
 * 每次支付尝试单独落库。
 * 订单上的 payProfileId / payMerchantId 只是第一笔的快照，后续尝试不能靠改这两个字段换商户。
 */

import type { Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

export type PaymentAttemptInput = {
  orderId: string;
  provider: "WECHAT" | "ALIPAY";
  method: string;
  profileId: string;
  profileVersion: number;
  merchantId: string;
  appId: string;
  amountCents: number;
  outTradeNo: string;
};

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS "OrderPaymentAttempt" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "orderId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "method" TEXT NOT NULL,
  "profileId" TEXT NOT NULL DEFAULT '',
  "profileVersion" INTEGER NOT NULL DEFAULT 0,
  "merchantId" TEXT NOT NULL DEFAULT '',
  "appId" TEXT NOT NULL DEFAULT '',
  "amountCents" INTEGER NOT NULL,
  "outTradeNo" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderPaymentAttempt_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE CASCADE ON UPDATE CASCADE
)`;

const CREATE_UNIQUE = `
CREATE UNIQUE INDEX IF NOT EXISTS "OrderPaymentAttempt_orderId_provider_key"
ON "OrderPaymentAttempt"("orderId", "provider")`;

const CREATE_LOOKUP = `
CREATE INDEX IF NOT EXISTS "OrderPaymentAttempt_outTradeNo_provider_idx"
ON "OrderPaymentAttempt"("outTradeNo", "provider")`;

export function applyOrderPaymentAttemptMigrationSync(db: {
  exec: (sql: string) => void;
  prepare: (sql: string) => { all: (...args: unknown[]) => unknown[] };
}): "present" | "created" {
  const rows = db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'OrderPaymentAttempt'`,
  ).all();
  if (rows.length > 0) {
    db.exec(CREATE_UNIQUE);
    db.exec(CREATE_LOOKUP);
    return "present";
  }
  db.exec(CREATE_TABLE);
  db.exec(CREATE_UNIQUE);
  db.exec(CREATE_LOOKUP);
  return "created";
}

export async function applyOrderPaymentAttemptMigration(db: {
  $queryRawUnsafe: (sql: string) => Promise<unknown>;
  $executeRawUnsafe: (sql: string) => Promise<unknown>;
}): Promise<"present" | "created"> {
  const rows = await db.$queryRawUnsafe(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'OrderPaymentAttempt'`,
  );
  if (Array.isArray(rows) && rows.length > 0) {
    await db.$executeRawUnsafe(CREATE_UNIQUE);
    await db.$executeRawUnsafe(CREATE_LOOKUP);
    return "present";
  }
  await db.$executeRawUnsafe(CREATE_TABLE);
  await db.$executeRawUnsafe(CREATE_UNIQUE);
  await db.$executeRawUnsafe(CREATE_LOOKUP);
  return "created";
}

function sameIdentity(existing: {
  profileId: string;
  profileVersion: number;
  merchantId: string;
  appId: string;
}, input: PaymentAttemptInput) {
  if (existing.merchantId && input.merchantId && existing.merchantId !== input.merchantId) {
    throw new Error("这笔订单已锁定原商户，没有改用新商户");
  }
  if (existing.appId && input.appId && existing.appId !== input.appId) {
    throw new Error("这笔订单已锁定原应用，没有改用新应用");
  }
  if (existing.profileId && input.profileId && existing.profileId !== input.profileId) {
    throw new Error("这笔订单已锁定原支付账户，没有改用新账户");
  }
  if (existing.profileVersion && input.profileVersion && existing.profileVersion !== input.profileVersion) {
    throw new Error("这笔订单已锁定原账户版本，没有改用新版本");
  }
}

export async function lockOrderPaymentAttempt(db: Db, input: PaymentAttemptInput) {
  const where = { orderId_provider: { orderId: input.orderId, provider: input.provider } };
  const existing = await db.orderPaymentAttempt.findUnique({ where });
  if (existing) {
    sameIdentity(existing, input);
    return existing;
  }
  try {
    return await db.orderPaymentAttempt.create({
      data: {
        orderId: input.orderId,
        provider: input.provider,
        method: input.method,
        profileId: input.profileId,
        profileVersion: input.profileVersion,
        merchantId: input.merchantId,
        appId: input.appId,
        amountCents: input.amountCents,
        outTradeNo: input.outTradeNo,
        status: "PENDING",
      },
    });
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String((error as { code: unknown }).code) : "";
    if (code !== "P2002") throw error;
    const raced = await db.orderPaymentAttempt.findUnique({ where });
    if (!raced) throw error;
    sameIdentity(raced, input);
    return raced;
  }
}
