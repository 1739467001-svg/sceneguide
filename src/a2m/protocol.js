import crypto from 'node:crypto';

/**
 * A2M 智能收（HTTP 402）协议核心。
 *
 * 结构与签名规则严格对齐官方参考实现：
 *   github.com/alipay/ai → code_example/aipay-402-example/A2MPaymentDemoController.java
 *   github.com/alipay/ai → skills/alipay-aipay/references/integration/modules/code-examples/nodejs/4-按量付费/A2MPaymentDemo.md
 *
 * ⚠️ 与 aipay 官网 MACHINE_PAY.md 的差异（以官方参考实现为准）：
 *   官网写的是 `amtPaymentLink` 响应头 + 调 precreate OpenAPI；
 *   官方参考实现与买方 Skill（alipay-pay-for-402-service）实际使用 `Payment-Needed` 头 + 商家本地 RSA2 签名。
 *   买方 Agent 只认 `Payment-Needed`，所以必须发 `Payment-Needed`。
 */

/** RSA2 = RSA-SHA256 with PKCS#1 v1.5 padding */
export const SIGN_TYPE = 'RSA2';

const keyCache = new Map();

/**
 * 把 base64 DER 私钥解析成 Node KeyObject。
 * PKCS#1（appPrivatePkcsKey，Node/Python/Go/PHP 使用）与 PKCS#8（appPrivateKey，Java 使用）都支持。
 * 原始配置值不做任何改写，解析只发生在调用边界。
 */
export function parsePrivateKey(privateKeyB64) {
  if (keyCache.has(privateKeyB64)) return keyCache.get(privateKeyB64);

  const der = Buffer.from(privateKeyB64, 'base64');
  let key;
  try {
    key = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs1' });
  } catch {
    key = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  }
  keyCache.set(privateKeyB64, key);
  return key;
}

/**
 * 生成 PEM 文本，供 alipay-sdk 使用。
 *
 * ⚠️ 必须是 **PKCS#1** PEM（`-----BEGIN RSA PRIVATE KEY-----`）：
 *   alipay-sdk 的 formatKey(key, privateKeyType) 会剥掉首尾的 PEM 标记再重新包上，
 *   而 privateKeyType 默认是 'RSA PRIVATE KEY'（即 PKCS#1）。
 *   若这里给出 PKCS#8（'PRIVATE KEY'），formatKey 匹配不到标记会保留它，
 *   最终产出嵌套 PEM 头，OpenSSL 直接报 "DECODER routines::unsupported"。
 *   沙箱配置里 Node 用的是 appPrivatePkcsKey（PKCS#1），与官方 Node 参考实现一致。
 */
export function toPem(privateKeyB64) {
  const key = parsePrivateKey(privateKeyB64);
  // 统一转成 PKCS#1：若原本是 PKCS#8，这里完成降级转换
  return key.export({ type: 'pkcs1', format: 'pem' });
}

/**
 * 构造商家签名内容：key 字典序 → 跳过 null/空串 → `k=v&k=v`
 * 与官方 Node 参考实现 generateSellerSignature 的过滤条件保持一致。
 */
export function buildSignContent(params) {
  return Object.keys(params)
    .sort()
    // ⚠️ 必须与官方 Java 参考实现逐字一致：`value != null && !value.trim().isEmpty()`
    //    ——**只判断 `!== ''` 不够**：只含空白的值（如 '  '）在官方被跳过，
    //    在我们这里却会参与签名 → 签名内容与官方不一致 → 验签失败。
    //    （2026-11-23 由 scripts/protocol-unit-check.mjs 抓出）
    .filter((key) => {
      const v = params[key];
      return v !== null && v !== undefined && String(v).trim() !== '';
    })
    .map((key) => `${key}=${params[key]}`)
    .join('&');
}

/** RSA2 签名，输出 base64 */
export function rsaSign(signContent, privateKeyB64) {
  return crypto
    .createSign('RSA-SHA256')
    .update(signContent, 'utf8')
    .sign(parsePrivateKey(privateKeyB64), 'base64');
}

