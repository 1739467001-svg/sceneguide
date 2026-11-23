import express from 'express';
import { hashIp } from '../analytics/store.js';

/**
 * 买家账户中心。
 *
 * 为什么必须有这个模块：
 *   付完钱就散的体验，是最常见的「商业化演示」缺口——买家想知道
 *   「我买过什么、还剩几次、能不能退、能不能转赠」，却无处可看。
 *   订单看板（/api/v1/stats）是**商家**视角；这里是**买家**视角，
 *   两端齐了，「可经营」才立得住。
 *
 * 三条能力线：
 *   1. 我的订单 / 权益额度（GET /api/v1/me）
 *   2. 售后：申请退款（POST /api/v1/refunds）—— 沙箱口径见 repository.refundOrder
 *   3. 礼品码：已购额度转赠（POST /api/v1/gifts[/redeem|/revoke]）
 *   4. 机构采购留资（POST /api/v1/leads）—— B 端商业动作入口
 *
 * 隐私边界：全部按访客 cookie 隔离，不引入任何身份信息；
 * 接口只返回该访客自己的数据，订单摘要不含完整交付内容。
 */
export function createAccountRouter({ repository, analytics }) {
  const router = express.Router();

  /** 机构采购留资的字段上限（与服务端其他输入清洗同口径） */
  const ORG_MAX = 60;
  const CONTACT_MAX = 80;
  const SCALE_MAX = 40;
  const NOTE_MAX = 300;
  /** 每 IP 每日留资上限：防批量灌垃圾。可用 LEAD_DAILY_IP_LIMIT 覆盖（运维旋钮） */
  const LEAD_DAILY_IP_LIMIT = Number(process.env.LEAD_DAILY_IP_LIMIT ?? 5);

  const REFUND_ERRORS = {
    ORDER_NOT_FOUND: '没有这笔订单',
    NOT_YOUR_ORDER: '这不是你的订单',
    NOT_REFUNDABLE_STATE: '只有已完成支付的订单可以申请退款',
    ALREADY_REFUNDED: '这笔订单已经申请过退款了',
    REFUND_WINDOW_EXPIRED: '已超过 12 个月退款有效期',
    REFUND_DAILY_LIMIT: '今天申请退款的笔数已达上限（3 笔），请明天再试',
  };

  const GIFT_ERRORS = {
    NO_VISITOR: '无法识别访客身份，请刷新页面重试',
    NO_ENTITLEMENT: '当前没有可转赠的额度（「十次导览包」付清后才有）',
    GIFT_NOT_FOUND: '礼品码不存在，请检查后重试',
    GIFT_NOT_ACTIVE: '这个礼品码已经被兑换或撤销了',
    GIFT_SELF_REDEEM: '不能兑换自己生成的礼品码',
    NOT_YOUR_GIFT: '只能撤销自己生成的礼品码',
  };

  /** 买家视角的一次聚合：订单 + 额度 + 礼品码 + 归因渠道 */
  router.get('/api/v1/me', (req, res) => {
    const visitorId = req.visitorId;
    if (!visitorId) {
      return res.status(400).json({ error: '无法识别访客身份，请刷新页面重试' });
    }
    const balance = repository.entitlementBalance(visitorId);
    const gifts = repository.listGiftsByVisitor(visitorId);
    const visitor = analytics?.visitorSummary?.(visitorId) ?? null;
    return res.json({
      visitor: {
        id: visitorId,
        ref_code: visitor?.refCode ?? null,
        visits: visitor?.visits ?? 0,
        first_seen: visitor?.firstSeen ?? null,
      },
      orders: repository.listOrdersByVisitor(visitorId),
      entitlements: balance,
      gifts,
    });
  });

  /** 申请退款（沙箱口径：权益回收 + 工单 + 标注；资金原路退回需生产 service_id） */
  router.post('/api/v1/refunds', (req, res) => {
    const visitorId = req.visitorId;
    const outTradeNo = String(req.body?.out_trade_no ?? '').trim();
    const reason = String(req.body?.reason ?? '').trim().slice(0, 200);
    if (!visitorId) {
      return res.status(400).json({ error: '无法识别访客身份，请刷新页面重试' });
    }
    if (!outTradeNo) {
      return res.status(400).json({ error: '缺少订单号' });
    }
    const result = repository.refundOrder({ outTradeNo, visitorId, reason });
    if (!result.ok) {
      return res.status(400).json({ error: REFUND_ERRORS[result.code] ?? result.code });
    }
    if (analytics) {
      analytics.recordEvent(visitorId, 'refund_requested', req.visitorRef, {
        out_trade_no: outTradeNo,
      });
    }
    return res.json({
      ok: true,
      out_trade_no: result.outTradeNo,
      amount: result.amount,
      entitlements: repository.entitlementBalance(visitorId),
      note:
        '沙箱环境：退款 = 权益即时回收 + 工单留痕 + 订单标注；' +
        '资金原路退回需在生产环境（真实 service_id）由支付宝完成。',
    });
  });

  /** 生成礼品码：从当前访客的已购额度扣 1 次 */
  router.post('/api/v1/gifts', (req, res) => {
    const visitorId = req.visitorId;
    if (!visitorId) {
      return res.status(400).json({ error: '无法识别访客身份，请刷新页面重试' });
    }
    const tier = String(req.body?.tier ?? 'single').trim();
    const result = repository.createGiftCode({ visitorId, tier });
    if (!result.ok) {
      return res.status(400).json({ error: GIFT_ERRORS[result.code] ?? result.code });
    }
    if (analytics) {
      analytics.recordEvent(visitorId, 'gift_created', req.visitorRef, { code: result.code });
    }
    return res.json({
      ok: true,
      code: result.code,
      quota: result.quota,
      remaining: result.remaining,
      gifts: repository.listGiftsByVisitor(visitorId),
    });
  });

  /** 兑换礼品码：给当前访客发 1 次额度 */
  router.post('/api/v1/gifts/redeem', (req, res) => {
    const visitorId = req.visitorId;
    if (!visitorId) {
      return res.status(400).json({ error: '无法识别访客身份，请刷新页面重试' });
    }
    const code = String(req.body?.code ?? '').trim();
    const result = repository.redeemGiftCode({ code, visitorId });
    if (!result.ok) {
      return res.status(400).json({ error: GIFT_ERRORS[result.code] ?? result.code });
    }
    if (analytics) {
      // 礼品码是增长回路：接收方是一个全新访客，单独记一类事件进漏斗口径
      analytics.recordEvent(visitorId, 'gift_redeemed', req.visitorRef, { code: result.code });
    }
    return res.json({
      ok: true,
      code: result.code,
      quota: result.quota,
      entitlements: repository.entitlementBalance(visitorId),
    });
  });

  /** 撤销未兑换的礼品码：额度还给我 */
  router.post('/api/v1/gifts/revoke', (req, res) => {
    const visitorId = req.visitorId;
    if (!visitorId) {
      return res.status(400).json({ error: '无法识别访客身份，请刷新页面重试' });
    }
    const code = String(req.body?.code ?? '').trim();
    const result = repository.revokeGiftCode({ code, visitorId });
    if (!result.ok) {
      return res.status(400).json({ error: GIFT_ERRORS[result.code] ?? result.code });
    }
    return res.json({
      ok: true,
      code: result.code,
      entitlements: repository.entitlementBalance(visitorId),
      gifts: repository.listGiftsByVisitor(visitorId),
    });
  });

  /**
   * 机构采购留资。
   *
   * 为什么收联系方式：这是**有意收集**的 B 端对接信息（机构批量采购十次包），
   * 与反馈墙「见联系方式就降级」的口径不同。边界写在与反馈墙一致的位置：
   *   - 界面明示「仅用于本次采购对接，不出现在任何公开页面」；
   *   - 不提供任何读取接口（商家在服务器本地查）；
   *   - 按 IP 限流，防批量灌垃圾。
   */
  router.post('/api/v1/leads', (req, res) => {
    if (!analytics) {
      return res.status(503).json({ error: '留资服务当前不可用' });
    }
    const org = String(req.body?.org ?? '').trim();
    const contact = String(req.body?.contact ?? '').trim();
    const scale = String(req.body?.scale ?? '').trim();
    const note = String(req.body?.note ?? '').trim();

    if (!org) return res.status(400).json({ error: '请填写机构名称' });
    if (!contact) return res.status(400).json({ error: '请留下联系方式（微信 / 邮箱 / 手机号）' });
    if (org.length > ORG_MAX) return res.status(400).json({ error: `机构名称请控制在 ${ORG_MAX} 字以内` });
    if (contact.length > CONTACT_MAX) {
      return res.status(400).json({ error: `联系方式请控制在 ${CONTACT_MAX} 字以内` });
    }
    if (scale.length > SCALE_MAX || note.length > NOTE_MAX) {
      return res.status(400).json({ error: '内容超长，请精简后再提交' });
    }

    const ipHash = hashIp(req.ip ?? req.socket?.remoteAddress);
    const ipDaily = analytics.bumpIpDaily(ipHash, 'lead');
    if (ipDaily > LEAD_DAILY_IP_LIMIT) {
      return res.status(429).json({ error: '今日留资次数已达上限，请明天再试或直接邮件联系' });
    }

    analytics.addLead({
      org,
      contact,
      scale: scale || null,
      note: note || null,
      visitorId: req.visitorId,
      ip: req.ip ?? req.socket?.remoteAddress,
    });
    analytics.recordEvent(req.visitorId, 'lead_submitted', req.visitorRef, { org });
    return res.json({ ok: true, message: '已收到，我们会主动联系你对接采购事宜。' });
  });

  return router;
}
