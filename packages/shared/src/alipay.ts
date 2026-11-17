/**
 * 支付宝电脑网站 / 手机网站支付封装（核心）
 *
 * - page.pay：电脑端跳转收银台（FAST_INSTANT_TRADE_PAY）
 * - wap.pay：手机端跳转收银台（QUICK_WAP_WAY）
 *
 * 配置：系统设置里的 AppID、应用私钥、支付宝公钥（RSA2）。
 * 异步通知验签用「支付宝公钥」，不要填成应用公钥。
 */

import crypto from "crypto";
import { readCallbackAccounts, readCenterAccount, readCenterProfile } from "./pay-center-account";
import type { AccountLoad } from "./payment-account-lock";
import { getPublicSiteUrl } from "./payments";
import { getSiteSettings } from "./site-settings";

export type AlipayConfig = {
  appId: string;
  privateKey: string;
  alipayPublicKey: string;
  gateway: string;
  profileId: string;
  profileVersion: number;
};

function normalizePem(key: string, type: "PRIVATE" | "PUBLIC") {
  const cleaned = key
    .replace(/\\n/g, "\n")
    .replace(/-----BEGIN[\w\s]+-----/g, "")
    .replace(/-----END[\w\s]+-----/g, "")
    .replace(/\s+/g, "");
  const lines = cleaned.match(/.{1,64}/g) || [];
  if (type === "PRIVATE") {
    return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----`;
  }
  return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----`;
}

function alipayGateway(mode: string) {
  return mode === "sandbox"
    ? "https://openapi-sandbox.dl.alipaydev.com/gateway.do"
    : "https://openapi.alipay.com/gateway.do";
}

function alipayConfigFromParts(input: {
  appId: string;
  privateKey: string;
  alipayPublicKey: string;
  gatewayMode: string;
  profileId?: string;
  profileVersion?: number;
}, incomplete: string): AlipayConfig {
  if (!input.appId || !input.privateKey || !input.alipayPublicKey) throw new Error(incomplete);
  return {
    appId: input.appId,
    privateKey: normalizePem(input.privateKey, "PRIVATE"),
    alipayPublicKey: normalizePem(input.alipayPublicKey, "PUBLIC"),
    gateway: alipayGateway(input.gatewayMode),
    profileId: input.profileId || "",
    profileVersion: input.profileVersion || 0,
  };
}

/** 主站系统设置里的原支付宝。旧订单验签继续用它。 */
export async function legacyAlipayConfig(): Promise<AlipayConfig> {
  const settings = await getSiteSettings();
  return alipayConfigFromParts({
    appId: settings.alipayAppId || process.env.ALIPAY_APP_ID || "",
    privateKey: settings.alipayPrivateKey || process.env.ALIPAY_PRIVATE_KEY || "",
    alipayPublicKey: settings.alipayPublicKey || process.env.ALIPAY_PUBLIC_KEY || "",
    gatewayMode: settings.alipayGateway || process.env.ALIPAY_GATEWAY || "production",
  }, "支付宝参数不完整，请在「系统设置」中填写");
}

async function alipayCandidates(): Promise<AlipayConfig[]> {
  const configs: AlipayConfig[] = [];
  try {
    configs.push(await legacyAlipayConfig());
  } catch {
    // 旧密钥缺失时仍可尝试历史版本。
  }
  const remote = await readCallbackAccounts("ALIPAY");
  for (const item of remote) {
    if (!item.appId || !item.privateKeyPem || !item.alipayPublicKeyPem) continue;
    try {
      configs.push(alipayConfigFromParts({
        appId: item.appId,
        privateKey: item.privateKeyPem,
        alipayPublicKey: item.alipayPublicKeyPem,
        gatewayMode: item.gatewayMode,
        profileId: item.profileId,
        profileVersion: 0,
      }, "历史支付宝账户不完整"));
    } catch {
      // 缺字段的历史版本不能顶替别的应用。
    }
  }
  return configs;
}

/**
 * 不传 lock 时用该产品当前绑定。已发起的订单传入 lock，读不到原账户就失败。
 */
export async function getAlipayConfig(product = "main", lock?: AccountLoad): Promise<AlipayConfig> {
  if (lock?.profileId) {
    const remote = await readCenterProfile(lock.profileId);
    if (remote.kind !== "READY" || remote.provider !== "ALIPAY") {
      throw new Error("原支付宝账户暂时不可用，没有改用其他商户");
    }
    const pub = remote.body.public || {};
    const secrets = remote.body.secrets || {};
    const cfg = alipayConfigFromParts({
      appId: pub.appId || "",
      privateKey: secrets.privateKeyPem || "",
      alipayPublicKey: secrets.alipayPublicKeyPem || "",
      gatewayMode: pub.gatewayMode || "production",
      profileId: remote.profileId,
      profileVersion: remote.version,
    }, "原支付宝账户不完整，没有改用其他商户");
    if (lock.merchantId && cfg.appId !== lock.merchantId) {
      throw new Error("原支付宝账户与下单应用不一致，没有改用其他商户");
    }
    return cfg;
  }
    if (lock?.merchantId) {
    const appId = lock.appId || lock.merchantId;
    const found = (await alipayCandidates()).find((item) => item.appId === appId);
    if (!found) throw new Error("原支付宝应用暂时不可用，没有改用其他商户");
    return found;
  }
  if (lock?.legacy) return legacyAlipayConfig();

  const remote = await readCenterAccount(product, "ALIPAY");
  if (remote.kind === "OFF") throw new Error("该产品已关闭新的支付");
  if (remote.kind === "INVALID") throw new Error("指定支付账户无效，没有改用其他商户");
  if (remote.kind === "UNAVAILABLE") throw new Error("支付配置暂时不可用");
  if (remote.kind === "READY") {
    const pub = remote.body.public || {};
    const secrets = remote.body.secrets || {};
    return alipayConfigFromParts({
      appId: pub.appId || "",
      privateKey: secrets.privateKeyPem || "",
      alipayPublicKey: secrets.alipayPublicKeyPem || "",
      gatewayMode: pub.gatewayMode || "production",
      profileId: remote.profileId,
      profileVersion: remote.version,
    }, "支付中心的支付宝账户不完整，没有改用其他商户");
  }
  return legacyAlipayConfig();
}

/** 回调只验原应用的公钥。别的应用签过不算这笔订单。 */
export async function alipayConfigsForLock(product: string, lock: AccountLoad): Promise<AlipayConfig[]> {
  if (lock.profileId) return [await getAlipayConfig(product, lock)];
  if (lock.merchantId || lock.appId) {
    const appId = lock.appId || lock.merchantId;
    const matched = (await alipayCandidates()).filter((item) => item.appId === appId);
    if (!matched.length) throw new Error("原支付宝应用暂时不可用，没有改用其他商户");
    return matched;
  }
  if (lock.legacy) return [await legacyAlipayConfig()];
  throw new Error("没有原支付宝应用，没有改用其他商户");
}

function signParams(params: Record<string, string>, privateKey: string) {
  const content = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== "" && k !== "sign")
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(content, "utf8");
  signer.end();
  return signer.sign(privateKey, "base64");
}

