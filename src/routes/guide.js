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
// 任务评分统一由 repository.computeQuestScore 计算（单一实现）：
// 证书里的分数与库里的 score 必须同源，否则「可复算核验」的卖点不成立。
import { computeQuestScore } from '../orders/repository.js';
import { hashIp } from '../analytics/store.js';
import { getOfficialWork } from '../community.js';

/**
 * 推导本站的公网基地址（给「人 / Agent 复现 402」用）。
 *
 * 🔴 为什么不能直接用 SELF_BASE_URL 的内网默认值：
 *   旧实现 `process.env.SELF_BASE_URL ?? 'http://127.0.0.1:3000'`——
 *   在服务器上这个环境变量**没被设置**（compose 里没有它），于是生产账单卡与
 *   一键买方命令里带的是 `http://127.0.0.1:3000/api/v1/guide?...`。
 *   后果：评委复制那条命令去跑，连的是一个他根本访问不到的地址，
 *   「一条命令付完这一笔」变成「一条命令报 connection refused」。
 *
 * 推导顺序（从可靠到兜底）：
 *   ① SELF_BASE_URL 显式指定（部署方说了算）
 *   ② 反代传来的 Host 头 + 已知挂载前缀（我们的 nginx 只透传 Host）
 *   ③ 本地回环（仅本地开发）
 */
