/**
 * 履约回执自愈清扫器（PENDING_CONFIRM 不再永远卡住）。
 *
 * 官方流程：资源生成后必须调 `alipay.aipay.agent.fulfillment.confirm` 回执；
 * 回执失败时允许用同一笔 Payment-Proof 重试。但那条恢复路径握在**买方**手里——
 * 如果买方不再重试（人付完款就关掉页面、买方 Agent 崩了、官方买方脚本只重试一次），
 * 订单就永远停在 PENDING_CONFIRM：钱已付、资源已生成、支付宝侧却没记账，
 * 「账实一致」的设计目标落空。
 *
 * 关键观察：履约回执的入参**只有 trade_no**（商家自己持有）——
 * 也就是说重发回执根本不依赖买方。本清扫器定期找出卡单、重发回执、成功即标记履约。
 *
 * 安全与节奏边界：
 *  · 只处理 `PAID + PENDING_CONFIRM + trade_no 非空` 的订单（其余状态一概不碰）；
 *  · 宽限期 graceMinutes（默认 2 分钟）：给买方在途重试留出独占窗口——
 *    双发本身无害（confirm 幂等 + isIdempotentSuccess 把「已确认」识别为成功），
 *    但少打扰为佳；
 *  · 最长追溯 maxAgeHours（默认 72h）：更老的卡单留给人工排查，
 *    不让永久性失败的订单无限烧重试；
 *  · 单飞（running 标志）：上一轮没扫完不叠加下一轮；
 *  · 定时器 unref()：不阻止进程自然退出。
 *
 * 旋钮：RECEIPT_SWEEPER_INTERVAL_MS（默认 60000；设 0 关闭）。
 */
export function createReceiptSweeper({
  repository,
  alipayClient,
  intervalMs = 60000,
  graceMinutes = 2,
  maxAgeHours = 72,
  logger = console,
}) {
  let timer = null;
  let running = false;

  /** 扫一轮。返回 { swept, confirmed, skipped? } 供测试与日志断言。 */
  async function sweepOnce() {
    if (running) return { swept: 0, confirmed: 0, skipped: true };
    running = true;
    try {
      const candidates = await repository.listStuckConfirmations({ graceMinutes, maxAgeHours });
      let confirmed = 0;
      for (const order of candidates) {
        try {
          const res = await alipayClient.confirmFulfillment({ tradeNo: order.tradeNo });
          if (res.ok) {
            await repository.markFulfilled(order.outTradeNo, order.tradeNo);
            confirmed += 1;
            logger.log?.(
              `[receipt-sweeper] 订单 ${order.outTradeNo} 回执恢复成功`
              + `（${res.alreadyConfirmed ? '对方已确认过，本地补记账' : '本次确认成功'}）`,
            );
          } else {
            logger.warn?.(
              `[receipt-sweeper] 订单 ${order.outTradeNo} 回执仍失败：${res.errorCode} ${res.errorMessage}（下一轮再试）`,
            );
          }
        } catch (err) {
          logger.warn?.(`[receipt-sweeper] 订单 ${order.outTradeNo} 回执异常：${err.message}`);
        }
      }
      return { swept: candidates.length, confirmed };
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer || !Number.isFinite(intervalMs) || intervalMs <= 0) return;
    // 启动 5 秒后先扫一遍：服务重启即可恢复历史卡单，不用等第一个周期
    const boot = setTimeout(() => { sweepOnce().catch(() => {}); }, 5000);
    boot.unref?.();
    timer = setInterval(() => { sweepOnce().catch(() => {}); }, intervalMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { sweepOnce, start, stop };
}