function alipayTimestamp() {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

/**
 * 拼支付宝网关跳转 URL（GET 表单等价参数 + sign）。
 * 金额以「元」两位小数字符串提交；库内订单金额是「分」。
 */
async function buildAlipayPayUrl(input: {
  orderNo: string;
  subject: string;
  amountCents: number;
  method: "alipay.trade.page.pay" | "alipay.trade.wap.pay";
  productCode: string;
  product?: string;
  lock?: AccountLoad;
}) {
  const cfg = await getAlipayConfig(input.product || "main", input.lock);
  const siteUrl = await getPublicSiteUrl();
  const amountYuan = (input.amountCents / 100).toFixed(2);
  const bizContent = JSON.stringify({
    out_trade_no: input.orderNo,
    product_code: input.productCode,
    total_amount: amountYuan,
    subject: input.subject.slice(0, 256),
  });

  const params: Record<string, string> = {
    app_id: cfg.appId,
    method: input.method,
    format: "JSON",
    charset: "utf-8",
    sign_type: "RSA2",
    timestamp: alipayTimestamp(),
    version: "1.0",
    notify_url: `${siteUrl}/api/payments/alipay/notify`,
    return_url: `${siteUrl}/checkout/return`,
    biz_content: bizContent,
  };

  params.sign = signParams(params, cfg.privateKey);
  const qs = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return {
    payUrl: `${cfg.gateway}?${qs}`,
    notifyUrl: params.notify_url,
    profileId: cfg.profileId,
    profileVersion: cfg.profileVersion,
    merchantId: cfg.appId,
    appId: cfg.appId,
  };
}

export function verifyAlipayNotify(
  params: Record<string, string>,
  alipayPublicKey: string,
) {
  const sign = params.sign;
  const signType = params.sign_type || "RSA2";
  if (!sign || signType !== "RSA2") return false;
  const content = Object.keys(params)
    .filter(
      (k) =>
        params[k] !== undefined &&
        params[k] !== "" &&
        k !== "sign" &&
        k !== "sign_type",
    )
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  const verifier = crypto.createVerify("RSA-SHA256");
  verifier.update(content, "utf8");
  verifier.end();
  return verifier.verify(alipayPublicKey, sign, "base64");
}

/** 电脑网站支付 */
export async function createAlipayPagePay(input: {
  orderNo: string;
  subject: string;
  amountCents: number;
  product?: string;
  lock?: AccountLoad;
}) {
  return buildAlipayPayUrl({
    ...input,
    method: "alipay.trade.page.pay",
    productCode: "FAST_INSTANT_TRADE_PAY",
  });
}

/** 手机网站支付（H5 / 手机浏览器） */
export async function createAlipayWapPay(input: {
  orderNo: string;
  subject: string;
  amountCents: number;
  product?: string;
  lock?: AccountLoad;
}) {
  return buildAlipayPayUrl({
    ...input,
    method: "alipay.trade.wap.pay",
    productCode: "QUICK_WAP_WAY",
  });
}
