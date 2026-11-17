/** 单张券领取页。可在浏览器里使用，不含密钥。 */

export function couponClaimPath(token: string): string {
  return `/coupon/claim/${encodeURIComponent(token)}`;
}

export function couponClaimLoginPath(token: string): string {
  return `/login?next=${encodeURIComponent(couponClaimPath(token))}`;
}

export function couponClaimAbsoluteUrl(token: string, base: string): string {
  return `${base.replace(/\/$/, "")}${couponClaimPath(token)}`;
}
