import express from 'express';
import crypto from 'node:crypto';
import {
  buildPaymentNeeded,
  buildPaymentValidation,
  parsePaymentProof,
  formatISO8601WithTimezone,
  normalizeAmount,
  amountsEqual,
} from '../a2m/protocol.js';
import { answerGuide, namedNodes } from '../scene/index.js';
import { createQuest, issueCertificate } from '../scene/quest.js';
import { getScene, listScenes } from '../scene/scenes.js';
import { measure, priceFor, billingSummary } from '../metering/index.js';
import { createMcpHandler } from '../mcp/server.js';
import { hashIp } from '../analytics/store.js';

/** 任务评分：基础分 + 全部完成 + 按时完成 */
function computeQuestScore(quest) {
  let score = quest.scoring?.base ?? 100;
  for (const bonus of quest.scoring?.bonuses ?? []) {
    if (bonus.key === 'all_checkpoints') score += bonus.points;
    if (bonus.key === 'under_time') score += bonus.points;
  }
  return score;
}

/**
 * 付费资源路由 —— A2M 智能收（HTTP 402）核心控制流。
 *
 * 控制流严格对齐官方参考实现
 * （skills/alipay-aipay/.../code-examples/nodejs/4-按量付费/A2MPaymentDemo.md）：
 *
 *   1. 无 Payment-Proof → 构造 Payment-Needed → HTTP 402
 *   2. 有 Payment-Proof → verify → 五项核验 → 幂等履约 → 履约回执 → HTTP 200
 *
 * 不做内存订单兜底：订单仓储未绑定时直接失败（官方硬性要求）。
 */