/** Base64URL 编码（去 padding，+ → -，/ → _） */
export function base64UrlEncode(input) {
  return Buffer.from(input, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/** Base64URL 解码（自动补 padding） */
export function base64UrlDecode(input) {
  let value = String(input);
  while (value.length % 4) value += '=';
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

/** 金额规范化：'9.9' → '9.90'，'9' → '9.00' */
export function normalizeAmount(value) {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value ?? '').trim());
  if (!match) return null;
  return `${BigInt(match[1]).toString()}.${(match[2] || '').padEnd(2, '0')}`;
}

/** 金额比较用，避免浮点误差 */
export function amountsEqual(left, right) {
  const a = normalizeAmount(left);
  const b = normalizeAmount(right);
  return a !== null && b !== null && a === b;
}

/** ISO 8601 带时区偏移量：2026-05-15T12:08:36+08:00 */
export function formatISO8601WithTimezone(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  const offset = -date.getTimezoneOffset();
  const offsetHours = pad(Math.floor(Math.abs(offset) / 60));
  const offsetMinutes = pad(Math.abs(offset) % 60);
  const offsetSign = offset >= 0 ? '+' : '-';
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${offsetSign}${offsetHours}:${offsetMinutes}`;
}

/**
 * 构造 Payment-Needed 载荷。
 *
 * 官方参考实现中，**参与签名的字段是扁平子集**（8 个），而载荷本身是 protocol/method 嵌套结构。
 * 签名内容不包含 seller_signature 自身。
 */
/**
 * 官方约定的**参与签名的扁平字段集**（8 个）。
 *
 * 依据：官方参考实现 `A2MPaymentDemoController.java` 与官方 Node 参考实现
 * `generateSellerSignature` —— 签名内容是跨 protocol/method 抽取的**扁平 8 字段**，
 * 而载荷本身是 protocol/method **嵌套**结构（这是官方文档未写明、实测踩出来的一条）。
 *
 * ⚠️ 以下字段**不参与签名**（但会出现在载荷里）：
 *    seller_signature（不参与自身签名）、seller_app_id、seller_name、
 *    seller_sign_type、seller_unique_id、seller_unique_id_key
 */
export const SIGNED_FIELD_NAMES = Object.freeze([
  'amount',
  'currency',
  'goods_name',
  'out_trade_no',
  'pay_before',
  'resource_id',
  'seller_id',
  'service_id',
]);

export function buildPaymentNeeded({
  outTradeNo,
  amount,
  currency = 'CNY',
  resourceId,
  payBefore,
  goodsName,
  sellerId,
  sellerName,
  sellerAppId,
  serviceId,
  privateKeyB64,
}) {
  // 签名字段集 = 官方 8 字段（常量是单一事实来源，避免手写清单与常量漂移）
  const signedFields = {
    amount,
    currency,
    goods_name: goodsName,
    out_trade_no: outTradeNo,
    pay_before: payBefore,
    resource_id: resourceId,
    seller_id: sellerId,
    service_id: serviceId,
  };
  // 自检：手写清单必须与官方常量一致（多一个/少一个都会导致验签失败）
  const actual = Object.keys(signedFields).sort();
  const expected = [...SIGNED_FIELD_NAMES].sort();
  if (actual.join(',') !== expected.join(',')) {
    throw new Error(
      `签名字段集与官方约定不一致：\n  实际 ${actual.join(',')}\n  期望 ${expected.join(',')}`,
    );
  }
  const sellerSignature = rsaSign(buildSignContent(signedFields), privateKeyB64);

  return {
    protocol: {
      out_trade_no: outTradeNo,
      amount,
      currency,
      resource_id: resourceId,
      pay_before: payBefore,
      seller_signature: sellerSignature,
      seller_sign_type: SIGN_TYPE,
      seller_unique_id: sellerId,
    },
    method: {
      seller_name: sellerName,
      seller_id: sellerId,
      seller_app_id: sellerAppId,
      goods_name: goodsName,
      seller_unique_id_key: 'seller_id',
      service_id: serviceId,
    },
  };
}

/**
 * 解析 Payment-Proof 请求头（Base64URL JSON）。
 * client_session 必须原样透传给支付宝校验接口，不得修改、缓存或自行构造。
 */
export function parsePaymentProof(headerValue) {
  let decoded;
  try {
    decoded = JSON.parse(base64UrlDecode(headerValue));
  } catch {
    return { ok: false, reason: 'MALFORMED' };
  }
  const paymentProof = decoded?.protocol?.payment_proof;
  const tradeNo = decoded?.protocol?.trade_no;
  const clientSession = decoded?.method?.client_session;
  if (!paymentProof || !tradeNo) return { ok: false, reason: 'INCOMPLETE' };
  return { ok: true, paymentProof, tradeNo, clientSession };
}

/** 构造 Payment-Validation 响应头（Base64URL JSON） */
export function buildPaymentValidation({ tradeNo, outTradeNo, resourceId, validated = true }) {
  return base64UrlEncode(
    JSON.stringify({
      trade_no: tradeNo,
      out_trade_no: outTradeNo,
      validated,
      resource_id: resourceId,
    }),
  );
}
