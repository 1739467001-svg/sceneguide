import { AlipaySdk } from 'alipay-sdk';
import { toPem } from './protocol.js';

/**
 * 支付宝服务端客户端封装。
 *
 * 按量付费（A2M 智能收）只用到三个接口，官方要求实现的也只有这三个：
 *   1. 402 协议（本地构造 Payment-Needed，不调用 OpenAPI）
 *   2. alipay.aipay.agent.payment.verify      —— 校验支付凭证
 *   3. alipay.aipay.agent.fulfillment.confirm —— 履约回执
 *
 * 对比网站支付/APP 支付需要 6 个接口（下单/查询/退款/关闭/异步通知），
 * 按量付费的工程量明显更小。
 *
 * 🔴 沙箱抖动实录（本项目实测，频率约 1/5～1/10）：
 *    verify 与 confirm 都会偶发返回**非标准响应**（缺 *_response 键，
 *    SDK 抛「Response 格式错误」）。这不是业务拒绝，是通道抖动——
 *    同一请求重试即可成功。因此这里对「解析失败」做有界重试
 *    （1s/2s/3s 退避，共 4 次）；业务拒绝（code != 10000）不重试，
 *    原样返回给路由层按协议处理。
 */
const MALFORMED_RETRY_DELAYS = [1000, 2000, 3000];

/** 执行 OpenAPI；仅对「响应无法解析」重试，业务结果原样返回 */
async function execWithRetry(sdk, api, bizContent) {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await sdk.exec(api, { bizContent });
      return { ok: true, response };
    } catch (err) {
      if (attempt >= MALFORMED_RETRY_DELAYS.length) {
        return { ok: false, error: err };
      }
      await new Promise((r) => setTimeout(r, MALFORMED_RETRY_DELAYS[attempt]));
    }
  }
}

export function createAlipayClient(config) {
  const sdk = new AlipaySdk({
    appId: config.appId,
    privateKey: toPem(config.privateKeyB64),
    alipayPublicKey: config.alipayPublicKey,
    gateway: config.gateway,
    timeout: 30000,
  });

  return {
    /**
     * 校验支付凭证。
     * bizContent 使用 snake_case（与官方 Node 参考实现一致）：
     *   payment_proof / trade_no / client_session
     * client_session 由买方 Agent 生成，必须原样透传，不得修改或缓存。
     *
     * SDK 对非标准响应会**抛异常**（实测：沙箱偶发返回缺键响应，抛「Response 格式错误」）。
     * 这里统一兜成 { ok: false }，让路由层按业务错误处理，而不是 500 崩掉整条链路。
     */
    async verifyPayment({ paymentProof, tradeNo, clientSession }) {
      const bizContent = { payment_proof: paymentProof, trade_no: tradeNo };
      if (clientSession) bizContent.client_session = clientSession;

      let response;
      const attempt = await execWithRetry(sdk, 'alipay.aipay.agent.payment.verify', bizContent);
      if (!attempt.ok) {
        return {
          ok: false,
          errorCode: 'ALIPAY_RESPONSE_MALFORMED',
          errorMessage: `验付接口响应异常（已重试）: ${attempt.error.message}`,
        };
      }
      response = attempt.response;
      const data =
        response?.alipay_aipay_agent_payment_verify_response ?? response ?? {};

      if (String(data.code) !== '10000') {
        return {
          ok: false,
          errorCode: data.sub_code || data.errorCode || 'VERIFY_FAILED',
          errorMessage: data.sub_msg || data.msg || '支付凭证验证失败',
        };
      }

      return {
        ok: true,
        data: {
          tradeNo: data.trade_no || data.tradeNo || '',
          outTradeNo: data.out_trade_no || data.outTradeNo || '',
          resourceId: data.resource_id || data.resourceId || '',
          amount: data.amount,
          active: data.active,
        },
      };
    },

    /** 发送履约回执。失败时不得返回成功交付，应保留服务结果允许同一笔 Payment-Proof 重试。
     *  与 verifyPayment 同口径：解析失败有界重试，业务拒绝原样返回。 */
    async confirmFulfillment({ tradeNo }) {
      let response;
      // 注意：execWithRetry 内部负责包 { bizContent }，这里只传业务体本身
      const attempt = await execWithRetry(sdk, 'alipay.aipay.agent.fulfillment.confirm', {
        trade_no: tradeNo,
      });
      if (!attempt.ok) {
        return {
          ok: false,
          errorCode: 'ALIPAY_RESPONSE_MALFORMED',
          errorMessage: `履约回执接口响应异常（已重试）: ${attempt.error.message}`,
        };
      }
      response = attempt.response;
      const data =
        response?.alipay_aipay_agent_fulfillment_confirm_response ?? response ?? {};

      if (String(data.code) !== '10000') {
        return {
          ok: false,
          errorCode: data.sub_code || data.errorCode || 'FULFILLMENT_ERROR',
          errorMessage: data.sub_msg || data.msg || '履约确认失败',
        };
      }
      return { ok: true };
    },
  };
}
