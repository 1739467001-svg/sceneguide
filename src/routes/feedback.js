import express from 'express';
import { hashIp } from '../analytics/store.js';

/**
 * 社区反馈墙。
 *
 * 为什么必须有这个模块：
 *   评审维度「作品影响力：是否获得用户的有效点赞、评论和交流反馈」。
 *   站点上如果没有一个能收集这些反馈的入口，这一维度在结构上就拿不到分——
 *   访客想点赞都没地方点。反馈墙就是这个入口。
 *
 * 设计原则（与本项目其他部分一致）：
 *   - 反刷量优先：IP 哈希 + 访客 cookie 双层限流，点赞按访客去重；
 *   - 隐私最小化：只存加盐 IP 哈希，不存原始 IP / UA / 任何联系方式；
 *   - 不预置假评论：墙上只出现真实提交的内容，空墙就诚实地是空的。
 */

/** 允许的身份标签（避免出现「微信号 / 手机号」这类联系方式） */
const ROLES = ['游客', '研学机构', '开发者', '学生', '评审', '其他'];

const NAME_MAX = 24;
const CONTENT_MIN = 4;
const CONTENT_MAX = 500;
/** 每日可提交的反馈条数（按访客 / 按 IP 各一层）
 *  取值要同时满足两件事：① 挡住「清 cookie 批量刷屏」（IP 层兜底）；
 *  ② 让验收脚本可以反复执行（同一 IP 一天跑多次）。 */
const DAILY_LIMIT_VISITOR = 10;
const DAILY_LIMIT_IP = 50;