export function createGuideRouter({ repository, alipayClient, config, services, sellerId, sellerName, demoPayer, analytics }) {
  const router = express.Router();

  const RESOURCE_PATH = '/api/v1/guide';
  /** 每位访客每天的免费试看次数——转化设计的冷启动层：先给一半价值，付费解锁全部 */
  const FREE_DAILY_LIMIT = 3;
  /** 按 IP 的上限：cookie 可重置，防刷必须落到 IP 哈希。
   *  ⚠️ 取值要容忍 NAT（校园/公司 WiFi 几百人共享一个出口 IP）——
   *  限的是「规模化刷量」（万级），不是正常共网流量。
   *  500 = 500 个访客额度的上限，办公室/宿舍楼一天也未必到；
   *  实测 200 会被高频验收 + 批量集成测试一天烧完（都是同 IP）。 */
  const FREE_DAILY_IP_LIMIT = 500;
  /** 演示代付按 IP 的每日上限（沙箱接口真实出账，防刷爆） */
  const DEMO_PAY_DAILY_IP_LIMIT = 100;
  /** 权益额度有效期（天）：多额度商品发放的次数余额在多久内有效 */
  const ENTITLEMENT_VALID_DAYS = 90;

  /** 按 IP 限流：返回 null 表示放行，否则返回当前计数 */
  function ipLimit(req, type) {
    if (!analytics) return null;
    const ipHash = hashIp(req.ip ?? req.socket?.remoteAddress);
    if (!ipHash) return null;
    return analytics.bumpIpDaily(ipHash, type);
  }

  function pickTier(req) {
    // mode=quest 走任务档位（一次任务 = 一个可交付的教育产品，客单价更高）
    const name = String(req.query.tier ?? (req.query.mode === 'quest' ? 'quest' : 'single'));
    const tier = services[name];
    if (!tier) {
      throw Object.assign(new Error(`未知档位：${name}`), { code: 'TIER_NOT_FOUND' });
    }
    return { name, tier };
  }

  /**
   * 资源生成器 —— 付费履约与「权益额度扣减」两条路径共用同一段代码，
   * 保证两条路径交付的内容完全一致（不会出现「买包给的和单买的不一样」）。
   */
  async function generateResource(req) {
    const sceneId = String(req.query.scene ?? 'demo-park');
    const mode = String(req.query.mode ?? 'guide');

    // 任务模式：交付一个可验证的「场景任务」（线索链 + 评分 + 完成凭证）
    const result =
      mode === 'quest'
        ? createQuest({
            sceneId,
            title: req.query.title ? String(req.query.title) : undefined,
            level: req.query.level ? String(req.query.level) : 'normal',
            checkpointNames: req.query.checkpoints
              ? String(req.query.checkpoints).split(',').map((s) => s.trim())
              : [],
          })
        : answerGuide({
            sceneId,
            query: String(req.query.query ?? ''),
            originHint: req.query.origin ? String(req.query.origin) : undefined,
          });

    if (!result.ok) {
      throw new Error(result.error ?? 'RESOURCE_GENERATION_FAILED');
    }

    // 任务模式：任务本体落库，进入「进行中」状态，等打卡完成后才发证书
    if (mode === 'quest' && result.quest) {
      const dbQuest = repository.createQuest({
        id: result.quest.id,
        outTradeNo: null,
        sceneId,
        title: result.quest.title,
        level: result.quest.level,
        brief: result.quest.brief,
        totalDistanceM: result.quest.total_distance_m,
        estimatedMinutes: result.quest.estimated_minutes,
        checkpoints: result.quest.checkpoints,
        clues: result.quest.clues,
        legs: result.quest.legs,
        scoring: result.quest.scoring,
      });
      // 统一成对外的字段命名（并带上任务状态）
      result.quest = {
        ...dbQuest,
        scene: { id: dbQuest.sceneId },
        total_distance_m: dbQuest.totalDistanceM,
        estimated_minutes: dbQuest.estimatedMinutes,
        measuredLegs: dbQuest.legs.filter((l) => l.measured).length,
        totalLegs: dbQuest.legs.length,
      };
      analytics?.recordEvent(req.visitorId, 'quest_start', req.visitorRef, {
        quest_id: dbQuest.id,
      });
    }

    const usage = measure(result);
    // 把用量与路线折线一起放进交付内容，便于前端直接展示与核验
    result.billing = billingSummary(usage);
    if (result.route && !result.route.polyline) {
      result.route.polyline = (result.route.points ?? []).map((p) => p.xy);
    }
    return { serviceResult: result, usage };
  }

  /** 场景一：首次请求（无 Payment-Proof）→ 返回 402 支付挑战 */
  async function createPaymentRequiredResponse(req, res) {
    try {
      const { name, tier } = pickTier(req);
      const amount = priceFor(tier);

      const outTradeNo = `SG_${Date.now()}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const resourceId = RESOURCE_PATH;
      const goodsName = `${tier.label} · 三维场景导览`;
      const payBefore = formatISO8601WithTimezone(new Date(Date.now() + 30 * 60 * 1000));

      const paymentNeeded = buildPaymentNeeded({
        outTradeNo,
        amount,
        currency: 'CNY',
        resourceId,
        payBefore,
        goodsName,
        sellerId,
        sellerName,
        sellerAppId: config.appId,
        serviceId: tier.serviceId,
        privateKeyB64: config.privateKeyB64,
      });

      // 订单必须先落库再返回 402：否则买家付款后服务端查不到订单（ORDER_NOT_FOUND）
      // 来源标注：demo=演示代付自测，api=外部真实调用（反刷量口径的核心字段）
      const source = req.get('x-sg-demo') === '1' ? 'demo' : 'api';
      await repository.createPending({
        outTradeNo,
        amount,
        currency: 'CNY',
        resourceId,
        goodsName,
        tier: name,
        payBefore,
        source,
      });
      if (req.visitorId) {
        repository.attributeOrder(outTradeNo, {
          visitorId: req.visitorId,
          refCode: req.visitorRef ?? null,
        });
        analytics?.recordEvent(req.visitorId, 'challenge', req.visitorRef, {
          out_trade_no: outTradeNo,
          source,
          tier: name,
        });
      }

      res.set('Payment-Needed', Buffer.from(JSON.stringify(paymentNeeded), 'utf8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, ''));

      return res.status(402).json({
        code: 'Payment-Needed',
        message: '需要支付',
        out_trade_no: outTradeNo,
        amount,
        currency: 'CNY',
        goods_name: goodsName,
      });
    } catch (error) {
      console.error('[402] 创建支付订单失败:', error.message);
      return res.status(500).json({
        code: 'CREATE_ORDER_ERROR',
        message: `创建订单失败：${error.message}`,
      });
    }
  }

  /** 场景二：二次请求（携带 Payment-Proof）→ 校验 → 履约 → 交付 */
  async function verifyPaymentAndDeliverResource(req, res, paymentProofHeader) {
    try {
      const parsed = parsePaymentProof(paymentProofHeader);
      if (!parsed.ok) {
        return createPaymentRequiredResponse(req, res);
      }
      const { paymentProof, tradeNo, clientSession } = parsed;

      const verified = await alipayClient.verifyPayment({ paymentProof, tradeNo, clientSession });
      if (!verified.ok) {
        console.error('[402] 验付失败:', verified.errorMessage);
        return createPaymentRequiredResponse(req, res);
      }

      const { tradeNo: verifiedTradeNo, outTradeNo, resourceId, amount: verifiedAmount, active } = verified.data;

      const order = outTradeNo ? await repository.findByOutTradeNo(outTradeNo) : null;
      if (!order) {
        console.error('[402] ORDER_NOT_FOUND:', outTradeNo);
        return res.status(404).json({ code: 'ORDER_NOT_FOUND', message: '本地订单不存在或已过期' });
      }

      // 沙箱模式下验付返回的部分字段可能为空，用本地订单回填；生产必须以验付结果为准
      const sandboxMode =
        config.gateway === 'https://openapi-sandbox.dl.alipaydev.com/gateway.do' &&
        order.tier === 'single';
      const effectiveTradeNo = verifiedTradeNo || tradeNo;
      const effectiveAmount = verifiedAmount || order.amount;
      const effectiveResourceId = resourceId || order.resourceId;

      // 五项业务核验
      if (active !== true) {
        return res.status(400).json({ code: 'INVALID_PAYMENT_PROOF', message: '支付凭证无效或已过期' });
      }
      if (!effectiveTradeNo || effectiveTradeNo !== tradeNo) {
        return res.status(400).json({ code: 'INVALID_PAYMENT_PROOF', message: '交易号不匹配' });
      }
      if (!amountsEqual(order.amount, effectiveAmount)) {
        return res.status(400).json({ code: 'AMOUNT_MISMATCH', message: '金额不匹配' });
      }
      if (!effectiveResourceId || effectiveResourceId !== order.resourceId || effectiveResourceId !== RESOURCE_PATH) {
        return res.status(400).json({ code: 'RESOURCE_ID_MISMATCH', message: '资源标识不匹配' });
      }
      if (!sandboxMode && Date.parse(order.payBefore) <= Date.now()) {
        return res.status(400).json({ code: 'INVALID_PAYMENT_PROOF', message: '支付已超时' });
      }

      // 幂等履约：资源只生成一次，履约回执失败时允许用同一笔 Payment-Proof 重试
      // 支付闭环的漏斗终点：凭证验签通过、订单匹配成功
      if (order.visitorId) {
        analytics?.recordEvent(order.visitorId, 'paid', order.refCode, {
          out_trade_no: outTradeNo,
          tier: order.tier,
        });
      }

      const fulfillment = await repository.prepareFulfillment({
        outTradeNo,
        tradeNo: effectiveTradeNo,
        expectedAmount: normalizeAmount(effectiveAmount),
        expectedResourceId: effectiveResourceId,
        createResource: async () => generateResource(req),
      });

      if (!fulfillment?.serviceResult) {
        throw new Error('订单仓储未返回已持久化的履约结果');
      }
      const serviceResult = fulfillment.serviceResult;

      // 多额度商品付清后发放权益额度台账（幂等：重试同一笔 Payment-Proof 不会重复发）
      const entitlement = grantEntitlementForOrder(order);

      if (fulfillment.state === 'FULFILLED') {
        return sendResource(res, effectiveTradeNo, outTradeNo, effectiveResourceId, serviceResult, true, entitlement);
      }

      const confirmed = await alipayClient.confirmFulfillment({ tradeNo: effectiveTradeNo });
      if (!confirmed.ok) {
        return res.status(502).json({
          code: 'FULFILLMENT_CONFIRM_FAILED',
          message: '资源已生成但履约确认失败，请稍后使用同一 Payment-Proof 重试',
        });
      }

      await repository.markFulfilled(outTradeNo, effectiveTradeNo);
      return sendResource(res, effectiveTradeNo, outTradeNo, effectiveResourceId, serviceResult, false, entitlement);
    } catch (error) {
      console.error('[402] 验付异常:', error.message);
      return res.status(500).json({ code: 'VERIFY_FAILED', message: `支付凭证验证失败：${error.message}` });
    }
  }

  /**
   * 多额度商品（quota > 1）付清后发放额度，并把「本次交付」计为已用 1 次。
   * 买家买到 10 次，当场用掉 1 次 → 余额 9 次，全部用完才回到 402。
   */
  function grantEntitlementForOrder(order) {
    if (!order?.visitorId) return null;
    const tier = services[order.tier];
    const quota = Number(tier?.quota ?? 1);
    if (!Number.isFinite(quota) || quota <= 1) return null;

    const granted = repository.grantEntitlement({
      visitorId: order.visitorId,
      tier: order.tier,
      outTradeNo: order.outTradeNo,
      quota,
      validDays: ENTITLEMENT_VALID_DAYS,
    });
    if (!granted) return null;

    // 本次交付消耗 1 次额度
    const consumed = repository.consumeEntitlement(order.visitorId);
    const balance = repository.entitlementBalance(order.visitorId);
    return {
      tier: order.tier,
      quota,
      granted: granted.quota,
      used: consumed?.used ?? granted.used,
      remaining: balance.remaining,
      expires_at: granted.expiresAt,
      source: 'purchase',
    };
  }

  /**
   * 权益额度交付路径：访客已购买多额度商品时，本次调用直接从余额扣 1 次交付，
   * 不再发起支付挑战。余额不足时返回 false，调用方回到 402。
   */
  async function deliverFromEntitlement(req, res) {
    const visitorId = req.visitorId;
    if (!visitorId) return false;
    // 演示代付链路必须走真实支付：内部回环请求带这个标记，跳过额度直交付
    if (req.get('x-sg-ignore-entitlement') === '1') return false;
    // 研学任务是独立交付物，不消耗「导览次数」额度
    if (String(req.query.mode ?? 'guide') !== 'guide') return false;

    const consumed = repository.consumeEntitlement(visitorId);
    if (!consumed) return false;

    try {
      const { serviceResult } = await generateResource(req);
      analytics?.recordEvent(visitorId, 'entitlement_use', req.visitorRef, {
        tier: consumed.tier,
        remaining: consumed.remaining,
      });
      res.set('X-SG-Entitlement-Remaining', String(consumed.remaining));
      return res.json({
        code: 'OK',
        resource_id: RESOURCE_PATH,
        content: serviceResult,
        entitlement: {
          tier: consumed.tier,
          quota: consumed.quota,
          used: consumed.used,
          remaining: consumed.remaining,
          expires_at: consumed.expiresAt,
          source: 'entitlement',
        },
      });
    } catch (err) {
      // 资源生成失败 → 把刚扣掉的那次额度还回去，不能让买家白扣
      repository.refundEntitlement(consumed.id);
      console.error('[entitlement] 资源生成失败，额度已归还:', err.message);
      return res.status(500).json({
        code: 'ENTITLEMENT_DELIVERY_FAILED',
        message: `额度交付失败，次数已返还：${err.message}`,
      });
    }
  }

  function sendResource(res, tradeNo, outTradeNo, resourceId, serviceResult, alreadyFulfilled, entitlement) {
    res.set(
      'Payment-Validation',
      buildPaymentValidation({ tradeNo, outTradeNo, resourceId, validated: true }),
    );
    return res.json({
      resource_id: resourceId,
      content: serviceResult,
      trade_no: tradeNo,
      out_trade_no: outTradeNo,
      already_fulfilled: alreadyFulfilled,
      ...(entitlement ? { entitlement } : {}),
      fulfillment_confirmed: true,
    });
  }

  /**
   * 免费试看：转化漏斗的第一层。
   * 只给答案文本，不给路线图 / 距离 / 证据哈希——那些是付费版的可核验价值。
   * 每位访客每天 FREE_DAILY_LIMIT 次，按访客 cookie 限流（服务端计数，不是前端自觉）。
   */
  async function createFreePreview(req, res) {
    try {
      const visitorId = req.visitorId;
      if (!visitorId) return res.status(400).json({ code: 'NO_VISITOR' });

      // 双层限流：访客 cookie（正常用户）+ IP 哈希（清 cookie 的刷子）
      const ipCount = ipLimit(req, 'free_preview');
      if (ipCount !== null && ipCount > FREE_DAILY_IP_LIMIT) {
        return res.status(429).json({
          code: 'FREE_LIMIT_REACHED',
          message: '今日免费试看次数已用完，明天再来，或付费解锁无限次。',
          free_remaining: 0,
        });
      }

      const used = analytics.countTodayEvents(visitorId, 'free_preview');
      const remaining = Math.max(0, FREE_DAILY_LIMIT - used);
      if (remaining <= 0) {
        return res.status(429).json({
          code: 'FREE_LIMIT_REACHED',
          message: `今日 ${FREE_DAILY_LIMIT} 次免费试看已用完，明天再来，或付费解锁无限次。`,
          free_remaining: 0,
        });
      }

      const result = answerGuide({
        sceneId: String(req.query.scene ?? 'demo-park'),
        query: String(req.query.query ?? ''),
        originHint: req.query.origin ? String(req.query.origin) : undefined,
      });
      if (!result.ok) {
        return res.status(400).json({ code: result.error, message: result.message ?? '' });
      }

      analytics.recordEvent(visitorId, 'free_preview', req.visitorRef, {
        scene: result.scene?.id,
        intent: result.intent,
      });

      return res.json({
        preview: true,
        answer: result.answer,
        scene: result.scene,
        free_remaining: remaining - 1,
        upsell: {
          message: '完整结果包含：可核验的路线拓扑、精确距离与步行时间、证据哈希。',
          unlock: `${RESOURCE_PATH}?scene=…&query=…（走 HTTP 402 支付流程）`,
        },
      });
    } catch (err) {
      return res.status(500).json({ code: 'PREVIEW_FAILED', message: err.message });
    }
  }

  router.get(RESOURCE_PATH, async (req, res) => {
    const paymentProof = req.headers['payment-proof'];
    if (!paymentProof || String(paymentProof).trim() === '') {
      if (req.query.preview === '1') return createFreePreview(req, res);
      // 权益额度优先：已购多额度商品的访客，本次交付从余额扣减，不再发起支付挑战
      const delivered = await deliverFromEntitlement(req, res);
      if (delivered !== false) return delivered;
      return createPaymentRequiredResponse(req, res);
    }
    return verifyPaymentAndDeliverResource(req, res, paymentProof);
  });

  /** 我的权益额度：前端展示余额 / 到期时间；也便于买家自助核对 */
  router.get('/api/v1/entitlements', (req, res) => {
    const balance = repository.entitlementBalance(req.visitorId);
    return res.json({
      ...balance,
      valid_days: ENTITLEMENT_VALID_DAYS,
      visitor_bound: Boolean(req.visitorId),
    });
  });

  /**
   * 沙箱演示：一键完成「发现 → 支付 → 交付」全流程。
   * 仅沙箱环境可用，正式环境直接拒绝。
   */
  router.post('/api/v1/demo/pay', async (req, res) => {
    if (config.env !== 'sandbox') {
      return res.status(403).json({ error: '正式环境不允许服务端代付' });
    }

    // 按 IP 限流：沙箱收银是真实出账接口，防刷爆
    const demoCount = ipLimit(req, 'demo_pay');
    if (demoCount !== null && demoCount > DEMO_PAY_DAILY_IP_LIMIT) {
      return res.status(429).json({
        error: `今日演示支付次数已达上限（${DEMO_PAY_DAILY_IP_LIMIT}），明天再来。`,
      });
    }

    const { scene = 'demo-park', query = '', mode, level, checkpoints, title, tier } = req.body ?? {};
    const params = new URLSearchParams({ scene, query });
    if (mode) params.set('mode', String(mode));
    if (level) params.set('level', String(level));
    if (checkpoints) params.set('checkpoints', String(checkpoints));
    if (title) params.set('title', String(title));
    if (tier) params.set('tier', String(tier));
    // 内部回环请求直连本进程端口：不经反向代理、与部署前缀无关
    const selfBase = process.env.SELF_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`;
    const resourceUrl = `${selfBase}${RESOURCE_PATH}?${params}`;

    try {
      // 🔴 内部回环必须带外层访客 id（req.visitorId 由归因中间件在 handler 之前定下）。
      //    只转发浏览器原始 cookie 是不够的：首次访问时浏览器还没有 cookie，
      //    内部请求会拿到另一个随机访客 id，导致订单与权益额度落在「另一个人」身上。
      const visitorCookie = req.visitorId ? `sg_vid=${req.visitorId}` : '';

      // 1. 先取一次 402 支付挑战
      // 🔴 转发浏览器访客的 cookie + 来源标记：
      //    这样订单归因到真实访客，且 source=demo（反刷量口径：自测 ≠ 真实付费）
      const internalHeaders = {
        'x-sg-demo': '1',
        // 演示链路要展示完整支付过程，不能被「额度直交付」短路
        'x-sg-ignore-entitlement': '1',
        ...(visitorCookie ? { Cookie: visitorCookie } : {}),
      };
      const challengeRes = await fetch(resourceUrl, {
        headers: internalHeaders,
        signal: AbortSignal.timeout(15000),
      });
      if (challengeRes.status !== 402) {
        return res.status(400).json({
          error: `期望 402 支付挑战，实际 ${challengeRes.status}`,
        });
      }
      const paymentNeeded = challengeRes.headers.get('payment-needed');
      if (!paymentNeeded) {
        return res.status(400).json({ error: '响应缺少 Payment-Needed 头' });
      }

      // 2. 沙箱收银 → Payment-Proof → 重试原资源
      const result = await demoPayer.pay({
        paymentNeededBase64: paymentNeeded,
        buyerId: config.buyerUserId,
        resourceUrl,
        cookie: visitorCookie,
      });

      if (!result.ok) {
        return res.status(502).json({ error: result.error ?? '支付未完成' });
      }
      return res.json({
        content: result.body?.content ?? result.body,
        envelope: result.body,
        paymentValidationPreview: result.paymentValidationPreview,
        tradeNo: result.tradeNo,
        payUrl: result.payUrl,
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  /** 场景的可视化数据（前端画路网与地标用） */
  router.get('/api/v1/scene/:id', (req, res) => {
    const scene = getScene(req.params.id);
    if (!scene) return res.status(404).json({ error: 'SCENE_NOT_FOUND' });

    const roadNodes = scene.nodes.filter((n) => n.id.startsWith('w_'));
    const indexOf = new Map(roadNodes.map((n, i) => [n.id, i]));
    const edges = [];
    for (const e of scene.edges) {
      const a = indexOf.get(e.from);
      const b = indexOf.get(e.to);
      if (a === undefined || b === undefined) continue;
      edges.push([a, b]);
    }

    const pois = namedNodes(scene).map((n) => ({
      id: n.id,
      name: n.name,
      type: n.type,
      xy: n.xy,
      lonlat: n.lonlat,
    }));

    return res.json({
      id: scene.id,
      name: scene.name,
      description: scene.description,
      attribution: scene.attribution ?? null,
      graph: { nodes: roadNodes.map((n) => n.xy), edges },
      pois,
      // 建筑轮廓：用于三维体块拉伸
      connectivity: scene.connectivity ?? null,
      footprints: (scene.footprints ?? []).map((f) => ({
        id: f.id,
        name: f.name,
        ring: f.ring,
        heightM: f.heightM,
        levels: f.levels,
        kind: f.kind,
      })),
    });
  });

  /** 未付费也能看到的场景目录（帮助 Agent 决定该买哪个服务） */
  router.get('/api/v1/scenes', (req, res) => {
    res.json({ scenes: listScenes() });
  });

  /**
   * MCP 端点 —— 让 Agent 能「发现」本服务。
   * 对应 Agent Pay 赛道描述的第一环：Agent 发现服务。
   */
  const mcp = createMcpHandler({
    listScenes,
    answerGuide,
    createQuest,
    measure,
    billingSummary,
    services,
  });

  router.post('/mcp', async (req, res) => {
    try {
      const out = await mcp(req.body);
      if (out === null) return res.status(202).end();
      return res.json(out);
    } catch (err) {
      return res.status(500).json({
        jsonrpc: '2.0',
        id: req.body?.id ?? null,
        error: { code: -32603, message: err.message },
      });
    }
  });

  /** 订单状态查询（验收脚本远程化用；不含任何隐私字段） */
  router.get('/api/v1/orders/:outTradeNo', async (req, res) => {
    const order = await repository.findByOutTradeNo(req.params.outTradeNo);
    if (!order) return res.status(404).json({ code: 'ORDER_NOT_FOUND' });
    return res.json({
      out_trade_no: order.outTradeNo,
      order_status: order.orderStatus,
      fulfill_status: order.fulfillStatus,
      trade_no: order.tradeNo,
      amount: order.amount,
      tier: order.tier,
    });
  });

  /* ────────────── 场景任务：打卡闭环 ────────────── */

  /** 查询任务状态（含已打卡与证书） */
  /**
   * 统一的任务呈现层：仓储出库是驼峰，前端渲染读蛇形别名。
   * 🔴 初次履约路径手工对齐过这套别名，但打卡/查询路径之前没有 ——
   *    完成证书页会渲染出 undefined m / undefined min（实测抓到）。
   */
  function presentQuest(quest) {
    if (!quest) return quest;
    return {
      ...quest,
      scene: { id: quest.sceneId },
      total_distance_m: quest.totalDistanceM,
      estimated_minutes: quest.estimatedMinutes,
      measuredLegs: (quest.legs ?? []).filter((l) => l.measured).length,
      totalLegs: (quest.legs ?? []).length,
    };
  }

  router.get('/api/v1/quests/:id', (req, res) => {
    const quest = repository.findQuest(req.params.id);
    if (!quest) return res.status(404).json({ code: 'QUEST_NOT_FOUND' });
    return res.json(presentQuest(quest));
  });

  /**
   * 打卡。必须按线索链顺序 —— 这是「教育产品」与「发个 PDF」的本质区别：
   * 顺序错了、跳站了，都会被拒绝，证书也拿不到。
   */
  router.post('/api/v1/quests/:id/checkin', (req, res) => {
    const { point_id: pointId } = req.body ?? {};
    if (!pointId) return res.status(400).json({ code: 'POINT_ID_REQUIRED' });

    const result = repository.checkin(req.params.id, pointId);
    if (!result.ok) {
      const messages = {
        QUEST_NOT_FOUND: '任务不存在',
        QUEST_ALREADY_COMPLETED: '任务已完成',
        ALREADY_CHECKED_IN: '这一站已经打过卡了',
        UNKNOWN_POINT: '打卡点不在本任务的线索链里',
        OUT_OF_ORDER: `顺序不对：请先完成第 ${(result.expectedSeq ?? 0) + 1} 站`,
      };
      return res.status(400).json({
        code: result.code,
        message: messages[result.code] ?? result.code,
        quest: result.quest ?? null,
      });
    }

    analytics?.recordEvent(req.visitorId, 'quest_checkin', req.visitorRef, {
      quest_id: req.params.id,
      point_id: pointId,
    });

    // 全部完成 → 计算评分并颁发证书
    let quest = result.quest;
    if (quest.checkins.length === quest.checkpoints.length) {
      const score = computeQuestScore(quest);
      const certificate = issueCertificate(quest, quest.checkins, score);
      quest = repository.completeQuest(quest.id, certificate);
      analytics?.recordEvent(req.visitorId, 'quest_complete', req.visitorRef, {
        quest_id: req.params.id,
        score,
      });
    }

    return res.json({ ok: true, quest: presentQuest(quest) });
  });

  /**
   * 站点聚合数据：所有数字都从真实运行状态读出，不做硬编码。
   */
  router.get('/api/v1/meta', (req, res) => {
    const stats = repository.stats();
    const scenes = listScenes().map((s) => {
      const scene = getScene(s.id);
      const named = scene ? namedNodes(scene).length : 0;
      return {
        id: s.id,
        name: s.name,
        description: s.description,
        source: s.source ?? 'builtin',
        nodes: s.nodes,
        edges: s.edges,
        namedPois: named,
        attribution: scene?.attribution ?? null,
        connectivity: scene?.connectivity ?? null,
      };
    });

    return res.json({
      visitor: {
        refCode: req.visitorRef ?? null,
      },
      product: {
        name: '三维问路',
        nameEn: 'SceneGuide',
        tagline: '可被 Agent 自动购买的场景导览服务',
      },
      tracks: [
        {
          id: 'machine-pay',
          name: 'Machine Pay',
          role: '主赛道',
          brief: '让 AI 服务按实际使用量计费与支付，以可核验用量完成结算。',
          form: 'REST API · HTTP 402（实现最完整）',
        },
        {
          id: 'vibe-pay',
          name: 'Vibe Pay',
          role: '交付形态 · 主展示',
          brief: '为可运行的 AI 应用接入收款，让创意成为可经营的产品。',
          form: '网页应用',
        },
        {
          id: 'skill-pay',
          name: 'Skill Pay',
          role: '衍生形态',
          brief: '为 AI 技能接入收款，让技能从调用到交付形成完整闭环。',
          form: 'SKILL.md',
        },
        {
          id: 'agent-pay',
          name: 'Agent Pay',
          role: '交易链路',
          brief: '探索 Agent 发现服务、发起支付与获得交付的新型交易链路。',
          form: 'Agent 自主采购',
        },
      ],
      stats,
      scenes,
      tiers: Object.entries(services).map(([name, t]) => ({
        name,
        label: t.label,
        unitPrice: t.unitPrice,
        productionPrice: t.productionPrice ?? t.unitPrice,
        quota: t.quota ?? 1,
        serviceId: t.serviceId,
      })),
      sandboxPriceNote:
        config.env === 'sandbox'
          ? '沙箱 mock 服务的注册价固定 ¥0.01，本地联调统一按此价；生产环境按右侧生产价注册。'
          : null,
      protocol: {
        header: 'Payment-Needed',
        status: 402,
        merchantApis: [
          'alipay.aipay.agent.payment.verify',
          'alipay.aipay.agent.fulfillment.confirm',
        ],
        buyerCli: [
          'alipay-bot -- check-wallet',
          'alipay-bot -- 402-buyer-pay -f <402_needed_file>',
          'alipay-bot 402-query-payment-status -t <tradeNo> -r <url>',
          'alipay-bot -- 402-buyer-fulfillment-ack -t <tradeNo>',
        ],
      },
      env: config.env,
      gateway: config.gateway,
      sellerId,
    });
  });

  /** 订单与用量看板（商业化表现的证据面板） */
  router.get('/api/v1/stats', (req, res) => {
    res.json(repository.stats());
  });

  router.__resourcePath = RESOURCE_PATH;
  return router;
}