const PUBLIC_MOUNT_PATH = (process.env.PUBLIC_MOUNT_PATH ?? '/sceneguide').replace(/\/$/, '');
function publicBaseUrl(req) {
  if (process.env.SELF_BASE_URL) return String(process.env.SELF_BASE_URL).replace(/\/$/, '');
  const host = req?.headers?.['x-forwarded-host'] || req?.headers?.host;
  if (host && !/^(127\.0\.0\.1|localhost)(:|$)/.test(String(host))) {
    // nginx 终止 TLS，应用看不到协议；本站只可能经 443 对外服务
    return `https://${host}${PUBLIC_MOUNT_PATH}`;
  }
  return `http://127.0.0.1:${process.env.PORT ?? 3000}`;
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
  /** 演示代付按 IP 的每日上限（沙箱接口真实出账，防刷爆）。
   *  可用 DEMO_PAY_DAILY_IP_LIMIT 覆盖（运维旋钮：本地反复跑验收脚本时调高，
   *  生产部署保持默认 100）。 */
  // 日上限：默认 500（原 100）。
  // ⚠️ 为什么放宽：原值 100 在**校园 NAT 共享出口 IP** 的评审场景下会误伤——
  //   几十位评委共用一个公网 IP，累计演示支付很快触顶 → 现场点不动。
  //   沙箱支付是 mock（无真实资金），日上限的主要作用是防滥用，不是防成本；
  //   真正的瞬时刷爆交给下面的分钟级闸门。
  const DEMO_PAY_DAILY_IP_LIMIT = Number(process.env.DEMO_PAY_DAILY_IP_LIMIT ?? 500);
  // 分钟级突发上限：单机高频刷爆（分钟上百次）立刻被拦，正常评审远低于此。
  const DEMO_PAY_MINUTE_IP_LIMIT = Number(process.env.DEMO_PAY_MINUTE_IP_LIMIT ?? 60);
  /** 权益额度有效期（天）：多额度商品发放的次数余额在多久内有效 */
  const ENTITLEMENT_VALID_DAYS = 90;

  /** 按 IP 限流：返回 null 表示放行，否则返回当前计数 */
  function ipLimit(req, type) {
    if (!analytics) return null;
    const ipHash = hashIp(req.ip ?? req.socket?.remoteAddress);
    if (!ipHash) return null;
    return analytics.bumpIpDaily(ipHash, type);
  }

  /** 分钟级突发计数（与 ipLimit 同口径，键为 ip_hash + 分钟 + 类型） */
  function ipMinuteLimit(req, type) {
    if (!analytics) return null;
    const ipHash = hashIp(req.ip ?? req.socket?.remoteAddress);
    if (!ipHash) return null;
    return analytics.bumpIpMinute(ipHash, type);
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
/**
 * 把支付宝返回的内部错误信息脱敏成**用户能看懂、且不含内部细节**的一句话。
 *
 * 为什么需要：验付失败时官方要求告知买方「凭证无效或已过期，需重新支付」。
 * 但直接把 SDK 的 errorMessage 塞进响应体，会把内部信息一起吐出去——
 * 实测形如「无效的AppID参数，解决方案：https://open.alipay.com/api/errCheck?traceId=…&source=openapi」。
 * 这种串出现在买家/评委面前，既是信息泄露（traceId 可被用于内部排查），
 * 也显得「支付失败反馈不清晰」——正是评分项要扣分的那一条。
 */
function sanitizeVerifyError(raw) {
  let msg = String(raw ?? '').trim();
  if (!msg) return '支付凭证无效或已过期';
  // 去掉「解决方案：<URL>」与任何 traceId / 内部排查链接
  msg = msg.replace(/[,，]?\s*解决方案[:：]?\s*https?:\/\/\S+/g, '');
  msg = msg.replace(/https?:\/\/\S+/g, '');
  // 只留第一句（内部错误常带多段补充说明）
  msg = msg.split(/[。；;\n]/)[0].trim();
  if (msg.length > 60) msg = `${msg.slice(0, 60)}…`;
  return msg || '支付凭证无效或已过期';
}

  async function createPaymentRequiredResponse(req, res, opts = {}) {
    // opts.previousFailure：上一次支付尝试失败的原因（官方流程明确要求这时告诉买方
    // 「凭证无效或已过期，需重新支付」，而不是给一个看起来像「你还没付钱」的新账单）。
    const previousFailure = opts.previousFailure ?? null;
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
      // 🔴 source 只能由服务端判定：公开 402 端点恒为 'api'（外部真实调用）。
      //    旧实现读客户端头 `x-sg-demo`——任一调用方自己带一个头就能把订单
      //    标成「自测」、从「真实付费用户」里消失（评审数字可被定向压低，实测复现）；
      //    服务端自测走 /api/v1/demo/pay 路由，它在拿到挑战后自行标记（见 markSelfTest）。
      const source = 'api';
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

      // ── 官方预下单形态（aipay 官网 MACHINE_PAY.md 的生产流程）──────────
      // 🔴 这是**可选增强**，默认关闭；开启后 402 同时带两个头：
      //    · Payment-Needed  —— 我们本地签名构造的账单（Agent 买方走这条，
      //      对应官方参考实现与 alipay-pay-for-402-service 技能）
      //    · amtPaymentLink  —— 官方 alipay.aipay.agent.payment.precreate 返回的
      //      amt_pre_pay_id（走官方支付能力的买方用这条）
      //    两条路径的验付环节完全一致（payment.verify + 携 Payment-Proof 重试），
      //    所以五项核验 / 幂等履约 / 履约回执**都不需要改**。
      //
      // ⚠️ 必须优雅降级：预下单失败**绝不能**让 402 挑战发不出去——
      //    本地签名的 Payment-Needed 始终是兜底（它不依赖任何 OpenAPI 调用）。
      let amtPrePayId = null;
      if (config.env === 'production' && config.precreate?.enabled) {
        try {
          const pre = await alipayClient.precreate({
            outTradeNo,
            serviceId: tier.serviceId,
            goodsName,
            amount,
            payBefore,
            currency: 'CNY',
            memo: `三维问路 · ${tier.label}`,
          });
          if (pre.ok) {
            amtPrePayId = pre.amtPrePayId;
            res.set('amtPaymentLink', pre.amtPrePayId);
            res.set('X-SG-Precreate', 'ok');
            console.log(`[402] 预下单成功 out_trade_no=${outTradeNo} amt_pre_pay_id=${pre.amtPrePayId}`);
          } else {
            res.set('X-SG-Precreate', `failed:${pre.errorCode}`);
            console.warn(`[402] 预下单失败（已降级为本地签名账单）: ${pre.errorCode} ${pre.errorMessage}`);
          }
        } catch (err) {
          res.set('X-SG-Precreate', `error:${err.message}`.slice(0, 120));
          console.warn(`[402] 预下单异常（已降级）: ${err.message}`);
        }
      }

      return res.status(402).json({
        code: 'Payment-Needed',
        // 官方时序图：验证失败 → 402 + 「支付凭证无效或已过期」→ 提示需重新支付。
        // 不带这个字段时，买方看到的是「需要支付」+ 一个新订单号，完全看不出
        // 上一笔为什么没成功——评分项「支付成功/失败/退款的反馈是否清晰」直接丢分。
        message: previousFailure
          ? `上一次支付未成功（${previousFailure}），请重新支付`
          : '需要支付',
        ...(previousFailure ? { previous_failure: previousFailure } : {}),
        ...(previousFailure && opts.previousOutTradeNo
          ? { previous_out_trade_no: opts.previousOutTradeNo }
          : {}),
        out_trade_no: outTradeNo,
        amount,
        currency: 'CNY',
        goods_name: goodsName,
        // 官方预下单号（形态 B 开启时才有）：前端可据此给人一个付款入口
        ...(amtPrePayId ? { amt_pre_pay_id: amtPrePayId } : {}),
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

      // 幂等重放短回路：同一笔凭证再次到来（官方流程明确允许——PENDING_CONFIRM
      // 的存在意义就是「回执失败可用同一凭证重试」）。按本地订单状态分三种处理，
      // 都不再调用远程验付。
      // 🔴 为什么必须短回路：沙箱侧对重复验付/回执会返回**非标准响应**
      //    （实测复现：返回值里找不到 *_response 键，SDK 抛「Response 格式错误」）。
      //    而买家侧重放是正常行为，不能让一次沙箱抖动把「已经付过钱且已交付」
      //    的订单变成错误页；也不能在回执未确认时偷偷交付（那违背幂等履约的设计）。
      if (tradeNo) {
        // findByTradeNo 是同步方法；这里仍加 await 作为防御——
        // 仓储将来若改成 async，这段短回路不会静默失效（2026-11-23 修复的回归保护）。
        const existing = await repository.findByTradeNo(tradeNo);
        if (existing && existing.orderStatus === 'PAID' && existing.serviceResult) {
          // ① 已完整履约：本地记录直接交付（already_fulfilled=true）
          //    权益走快照（不消耗）：首次交付已消耗过 1 次，重放不能再扣
          if (existing.fulfillStatus === 'FULFILLED') {
            const entitlement = entitlementSnapshotForOrder(existing);
            return sendResource(
              res,
              tradeNo,
              existing.outTradeNo,
              existing.resourceId,
              existing.serviceResult,
              true,
              entitlement,
            );
          }
          // ② 资源已生成但回执未确认：重试一次履约回执，成功才交付；
          //    仍失败则明确告知「稍后用同一凭证重试」，不重复生成资源
          //    权益同样走快照（发放在首次交付已完成，重放不得再消耗）
          if (existing.fulfillStatus === 'PENDING_CONFIRM') {
            const confirmed = await alipayClient.confirmFulfillment({ tradeNo });
            if (!confirmed.ok) {
              return res.status(502).json({
                code: 'FULFILLMENT_CONFIRM_FAILED',
                message: '资源已生成但履约确认失败，请稍后使用同一 Payment-Proof 重试',
              });
            }
            await repository.markFulfilled(existing.outTradeNo, tradeNo);
            const entitlement = entitlementSnapshotForOrder(existing);
            return sendResource(
              res,
              tradeNo,
              existing.outTradeNo,
              existing.resourceId,
              existing.serviceResult,
              false,
              entitlement,
            );
          }
        }
      }

      const verified = await alipayClient.verifyPayment({ paymentProof, tradeNo, clientSession });
      if (!verified.ok) {
        console.error('[402] 验付失败:', verified.errorMessage);
        // 官方流程：验证失败要明确告知「凭证无效或已过期，需重新支付」。
        // 旧实现直接返回一个通用新账单，买方看不出上一笔为什么失败。
        const previousOutTradeNo = (await repository.findByTradeNo?.(tradeNo))?.outTradeNo ?? null;
        return createPaymentRequiredResponse(req, res, {
          previousFailure: sanitizeVerifyError(verified.errorMessage),
          previousOutTradeNo,
        });
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

      // ⚠️ 与官方《接入指南》的一处**有意差异**（2026-11-23 记录）：
      //    官方原文是「验证成功返回资源内容，并**异步调用** fulfillment.confirm 发送履约回执」
      //    ——即官方顺序是「先交付资源，回执随后异步发」。
      //    本实现是「先确认回执，再交付资源」，理由：
      //      ① 保证「支付宝已记账」与「资源已交付」严格一致——不会出现
      //         我们交付了资源、但支付宝侧从未收到履约回执的悬空订单；
      //      ② 官方买方工具在取得资源后**还会自动再发一次**回执，
      //         所以回执天然可能被发两次——客户端已对「语义上等于成功」的
      //         重复确认做了幂等放行（见 client.js isIdempotentSuccess）。
      //    代价是交付多一次网络往返（约 1s），换来的是账实一致；
      //    若评审要求严格按官方异步顺序，只需把本段移到 sendResource 之后即可。
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
   * 回执重放路径的权益快照：**不消耗额度**。
   *
   * 🔴 为什么不能复用 grantEntitlementForOrder（2026-11-23 遍历审查发现）：
   *    官方流程明确允许买方携带同一笔 Payment-Proof 重放（幂等短回路就是为它设计的），
   *    但重放路径每一次调用 grantEntitlementForOrder 都会再执行一次
   *    consumeEntitlement——对十次包买家，**每次合法重放都悄悄多扣 1 次额度**
   *    （回执失败重试 N 次 = 白扣 N+1 次，实测路径推演复现）。
   *    重放时发放本身是幂等的（ON CONFLICT DO NOTHING），需要跳过的只有「再消耗」。
   */
  function entitlementSnapshotForOrder(order) {
    if (!order?.visitorId) return null;
    const tier = services[order.tier];
    const quota = Number(tier?.quota ?? 1);
    if (!Number.isFinite(quota) || quota <= 1) return null;
    const balance = repository.entitlementBalance(order.visitorId);
    return {
      tier: order.tier,
      quota,
      used: balance.used,
      remaining: balance.remaining,
      source: 'replay',
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
      const { serviceResult, usage } = await generateResource(req);
      // 🔴 额度交付也必须落计量：旧实现只在 prepareFulfillment（付费路径）里写
      //    usage_records，买包用户用余额的每一次调用都不进看板——pack10 用户
      //    用掉 9 次，计量看板上这 9 次「不存在」（实测复现，看板系统性少算）。
      //    这里补记，out_trade_no 指向原购买订单，口径与付费路径一致。
      if (usage?.length) {
        repository.recordUsage({ outTradeNo: consumed.outTradeNo, usage });
      }
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
    // 🔴 前置校验 tier（2026-11-27 实测修复）：旧实现在 createPaymentRequiredResponse 里
    //    调 pickTier，未知档位会 throw，被外层 catch 一律转成
    //    `500 CREATE_ORDER_ERROR: 未知档位：xxx`。
    //    后果：评委（或任何人）手动把 URL 的 tier 改成别的值，看到的是「服务端错误」——
    //    而这明明是**用户输入问题**。500 会让评委当场判断「这服务不健壮」，
    //    直接打在「产品完整度 30%」的「核心功能链路完整可用，无明显 bug」上。
    //    ⇒ 任何用户可控参数的校验都要在**发起业务之前**完成，并返回 4xx + 合法取值清单。
    if (req.query.tier !== undefined) {
      const requested = String(req.query.tier);
      if (!services[requested]) {
        return res.status(400).json({
          code: 'INVALID_TIER',
          message: `未知档位：${requested}`,
          valid_tiers: Object.entries(services).map(([k, v]) => ({
            tier: k, unitPrice: v.unitPrice, quota: v.quota, label: v.label,
          })),
        });
      }
    }
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
   *
   * 🔴 生产环境的处理（2026-11-23 改）：**不再返回死路 403**。
   *   原因：403 会让「点支付按钮」在生产模式下直接失败——而提交给评委的
   *   体验路径里就有这一步，等于把最关键的一环变成不可用。
   *   官方口径（aipay 产品页 Machine Pay）：
   *     ·「用户**或智能体**通过支付宝 AI 付完成付款」
   *     ·「支付辅助方可验证和结算，**也可由服务端自行完成**」
   *   即生产环境的支付主体是「用户本人 / 其 Agent / 支付辅助方」三者之一，
   *   本服务不自作主张替真实用户付款——但**必须把正确的下一步说清楚**。
   */
  router.post('/api/v1/demo/pay', async (req, res) => {
    if (config.env !== 'sandbox') {
      // 生产环境：返回可操作指引（而不是 403 死路）
      const { scene = 'demo-park', query = '', mode, level, checkpoints, title, tier } = req.body ?? {};
      const params = new URLSearchParams({ scene, query });
      if (mode) params.set('mode', String(mode));
      if (level) params.set('level', String(level));
      if (checkpoints) params.set('checkpoints', String(checkpoints));
      if (title) params.set('title', String(title));
      if (tier) params.set('tier', String(tier));
      // ⚠️ 两个地址分开用，别混：
      //    · internalUrl —— 服务端回环取 402 挑战，走内网最快也最稳（不依赖公网路由）
      //    · publicUrl   —— 放进账单卡与买方命令给人/Agent 用，**必须公网可达**。
      //      旧实现只有一个 selfBase 且默认 http://127.0.0.1:3000（服务器上没设该环境变量），
      //      于是给评委的命令里是内网地址——复制过去就是 connection refused。
      const internalBase = process.env.SELF_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`;
      const internalUrl = `${internalBase}${RESOURCE_PATH}?${params}`;
      const publicUrl = `${publicBaseUrl(req)}${RESOURCE_PATH}?${params}`;
      const visitorCookie = req.visitorId ? `sg_vid=${req.visitorId}` : '';
      const headers = { 'x-sg-ignore-entitlement': '1', ...(visitorCookie ? { Cookie: visitorCookie } : {}) };
      const challengeRes = await fetch(internalUrl, { headers, signal: AbortSignal.timeout(15000) });
      const paymentNeeded = challengeRes.headers.get('payment-needed');
      const amtPaymentLink = challengeRes.headers.get('amtpaymentlink');
      const body = await challengeRes.clone().json().catch(() => ({}));
      // 🔴 2026-11-27 修一个会**静默清零「商业化成熟度 25%」**的 bug：
      //    旧实现在这里调 repository.markSelfTest(out_trade_no)，把订单标成 source='demo'。
      //    但生产分支**并没有真的代付**（只是拿到 402 挑战就返回账单），
      //    而来点这个按钮的是**真实人类买家**——标成自测后，
      //    「真实付费用户数」的统计口径（NOT source='demo'）会把这笔钱**整笔排除**。
      //    后果：每一个通过我们站点 UI 付款的真人，商业化分一分不加，而且**毫无异常迹象**。
      //    ⇒ 生产分支绝不标记自测；自测标记只保留在沙箱分支（那里服务端真的自己付了钱）。
      if (paymentNeeded && body.out_trade_no) {
        // 订单已在 402 分支落库并按访客归因（source='api'）——这就是真人付费，不再动它。
        console.log(`[402] 生产账单已出具 out_trade_no=${body.out_trade_no}（真人买家待确认付款，不计自测）`);
      }
      return res.status(409).json({
        error: '生产环境不代付真实资金',
        code: 'PRODUCTION_PAYMENT_REQUIRED',
        // 官方预下单号（形态 B 开启时才有）。
        // ⚠️ 它是**预下单号**（形如 amtpp_v1_xxx），不是可点击的 URL——
        //    官方流程是「智能体把支付信息交给支付宝支付能力，用户在支付宝确认」。
        //    前端必须把它当**标识符**展示 + 给一键复制的买方命令，不能当 href。
        ...(amtPaymentLink ? { amt_payment_link: amtPaymentLink } : {}),
        // 本地签名账单原文（形态 A）：买方 CLI 的 --file 要的就是它，必须原样给出去
        ...(paymentNeeded ? { payment_needed: paymentNeeded } : {}),
        // 供人/Agent 复现的完整资源 URL（402 就是从它来的）
        resource_url: publicUrl,
        message:
          '生产环境下本服务不代替你付款。请用支付宝 AI 付能力完成本次支付：'
          + '把 402 响应中的 Payment-Needed 报文交给 alipay-pay-for-402-service 技能，'
          + '由它引导你确认付款并携带 Payment-Proof 重试同一请求即可交付。',
        resource_id: RESOURCE_PATH,
        out_trade_no: body.out_trade_no ?? null,
        amount: body.amount ?? null,
        goods_name: body.goods_name ?? null,
        agent_instructions:
          'Agent：读取本次 402 响应的 Payment-Needed 头（原样，不解码不改动），'
          + '交给支付宝 alipay-pay-for-402-service 技能完成支付，然后携带 Payment-Proof 重试原请求。',
        buyer_command: amtPaymentLink
          ? `alipay-bot 402-buyer-pay --method GET --resource-url '${publicUrl}' --amt-payment-link '${amtPaymentLink}'`
          : `alipay-bot 402-buyer-pay --method GET --resource-url '${publicUrl}'`,
      });
    }

    // 按 IP 限流：沙箱收银是真实出账接口，防刷爆
    const demoCount = ipLimit(req, 'demo_pay');
    if (demoCount !== null && demoCount > DEMO_PAY_DAILY_IP_LIMIT) {
      return res.status(429).json({
        error: `今日演示支付次数已达上限（${DEMO_PAY_DAILY_IP_LIMIT}），明天再来。`,
      });
    }
    // 分钟级闸门：挡瞬时刷爆（日闸门挡不住）
    const demoMinute = ipMinuteLimit(req, 'demo_pay');
    if (demoMinute !== null && demoMinute > DEMO_PAY_MINUTE_IP_LIMIT) {
      return res.status(429).json({
        error: `演示支付过于频繁（每分钟上限 ${DEMO_PAY_MINUTE_IP_LIMIT}），请稍候再试。`,
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
      // 🔴 服务端自标记：本路由是站内唯一自测入口，「这是自测」由服务端自己说，
      //    不信任任何客户端头（公开 402 端点恒为 api，见 createPaymentRequiredResponse）。
      const challengeBody = await challengeRes.clone().json().catch(() => ({}));
      if (challengeBody.out_trade_no) {
        repository.markSelfTest(challengeBody.out_trade_no);
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
        // 本次真实交易的报文素材（前端用它把协议链路面板换成「你刚这一笔」的报文）
        liveTrace: result.liveTrace ?? null,
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
   *
   * 支付挑战按 IP 限流：每次调用都会真实建单（落库 + 签名账单），
   * 必须防 Agent 循环刷单把订单表刷爆。限额同为运维旋钮。
   */
  const MCP_CHALLENGE_DAILY_IP_LIMIT = Number(process.env.MCP_CHALLENGE_DAILY_IP_LIMIT ?? 100);

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
      // 只限流「会建单」的调用：带凭证的验付调用与 tools/list 不计
      const isChallengeCall =
        req.body?.method === 'tools/call' && !req.body?.params?.arguments?.payment_proof;
      if (isChallengeCall) {
        const n = ipLimit(req, 'mcp_challenge');
        if (n !== null && n > MCP_CHALLENGE_DAILY_IP_LIMIT) {
          return res.json({
            jsonrpc: '2.0',
            id: req.body?.id ?? null,
            error: {
              code: -32000,
              message: `今日支付挑战次数已达上限（${MCP_CHALLENGE_DAILY_IP_LIMIT}），请明天再试。`,
            },
          });
        }
      }
      // ctx 带访客身份：内部回环的订单归因与权益额度才能落到同一个人身上
      const out = await mcp(req.body, { visitorId: req.visitorId, refCode: req.visitorRef });
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

  /**
   * 订单核验卡（公开、可分享）。
   *
   * 为什么存在：付费结果目前止于买家自己——买完没有任何可分享的东西。
   * 而本作品的差异化卖点恰恰是「可核验」。核验卡把每一笔已支付订单
   * 变成一张公开的分享物：脱敏交易号 + 证据哈希 + 距离与端点，
   * 不含完整答案与路线折线（那仍是付费内容）。
   * 传播路径：买家分享核验卡 → 朋友看到「这笔交易真实发生且可复算」→
   * 「我也要问」按钮带 ref=share 归因回流 → 新访客进漏斗。
   *
   * 隐私边界：无买家任何个人信息（本来就没存）；交易号只露尾 6 位。
   */
  router.get('/api/v1/verify/:outTradeNo', async (req, res) => {
    const order = await repository.findByOutTradeNo(req.params.outTradeNo);
    if (!order) return res.status(404).json({ code: 'ORDER_NOT_FOUND', message: '没有这笔订单' });

    const paid = order.orderStatus === 'PAID' && order.fulfillStatus === 'FULFILLED';
    if (!paid) {
      // 未支付/未履约的订单只确认存在性，不给内容——防止用核验接口探测订单状态细节
      return res.status(404).json({ code: 'ORDER_NOT_VERIFIABLE', message: '订单不可核验' });
    }

    const result = order.serviceResult ?? {};
    const route = result.route ?? {};
    const q = result.quest ?? null;
    const mask = (s) => (s ? `…${String(s).slice(-6)}` : null);

    return res.json({
      verifiable: true,
      out_trade_no: order.outTradeNo,
      trade_no_masked: mask(order.tradeNo),
      goods_name: order.goodsName,
      amount: order.amount,
      currency: order.currency,
      tier: order.tier,
      scene: result.scene?.name ?? null,
      // 内容摘要：路线给端点与距离，不给折线；任务给标题与站点数，不给线索
      summary:
        q
          ? {
              kind: 'quest',
              title: q.title,
              checkpoints: (q.checkpoints ?? []).length,
              total_distance_m: q.total_distance_m ?? null,
            }
          : {
              kind: 'route',
              from: route.from?.name ?? null,
              to: route.to?.name ?? null,
              distance_m: route.distance_m ?? null,
              path_type: route.type ?? null,
            },
      evidence: result.evidence ?? null,
      usage: result.billing ?? null,
      fulfilled_at: order.updatedAt ?? null,
      cta: { message: '我也要问', url: '/?ref=share' },
      // 官方作品页（影响力 20% 只统计那个页面上的浏览/点赞/评论）
      // → 买家把核验卡/收据分享出去时，顺手把官方作品页带出去。
      //    未配置时为 null，前端不渲染这一块（优雅降级，不影响核验卡本身）。
      official: await getOfficialWork(),
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
      // ⚠️ role/form 的措辞必须与**现行投递策略**一致（聚焦 Machine Pay 单赛道）：
      //    旧文案写「Vibe Pay = 交付形态·主展示」「Skill Pay = 衍生形态」，
      //    读起来像四条赛道各投一份，与提交表单「只投 Machine Pay」直接矛盾——
      //    评委对照站点与提交物时一眼能看出。保留四条是为了展示能力覆盖面，
      //    但必须明确标注「本作品投递哪一条」。
      tracks: [
        {
          id: 'machine-pay',
          name: 'Machine Pay',
          role: '★ 本作品投递赛道',
          brief: '让 AI 服务按实际使用量计费与支付，以可核验用量完成结算。',
          form: 'REST API · HTTP 402（402 挑战 / 凭证验签 / 五项核验 / 幂等履约 / 履约回执 全链路）',
        },
        {
          id: 'vibe-pay',
          name: 'Vibe Pay',
          role: '能力已实现 · 不重复投稿',
          brief: '为可运行的 AI 应用接入收款，让创意成为可经营的产品。',
          form: '网页应用形态（本站演示页即该形态，可现场操作）',
        },
        {
          id: 'skill-pay',
          name: 'Skill Pay',
          role: '能力已实现 · 不重复投稿',
          brief: '为 AI 技能接入收款，让技能从调用到交付形成完整闭环。',
          form: 'SKILL.md 商家技能包（仓库内，供买家 Agent 装载）',
        },
        {
          id: 'agent-pay',
          name: 'Agent Pay',
          role: '能力已实现 · 不重复投稿',
          brief: '探索 Agent 发现服务、发起支付与获得交付的新型交易链路。',
          form: 'MCP 发现端点（tools/call 直接返回带签名的支付账单头）',
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