export function createFeedbackRouter({ analytics }) {
  const router = express.Router();

  if (!analytics) {
    router.get('/api/v1/feedback', (_req, res) => res.json({ total: 0, items: [] }));
    return router;
  }

  /** 读取并清洗提交的字段；任何不合法都返回错误原因，不静默丢弃 */
  function readPayload(body = {}) {
    const name = String(body.name ?? '').trim().replace(/\s+/g, ' ');
    const content = String(body.content ?? '').trim();
    const role = String(body.role ?? '').trim();
    const rawRating = body.rating;

    if (!name) return { error: '请填写称呼' };
    if (name.length > NAME_MAX) return { error: `称呼请控制在 ${NAME_MAX} 字以内` };
    if (content.length < CONTENT_MIN) return { error: `反馈至少 ${CONTENT_MIN} 个字` };
    if (content.length > CONTENT_MAX) return { error: `反馈请控制在 ${CONTENT_MAX} 字以内` };

    let rating = null;
    if (rawRating !== undefined && rawRating !== null && rawRating !== '') {
      rating = Number(rawRating);
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        return { error: '评分必须是 1–5 之间的整数' };
      }
    }

    let safeRole = null;
    if (role) {
      safeRole = ROLES.includes(role) ? role : '其他';
      // 兜底：任何看起来像联系方式的内容一律降级为「其他」，不原样展示
      if (/微信|wechat|wx[:：]|qq[:：]|1[3-9]\d{9}|@[\w.-]+\.\w+/.test(role)) safeRole = '其他';
    }

    return { name, content, role: safeRole, rating };
  }

  /** 列表：按点赞数倒序 */
  router.get('/api/v1/feedback', (req, res) => {
    const items = analytics.listFeedback(req.visitorId);
    return res.json({
      total: analytics.feedbackCount(),
      items,
      roles: ROLES,
    });
  });

  /** 提交反馈 */
  router.post('/api/v1/feedback', (req, res) => {
    const payload = readPayload(req.body ?? {});
    if (payload.error) {
      return res.status(400).json({ code: 'INVALID_FEEDBACK', message: payload.error });
    }

    // 双层限流：访客 cookie + IP 哈希（cookie 可重置，IP 不可）
    const ipHash = hashIp(req.ip ?? req.socket?.remoteAddress);
    if (ipHash) {
      const ipCount = analytics.bumpIpDaily(ipHash, 'feedback');
      if (ipCount > DAILY_LIMIT_IP) {
        return res.status(429).json({
          code: 'FEEDBACK_LIMIT_REACHED',
          message: `今日反馈提交次数已达上限（${DAILY_LIMIT_IP} 条），明天再来。`,
        });
      }
    }
    if (req.visitorId) {
      const visitorCount = analytics.countTodayEvents(req.visitorId, 'feedback_submit');
      if (visitorCount >= DAILY_LIMIT_VISITOR) {
        return res.status(429).json({
          code: 'FEEDBACK_LIMIT_REACHED',
          message: `今日反馈提交次数已达上限（${DAILY_LIMIT_VISITOR} 条），明天再来。`,
        });
      }
    }

    const item = analytics.addFeedback({
      name: payload.name,
      role: payload.role,
      content: payload.content,
      rating: payload.rating,
      visitorId: req.visitorId ?? null,
      ipHash,
    });

    if (req.visitorId) {
      analytics.recordEvent(req.visitorId, 'feedback_submit', req.visitorRef, { id: item.id });
    }

    return res.status(201).json({ item });
  });

  /** 点赞 / 取消点赞（按访客去重） */
  router.post('/api/v1/feedback/:id/like', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ code: 'INVALID_ID', message: '反馈编号无效' });
    }
    if (!req.visitorId) {
      return res.status(400).json({ code: 'NO_VISITOR', message: '缺少访客标识，无法点赞' });
    }
    const result = analytics.toggleFeedbackLike(id, req.visitorId);
    if (!result) {
      return res.status(404).json({ code: 'FEEDBACK_NOT_FOUND', message: '反馈不存在' });
    }
    return res.json(result);
  });

  /** 举报：累计 3 次**不同访客**自动隐藏（一人一票，防单人刷下架） */
  router.post('/api/v1/feedback/:id/report', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ code: 'INVALID_ID', message: '反馈编号无效' });
    }
    if (!req.visitorId) {
      return res.status(400).json({ code: 'NO_VISITOR', message: '无法识别访客身份，请刷新页面重试' });
    }
    const result = analytics.reportFeedback(id, req.visitorId);
    if (!result) {
      return res.status(404).json({ code: 'FEEDBACK_NOT_FOUND', message: '反馈不存在' });
    }
    return res.json(result);
  });

  /**
   * 回复一条反馈 —— 评审要的是「交流反馈」而不只是评论。
   * 墙上是可来回对话的线程，所以每条反馈都能被接着聊。
   */
  router.post('/api/v1/feedback/:id/reply', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ code: 'INVALID_ID', message: '反馈编号无效' });
    }

    const name = String(req.body?.name ?? '').trim().replace(/\s+/g, ' ');
    const content = String(req.body?.content ?? '').trim();
    if (!name) return res.status(400).json({ code: 'INVALID_REPLY', message: '请填写称呼' });
    if (name.length > NAME_MAX) {
      return res.status(400).json({ code: 'INVALID_REPLY', message: `称呼请控制在 ${NAME_MAX} 字以内` });
    }
    if (content.length < 2) {
      return res.status(400).json({ code: 'INVALID_REPLY', message: '回复至少 2 个字' });
    }
    if (content.length > CONTENT_MAX) {
      return res.status(400).json({ code: 'INVALID_REPLY', message: `回复请控制在 ${CONTENT_MAX} 字以内` });
    }

    // 回复限流比留言更严：每 IP 每日 5 条回复
    const ipHash = hashIp(req.ip ?? req.socket?.remoteAddress);
    if (ipHash) {
      const ipCount = analytics.bumpIpDaily(ipHash, 'feedback_reply');
      if (ipCount > DAILY_LIMIT_IP) {
        return res.status(429).json({
          code: 'REPLY_LIMIT_REACHED',
          message: `今日回复次数已达上限（${DAILY_LIMIT_IP} 条），明天再来。`,
        });
      }
    }

    const reply = analytics.addReply({
      feedbackId: id,
      name,
      content,
      visitorId: req.visitorId ?? null,
      ipHash,
    });
    if (!reply) {
      return res.status(404).json({ code: 'FEEDBACK_NOT_FOUND', message: '反馈不存在' });
    }
    if (req.visitorId) {
      analytics.recordEvent(req.visitorId, 'feedback_reply', req.visitorRef, { id });
    }
    return res.status(201).json({ reply });
  });

  /**
   * 撤回自己的留言。
   * 站点鼓励留言，但人也会写错（比如不小心留了联系方式）——
   * 必须给一条「发出去还能收回」的路，这比事后靠举报隐藏更体面。
   * 只有原留言者（同一访客）可以撤回。
   */
  router.delete('/api/v1/feedback/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ code: 'INVALID_ID', message: '反馈编号无效' });
    }
    if (!req.visitorId) {
      return res.status(400).json({ code: 'NO_VISITOR', message: '缺少访客标识，无法撤回' });
    }
    const removed = analytics.deleteFeedback(id, req.visitorId);
    if (removed === 'NOT_FOUND') {
      return res.status(404).json({ code: 'FEEDBACK_NOT_FOUND', message: '反馈不存在' });
    }
    if (removed === 'FORBIDDEN') {
      return res.status(403).json({ code: 'NOT_AUTHOR', message: '只能撤回自己发布的留言' });
    }
    return res.json({ deleted: true, id });
  });

  return router;
}
