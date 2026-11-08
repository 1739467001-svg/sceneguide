import crypto from 'node:crypto';

/**
 * 沙箱演示支付。
 *
 * ⚠️ 仅用于沙箱环境的「网页端一键支付」演示：
 *   人在浏览器里点一下，走的是**真实的支付宝沙箱收银接口**，
 *   走完 402 → 收银 → Payment-Proof → 验付 → 履约回执 → 交付，
 *   只是把买方 Agent 的动作由服务端代劳，便于在评委面前现场演示。
 *
 * 正式环境严禁启用：真实收款必须由用户本人（或用户的 Agent）确认支付。
 *
 * 协议细节对齐官方脚本
 * `skills/alipay-aipay/references/integration/modules/scripts/local_402_sandbox_pay.py`。
 */

const SANDBOX_CASHIER = 'http://aicashier.dl.alipaydev.com/openclawpay/agent/v1/pay';

/** snake_case → camelCase */
function snakeToCamel(key) {
  if (!key.includes('_')) return key;
  const [first, ...rest] = key.split('_');
  return first + rest.map((p) => p.slice(0, 1).toUpperCase() + p.slice(1)).join('');
}

function convertKeys(value) {
  if (Array.isArray(value)) return value.map(convertKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [snakeToCamel(k), convertKeys(v)]),
    );
  }
  return value;
}

const nowMs = () => String(Date.now());

/** 从商户订单号尾部取毫秒时间戳（官方脚本同款） */
function timestampFromOutTradeNo(outTradeNo) {
  const match = /(\d{10,})$/.exec(String(outTradeNo ?? ''));
  return match ? match[1] : nowMs();
}

export function createDemoPayer({ config }) {
  /**
   * 用沙箱收银完成一笔支付，并把结果交回商家服务。
   *
   * @param {object} params
   * @param {string} params.paymentNeededBase64 商家返回的 Payment-Needed 头原值
   * @param {string} params.buyerId              沙箱买家 2088 账号
   * @param {string} params.resourceUrl          重试用的原始资源地址
   * @returns {Promise<{ok: boolean, status?: number, body?: any, error?: string}>}
   */
  async function pay({ paymentNeededBase64, buyerId, resourceUrl, cookie }) {
    if (config.env !== 'sandbox') {
      return { ok: false, error: '正式环境不允许服务端代付' };
    }
    if (!buyerId) return { ok: false, error: '缺少沙箱买家账号' };

    // 内部请求带上浏览器访客的 cookie（归因）；来源标记 x-sg-demo 由路由在挑战请求里设置
    const internalHeaders = cookie ? { Cookie: cookie } : {};

    // 1. 解码账单并转成收银接口要的驼峰结构
    const decoded = JSON.parse(
      Buffer.from(paymentNeededBase64, 'base64url').toString('utf8'),
    );
    const converted = convertKeys(decoded);
    const method = { ...(converted.method ?? {}) };
    const protocol = { ...(converted.protocol ?? {}) };

    method.buyerUniqueIdKey = 'buyerExternalId';
    protocol.buyerUniqueId = buyerId;

    const timestamp = timestampFromOutTradeNo(protocol.outTradeNo);
    const payload = {
      method,
      protocol,
      signature: {
        buyerExternalId: buyerId,
        buyerSignature: '-',
        timestamp,
      },
    };

    // 2. 下单到沙箱收银
    const cashierRes = await fetch(SANDBOX_CASHIER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    });
    const cashierBody = await cashierRes.json().catch(() => ({}));

    if (!cashierRes.ok) {
      return {
        ok: false,
        error: `沙箱收银返回 HTTP ${cashierRes.status}：${JSON.stringify(cashierBody).slice(0, 300)}`,
      };
    }
    if (cashierBody.errorCode) {
      return { ok: false, error: `沙箱收银失败 ${cashierBody.errorCode}：${cashierBody.errorMessage ?? ''}` };
    }

    const tradeNo =
      cashierBody?.protocol?.tradeNo ?? cashierBody?.protocol?.tradeCoreTradeNo;
    if (!tradeNo) {
      return { ok: false, error: '沙箱收银未返回交易号' };
    }

    // 3. 构造 Payment-Proof（官方脚本同款算法）
    const proofTimestamp = nowMs();
    const paymentProof = crypto
      .createHash('sha256')
      .update(`${tradeNo}|${buyerId}|${proofTimestamp}`)
      .digest('hex');
    const clientSession = Buffer.from(
      JSON.stringify({ externalId: buyerId, signature: '-', timestamp: proofTimestamp }),
      'utf8',
    ).toString('base64');

    const proofBody = {
      protocol: { payment_proof: paymentProof, trade_no: tradeNo },
      method: { client_session: clientSession },
    };
    const proofHeader = Buffer.from(JSON.stringify(proofBody), 'utf8').toString('base64url');

    // 4. 携带 Payment-Proof 重试原始资源请求
    const retryRes = await fetch(resourceUrl, {
      headers: { 'Payment-Proof': proofHeader, ...internalHeaders },
      signal: AbortSignal.timeout(30000),
    });
    const retryBody = await retryRes.json().catch(() => ({}));
    const paymentValidation = retryRes.headers.get('payment-validation');

    return {
      ok: retryRes.status === 200,
      status: retryRes.status,
      body: retryBody,
      paymentValidation,
      paymentValidationPreview: paymentValidation
        ? `${paymentValidation.slice(0, 72)}…（共 ${paymentValidation.length} 字符）`
        : null,
      tradeNo,
      payUrl: cashierBody.payScheme
        ? `https://render.alipay.com/p/yuyan/180020010001290755/pay.html?schema=${encodeURIComponent(cashierBody.payScheme)}`
        : null,
    };
  }

  return { pay };
}
