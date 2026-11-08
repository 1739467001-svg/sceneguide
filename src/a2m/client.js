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
 * 对比网站支付/APP 支付需要 6 个接口（下单/查询/退款/退款查询/关闭/异步通知），
 * 按量付费的工程量明显更小。
 */
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
     */
    async verifyPayment({ paymentProof, tradeNo, clientSession }) {
      const bizContent = { payment_proof: paymentProof, trade_no: tradeNo };
      if (clientSession) bizContent.client_session = clientSession;

      const response = await sdk.exec('alipay.aipay.agent.payment.verify', { bizContent });
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

    /** 发送履约回执。失败时不得返回成功交付，应保留服务结果允许同一笔 Payment-Proof 重试。 */
    async confirmFulfillment({ tradeNo }) {
      const response = await sdk.exec('alipay.aipay.agent.fulfillment.confirm', {
        bizContent: { trade_no: tradeNo },
      });
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
