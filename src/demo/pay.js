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

/**
 * 从商户订单号尾部取毫秒时间戳（官方脚本同款）。
 *
 * ⚠️ 对本项目的订单号格式**取不到**（2026-11-23 核对）：本项目的 outTradeNo 是
 *    `SG_<13位毫秒>_<12位随机hex>`，毫秒数在**中间**，尾部是 hex——
 *    而正则是 `(\d{10,})$`（要求结尾是 10 位以上连续数字），hex 尾巴
 *    'e12a90266053' 只有 8 位连续数字，永不命中，于是每次都走 nowMs() 兜底。
 *    行为上无害（订单刚创建，now 就是它的创建时间），但别再以为这里真的
 *    「取到了订单里的时间戳」——注释与实现不符比没有注释更糟。
 *    若将来订单号改成「时间戳结尾」的格式，这个函数会自动开始生效。
 */
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
    // 🔴 沙箱收银对连续支付有低概率拒单（PAY_SUBMIT_FAILED「系统繁忙」，实测，
    //    频率约 1/10）。评委在页面上手点「走一遍真实沙箱支付」时遇到一次就弹错误，
    //    观感很差；这里对「明确的临时性失败」做最多 5 次退避重试（1s/2s/4s/8s/16s）。
    //    注意：拒单发生在下单阶段，本地订单尚未关联 trade_no，重试无幂等风险。
    //    注意：只重试临时性错误；参数类错误（签名/价格）重试必然同样失败。
    const MAX_CASHIER_ATTEMPTS = 5;
    let cashierRes;
    let cashierBody;
    let cashierError;
    for (let attempt = 1; attempt <= MAX_CASHIER_ATTEMPTS; attempt++) {
      cashierRes = await fetch(SANDBOX_CASHIER, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30000),
      });
      cashierBody = await cashierRes.json().catch(() => ({}));

      cashierError = null;
      if (!cashierRes.ok) {
        cashierError = `沙箱收银返回 HTTP ${cashierRes.status}：${JSON.stringify(cashierBody).slice(0, 300)}`;
      } else if (cashierBody.errorCode) {
        cashierError = `沙箱收银失败 ${cashierBody.errorCode}：${cashierBody.errorMessage ?? ''}`;
        const transient = /繁忙|BUSY|TIMEOUT|timeout|try.?again|稍后/i.test(
          `${cashierBody.errorCode} ${cashierBody.errorMessage ?? ''}`,
        );
        if (!transient) break;
      }
      if (!cashierError) break;
      if (attempt < MAX_CASHIER_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
      }
    }
    if (cashierError) {
      return { ok: false, error: `${cashierError}（沙箱偶发繁忙已自动重试，请稍后再试）` };
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
      // ── 本次交易的报文素材（供前端把「协议链路」面板从静态快照换成这一笔的真实报文）──
      //    ⚠️ Payment-Proof 属买方凭证，**只回传长度与指纹**，绝不回传原文。
      liveTrace: {
        paymentNeededBase64Length: paymentNeededBase64?.length ?? 0,
        paymentNeededHeaderName: 'Payment-Needed',
        paymentProofLength: proofHeader?.length ?? 0,
        paymentProofFingerprint: crypto
          .createHash('sha256')
          .update(String(proofHeader ?? ''))
          .digest('hex')
          .slice(0, 16),
        clientSessionLength: clientSession?.length ?? 0,
        paymentValidationLength: paymentValidation?.length ?? 0,
        paymentValidationPreview: paymentValidation
          ? `${paymentValidation.slice(0, 72)}…（共 ${paymentValidation.length} 字符）`
          : null,
        cashierTradeNo: tradeNo,
        outTradeNo: protocol.outTradeNo ?? null,
        amount: protocol.amount ?? null,
        goodsName: method.goodsName ?? null,
        serviceId: method.serviceId ?? null,
        sellerId: method.sellerId ?? null,
        payScheme: cashierBody.payScheme ? String(cashierBody.payScheme).slice(0, 120) : null,
      },
    };
  }

  return { pay };
}
