import express from 'express';

/**
 * 官方支付异步通知接收端点。
 *
 * 背景（2026-11-23 核对支付宝官方文档）：
 *   · 官方《支付 MCP Server》提供四个工具，其中 `create-web-page-alipay-payment`
 *     /`create-mobile-alipay-payment` 创建支付、**`query-alipay-payment` 查询支付**、
 *     `refund-alipay-payment` 发起退款、`query-alipay-refund` 查询退款；
 *   · 其配置项 `AP_RETURN_URL`（同步返回）与 **`AP_NOTIFY_URL`（异步通知）**
 *     由**商家自己提供**——也就是由本服务提供；
 *   · 官方反复强调「支付结果必须以**异步通知或查询接口**返回为准，不能依赖同步跳转」。
 *
 * 为什么本项目要实现它：原先本服务感知付款只有一条路——买方携 `Payment-Proof`
 * 重试原请求（这是 402 协议的路径）。但**人自己用支付宝扫码付款**时，
 * 买方 Agent 可能不介入或不重试；此时服务端需要一条**不依赖买方 Agent** 的官方通道。
 * 这条通道就是 notify_url。
 *
 * 安全约定（与本项目一贯的「不轻信外部标识」一致）：
 *   ① 金额必须与本地订单金额完全一致（容差 0.001 元），否则拒绝；
 *   ② 幂等：重复通知只生效一次；
 *   ③ **通知只推进状态机，不发放资源**——资源交付仍由带凭证的验付/查询路径负责，
 *      避免「伪造一条通知就骗到资源」；
 *   ④ 通知不携带任何可被用来伪造「已付款」的凭证字段（payment_proof 不在此处理），
 *      因此伪造通知最多把订单标成 PAID，**拿不到资源**——这一点在交付路径里是硬约束。
 */
export function createNotifyRouter({ repository, config }) {
  const router = express.Router();

  // 官方通知可能是表单编码或 JSON，两种都收
  router.use(express.urlencoded({ extended: true }));
  router.use(express.json());

  /** 从各种官方字段命名里取出 out_trade_no / trade_no / amount */
  function extract(body = {}) {
    const pick = (...keys) => {
      for (const k of keys) {
        if (body[k] !== undefined && body[k] !== null && body[k] !== '') return body[k];
      }
      return undefined;
    };
    return {
      outTradeNo: pick('out_trade_no', 'outTradeNo', 'out_order_no'),
      tradeNo: pick('trade_no', 'tradeNo', 'alipay_trade_no'),
      amount: pick('total_amount', 'totalAmount', 'amount', 'receipt_amount'),
      status: pick('trade_status', 'tradeStatus', 'status', 'result_code'),
    };
  }

  const handler = async (req, res) => {
    const { outTradeNo, tradeNo, amount, status } = extract(req.body ?? {});

    if (!outTradeNo) {
      // 官方约定：返回非 success 会触发重试；这里没有订单号就没法处理，
      // 直接返回 success 让它别再打过来（避免无意义的重试风暴）。
      console.warn('[notify] 缺少 out_trade_no，忽略');
      return res.type('text/plain').send('success');
    }

    // 状态判断：只处理明确表示成功的状态；不确定时也不盲目标记
    const okStatuses = ['TRADE_SUCCESS', 'SUCCESS', 'trade_status', '60'];
    if (status && !okStatuses.includes(String(status))) {
      console.warn(`[notify] 交易状态非成功（${status}），不推进状态机`);
      return res.type('text/plain').send('success');
    }

    const result = await repository.markPaidByNotification(outTradeNo, { tradeNo, amount });
    if (!result.ok) {
      console.warn(`[notify] 未推进订单 ${outTradeNo}：${result.reason}`);
      // 官方约定：返回 success 表示已处理；失败重试对「订单不存在」没有意义
      return res.type('text/plain').send('success');
    }

    console.log(
      `[notify] 订单 ${outTradeNo} 已标记 PAID（${result.reason}）`
      + ` trade_no=${result.tradeNo ?? '-'} env=${config.env}`,
    );
    return res.type('text/plain').send('success');
  };

  // 官方默认回调路径以 /notify 结尾较常见，这里挂多个别名降低配置摩擦
  router.post('/api/v1/pay/notify', handler);
  router.post('/api/v1/notify', handler);
  router.post('/notify', handler);

  return router;
}
