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
        // 🔴 业务拒绝的字段名与位置（2026-11-23 实测修正）：
        //    alipay-sdk 对**错误**响应会做两件事——把 `error_response` 拍平到顶层，
        //    并把字段名从 snake_case 改成 camelCase。实测网关返回
        //    `{error_response:{code:'40004',sub_code:'X',sub_msg:'Y'}}` 时，
        //    sdk.exec 给出的是 `{code:'40004', subCode:'X', subMsg:'Y'}`。
        //    旧实现只读蛇形的 `data.sub_code/sub_msg`，永远取到 undefined，
        //    于是每一笔业务拒绝（余额不足 / 服务价格不匹配 / 凭证过期…）
        //    都退化成同一个 'VERIFY_FAILED' + '支付凭证验证失败'，
        //    路由层日志毫无排查线索——生产上「用户为什么付不了钱」
        //    要回网关抓包才知道。现在三种形态都认。
        const rejection = response?.error_response ?? data;
        return {
          ok: false,
          errorCode:
            rejection.sub_code ?? rejection.subCode ?? rejection.errorCode ?? data.code ?? 'VERIFY_FAILED',
          errorMessage:
            rejection.sub_msg ?? rejection.subMsg ?? rejection.msg ?? data.msg ?? '支付凭证验证失败',
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
        // 与 verifyPayment 同口径：错误响应被 SDK 拍平并改驼峰（详见上文）
        const rejection = response?.error_response ?? data;
        return {
          ok: false,
          errorCode:
            rejection.sub_code ?? rejection.subCode ?? rejection.errorCode ?? data.code ?? 'FULFILLMENT_ERROR',
          errorMessage:
            rejection.sub_msg ?? rejection.subMsg ?? rejection.msg ?? data.msg ?? '履约确认失败',
        };
      }
      return { ok: true };
    },

    /**
     * 按量付费预下单（官方 MACHINE_PAY.md 的生产形态）。
     *
     * 🔴 为什么加这个：官方对 402 有**两种**形态，本项目原先只实现了一种。
     *   · 形态 A（我们原有）：商家本地构造 + RSA2 签名 → `Payment-Needed` 头
     *     ——依据官方参考实现与买方技能 alipay-pay-for-402-service
     *   · 形态 B（官网 MACHINE_PAY.md 明示的生产流程）：
     *     调 `alipay.aipay.agent.payment.precreate` → 拿 `amt_pre_pay_id`
     *     → 402 响应头 `amtPaymentLink: <amt_pre_pay_id>`
     *     ——买方把它交给支付宝支付能力，用户确认付款
     *
     *   两条路径的**验付环节完全一致**（都用 payment.verify + 携 Payment-Proof 重试），
     *   所以本项目已实现的五项核验、幂等履约、履约回执**无需任何改动**。
     *   于是生产环境可以**同时输出两个头**：Payment-Needed 给 Agent 买方，
     *   amtPaymentLink 给走官方预下单号的支付能力——把主办方生态的两条路都用上。
     *
     * 官方文档只给出请求字段表与「返回对象中包含 amt_pre_pay_id」，
     * **未公开完整响应 JSON**，故这里对字段位置做防御式解析
     * （snake/camel、顶层/嵌套都认），并在拿不到时明确返回错误而不是猜。
     *
     * @param {object} params
     * @param {string} params.outTradeNo  商户订单号（幂等键）
     * @param {string} params.serviceId   按量付费注册分配的服务标识
     * @param {string} params.goodsName    商品名称
     * @param {string} params.amount       金额，单位**元**，不超过 50
     * @param {string} params.payBefore    支付截止时间（ISO 8601 带时区）
     * @param {string} [params.currency]   币种，仅支持 CNY
     * @param {string} [params.memo]       交易备注
     */
    async precreate({ outTradeNo, serviceId, goodsName, amount, payBefore, currency, memo }) {
      const bizContent = {
        out_trade_no: outTradeNo,
        service_id: serviceId,
        goods_name: goodsName,
        amount: String(amount),
        pay_before: payBefore,
      };
      if (currency) bizContent.currency = currency;
      if (memo) bizContent.memo = memo;

      let response;
      const attempt = await execWithRetry(sdk, 'alipay.aipay.agent.payment.precreate', bizContent);
      if (!attempt.ok) {
        return {
          ok: false,
          errorCode: 'ALIPAY_RESPONSE_MALFORMED',
          errorMessage: `预下单接口响应异常（已重试）: ${attempt.error.message}`,
        };
      }
      response = attempt.response;
      const data =
        response?.alipay_aipay_agent_payment_precreate_response ?? response ?? {};

      if (String(data.code) !== '10000') {
        // 与 verifyPayment 同口径：错误响应被 SDK 拍平并改驼峰
        const rejection = response?.error_response ?? data;
        return {
          ok: false,
          errorCode:
            rejection.sub_code ?? rejection.subCode ?? rejection.errorCode ?? data.code ?? 'PRECREATE_FAILED',
          errorMessage:
            rejection.sub_msg ?? rejection.subMsg ?? rejection.msg ?? data.msg ?? '预下单失败',
        };
      }

      // 防御式取 amt_pre_pay_id：官方未公开完整响应结构，位置都认
      const amtPrePayId =
        data.amt_pre_pay_id ??
        data.amtPrePayId ??
        data.amount_pre_pay_id ??
        data.amountPrePayId ??
        response?.alipay_aipay_agent_payment_precreate_response?.amt_pre_pay_id ??
        null;

      if (!amtPrePayId) {
        // 不猜：拿不到就明确报错，并把原始响应带出去供排查
        return {
          ok: false,
          errorCode: 'PRECREATE_NO_AMT_PRE_PAY_ID',
          errorMessage: '预下单响应中未找到 amt_pre_pay_id',
          raw: JSON.stringify(response).slice(0, 500),
        };
      }

      return {
        ok: true,
        amtPrePayId: String(amtPrePayId),
        raw: JSON.stringify(response).slice(0, 500),
      };
    },
  };
}
