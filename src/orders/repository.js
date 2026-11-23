import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

/**
 * 订单仓储（官方要求的端口实现）。
 *
 * 官方参考实现明确要求：
 *   「必须通过 configureOrderRepository 绑定项目真实持久化实现；
 *     端口未绑定时明确失败，不使用内存订单、固定资源或验付字段缺失兜底。」
 *   「真实实现必须以数据库事务和唯一约束实现以下端口」
 *
 * 因此这里用 SQLite + 唯一约束 + 事务实现，不做内存兜底。
 *
 * 状态机：
 *   order_status  : PENDING_PAYMENT → PAID
 *   fulfill_status: UNFULFILLED → PENDING_CONFIRM → FULFILLED
 *
 * PENDING_CONFIRM 的存在意义：资源已生成但履约回执未确认成功时，
 * 允许携带同一笔 Payment-Proof 重试履约，而不会重复生成资源。
 */
/**
 * 「自测订单」判定（SQL 片段）——「真实付费用户」这个评审数字的诚信根。
 *
 * 两条来源，都不计入真实付费：
 *   ① `source='demo'`：站内演示代付。由服务端自己标记（/api/v1/demo/pay 路由
 *      调用 markSelfTest），**不信任任何客户端头**——旧实现读 `x-sg-demo` 请求头，
 *      任一调用方带头就能把自己的订单从真实付费里抹掉（实测复现）。
 *   ② `visitor_id` 命中验收脚本固定前缀：作者的端到端脚本（verify-mcp-flow /
 *      verify-account-flow）走的是**真实**链路（公开 402 / MCP 支付），
 *      服务端无法从协议层面区分，只能按访客前缀折叠。
 *
 * 🔴 visitor_id 必须套 COALESCE（2026-11-23 测试复现的漏算）：
 *    SQL 是三值逻辑——`NULL LIKE 'mcp-e2e-%'` 得 NULL，`NOT NULL` 还是 NULL，
 *    在 WHERE 里不成立。于是**任何 visitor_id 为 NULL 的订单都会被
 *    `NOT SELF_TEST_SQL` 静默排除**，哪怕它 source='api' 是实打实的外部调用。
 *    这不是理论问题：归因字段是后来加的，旧库迁移上来的历史订单 visitor_id
 *    全是 NULL——升级后这些真实付费订单从 paidReal 里整批消失（实测复现：
 *    4 笔已付只算出 1 笔真实）。
 *    套上 COALESCE(visitor_id,'') 后 NULL 变成空串，LIKE 得 0（假），
 *    对已有访客的订单行为完全不变。
 *
 * 变更历史：2026-11-21 之前只看 source，导致每次跑 MCP 验收都在给
 * 「其中真实」充值——评委看到的真实付费数被作者自己的脚本抬高。
 */
const SELF_TEST_SQL = `(source = 'demo'
       OR COALESCE(visitor_id, '') LIKE 'mcp-e2e-%'
       OR COALESCE(visitor_id, '') LIKE 'acct-%'
       OR COALESCE(visitor_id, '') LIKE 'verify-%'
       OR COALESCE(visitor_id, '') LIKE 'probe-%'
       OR COALESCE(visitor_id, '') LIKE 'story-demo-%')`;

/**
 * 「按时完成」判定：首站到末站的打卡时间差 ≤ 预估用时 × 1.5。
 * 预留 50% 余量——用户要读线索、要操作界面，不能按理想直线时间卡。
 *
 * 放在模块层级并导出：路由层签证书与仓储层落库必须是同一个口径
 * （旧实现两边都无条件发加分，证书恒 150，与耗时无关）。
 */
export function finishedUnderTime(quest) {
  const times = (quest.checkins ?? [])
    .map((c) => Date.parse(c.checked_at ?? c.checkedAt))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  if (times.length < 2) return false;
  const elapsedMin = (times[times.length - 1] - times[0]) / 60000;
  const budgetMin = (quest.estimatedMinutes ?? quest.estimated_minutes ?? 0) * 1.5;
  return budgetMin > 0 && elapsedMin <= budgetMin;
}

/**
 * 任务评分：基础分 + 全部完成 + 按时完成。
 *
 * 🔴 唯一实现（2026-11-23 收敛）：证书分数（routes/guide.js 签证书时用）与
 *    库里的 score（completeQuest 落库时用）必须是同一个数。早期两份实现各写一遍，
 *    改动其中一处就会让「证书显示的分数 ≠ 库里存的分数」——而证书的卖点恰恰是
 *    「可复算核验」，数字对不上比没有加分更伤。现在统一从这里出。
 */
export function computeQuestScore(quest) {
  let score = quest.scoring?.base ?? 100;
  for (const bonus of quest.scoring?.bonuses ?? []) {
    if (bonus.key === 'all_checkpoints') score += bonus.points;
    if (bonus.key === 'under_time' && finishedUnderTime(quest)) score += bonus.points;
  }
  return score;
}

export function createOrderRepository({ file = 'data/orders.db' } = {}) {
  const dbFile = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });

  const db = new Database(dbFile);
  db.pragma('journal_mode = WAL');
  // 🔴 synchronous=FULL：支付系统的订单库不能赌「掉电时丢最近提交」。
  // WAL 默认 NORMAL 只在检查点 fsync，宕机可能丢最后一小段事务——
  // 对「已收款但订单没落库」这类事故来说是灾难性的。FULL 每次提交都 fsync，
  // 代价是吞吐下降，对本项目的量级（一天几百笔）完全无所谓。
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');

  // 启动体检：数据库损坏时大声报出来，而不是等每一笔支付都 500 了才被发现。
  // 2026-11-21 实测过一次本地库损坏（b-tree 页码无效），现象就是
  // 「支付未完成」这种毫无线索的报错——提前一步报告能省几小时排查。
  try {
    const check = db.pragma('quick_check', { simple: true });
    if (check !== 'ok') {
      console.error(
        `\n🔴🔴🔴 [db] orders.db 体检未通过：${check}\n` +
        '   订单库可能已损坏，支付链路会失败。恢复步骤：\n' +
        '   1. 停服务  2. cp data/orders.db data/orders.db.corrupt-$(date +%F)\n' +
        '   3. sqlite3 data/orders.db ".recover" > /tmp/r.sql\n' +
        '   4. sqlite3 data/orders.db.new < /tmp/r.sql && sqlite3 data/orders.db.new "PRAGMA integrity_check;"\n' +
        '   5. 换入新库并重启。日常体检：node scripts/db-check.mjs\n',
      );
    }
  } catch (err) {
    console.error(`🔴 [db] orders.db 体检失败：${err.message}`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      out_trade_no   TEXT PRIMARY KEY,
      amount         TEXT NOT NULL,
      currency       TEXT NOT NULL,
      resource_id    TEXT NOT NULL,
      goods_name     TEXT NOT NULL,
      tier           TEXT NOT NULL,
      pay_before     TEXT NOT NULL,
      order_status   TEXT NOT NULL,
      fulfill_status TEXT NOT NULL,
      trade_no       TEXT,
      service_result TEXT,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS usage_records (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      out_trade_no TEXT NOT NULL,
      meter        TEXT NOT NULL,
      quantity     REAL NOT NULL,
      unit         TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      FOREIGN KEY (out_trade_no) REFERENCES orders(out_trade_no)
    );

    CREATE INDEX IF NOT EXISTS idx_usage_trade ON usage_records(out_trade_no);

    -- 场景任务：任务本身 + 逐站打卡记录
    CREATE TABLE IF NOT EXISTS quests (
      id                TEXT PRIMARY KEY,
      out_trade_no      TEXT,
      scene_id          TEXT NOT NULL,
      title             TEXT,
      level             TEXT,
      brief             TEXT,
      total_distance_m  INTEGER,
      estimated_minutes INTEGER,
      checkpoints       TEXT NOT NULL,
      clues             TEXT NOT NULL,
      legs              TEXT NOT NULL,
      scoring           TEXT NOT NULL,
      status            TEXT NOT NULL,
      score             INTEGER,
      certificate       TEXT,
      created_at        TEXT NOT NULL,
      completed_at      TEXT
    );

    CREATE TABLE IF NOT EXISTS quest_checkins (
      quest_id    TEXT NOT NULL,
      point_id    TEXT NOT NULL,
      point_name  TEXT,
      seq         INTEGER NOT NULL,
      checked_at  TEXT NOT NULL,
      PRIMARY KEY (quest_id, point_id),
      FOREIGN KEY (quest_id) REFERENCES quests(id)
    );

    CREATE INDEX IF NOT EXISTS idx_quests_trade ON quests(out_trade_no);

    -- 权益额度台账：多额度商品（如「十次导览包」）付清后到账的次数余额。
    -- 每次交付扣 1 次，余额耗尽自动回到 402 支付挑战。
    -- out_trade_no 唯一 —— 同一笔订单只发放一次（幂等，重试不会重复发额度）。
    CREATE TABLE IF NOT EXISTS entitlements (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      visitor_id   TEXT NOT NULL,
      tier         TEXT NOT NULL,
      out_trade_no TEXT NOT NULL UNIQUE,
      quota        INTEGER NOT NULL,
      used         INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL,
      expires_at   TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_ent_visitor ON entitlements(visitor_id);

    -- 礼品码：已购额度可转赠（家长买「十次包」→ 把其中几次送给同学/社团）。
    -- 生成时从赠予者额度扣 1 次；兑换时给接收方发 1 次额度，
    -- 发放用的 out_trade_no = GIFT_<code> 走 entitlements 唯一约束，天然幂等。
    CREATE TABLE IF NOT EXISTS gift_codes (
      code         TEXT PRIMARY KEY,
      from_visitor TEXT NOT NULL,
      tier         TEXT NOT NULL DEFAULT 'single',
      quota        INTEGER NOT NULL DEFAULT 1,
      status       TEXT NOT NULL DEFAULT 'ACTIVE',
      redeemed_by  TEXT,
      redeemed_at  TEXT,
      created_at   TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_gifts_from ON gift_codes(from_visitor);

    -- 售后工单：退款申请与处理留痕。
    -- 沙箱环境无法调用真实退款接口（实测 alipay.trade.refund → 40004 Business Failed），
    -- 因此这里的「退款」= 权益即时回收 + 工单记录 + 订单标注；
    -- 生产环境切真实 service_id 后，由商家在支付宝后台完成资金原路退回。
    CREATE TABLE IF NOT EXISTS refund_tickets (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      out_trade_no TEXT NOT NULL,
      visitor_id   TEXT NOT NULL,
      amount       TEXT NOT NULL,
      reason       TEXT,
      status       TEXT NOT NULL DEFAULT 'ACCEPTED',
      created_at   TEXT NOT NULL
    );
  `);

  // 增长归因：订单关联访客与来源（demo=演示代付自测 / api=外部真实调用）。
  // SQLite 的 ALTER TABLE 无 IF NOT EXISTS，用建表后的防御性迁移。
  for (const col of ['visitor_id TEXT', 'ref_code TEXT', "source TEXT NOT NULL DEFAULT 'api'"]) {
    try {
      db.exec(`ALTER TABLE orders ADD COLUMN ${col}`);
    } catch {
      /* 列已存在 */
    }
  }
  // 售后：退款状态（NONE / REFUNDED）。同样走防御性迁移。
  for (const col of [
    "refund_status TEXT NOT NULL DEFAULT 'NONE'",
    'refunded_at TEXT',
    'refund_reason TEXT',
  ]) {
    try {
      db.exec(`ALTER TABLE orders ADD COLUMN ${col}`);
    } catch {
      /* 列已存在 */
    }
  }

  const now = () => new Date().toISOString();

  /**
   * 本进程「正在生成资源」的订单 → 在途任务。
   *
   * 为什么需要它：数据库里的 PENDING_CONFIRM + 无 service_result 有两种含义——
   *   ① 上一个进程在「抢占之后、落库之前」崩了（真孤儿，该释放重抢）；
   *   ② 同一进程里另一个请求正在生成（在途，该等待复用）。
   *   只看数据库分不清这两者。没有这张表，② 会被当成 ① 处理：
   *   并发重复 Payment-Proof 会各自释放再抢回抢占权，生成 N 份资源、
   *   各拿到不同内容——「幂等履约」名存实亡（2026-11-23 并发测试复现）。
   */
  const generating = new Map();

  /** 落库是 JSON 字符串，出库统一还原为对象 */
  const parseServiceResult = (raw) => {
    if (raw === null || raw === undefined) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  };

  /**
   * 订单行 → 对外对象（驼峰）。
   *
   * 🔴 必须是**同步**的行映射（2026-11-23 测试复现的缺陷）：
   *    `findByTradeNo` 声明为同步方法，早期实现里它委托 async 的
   *    `findByOutTradeNo`，于是返回的是一个 Promise。而 routes/guide.js 的
   *    幂等重放短回路是**不 await** 地用它的——`existing.orderStatus` 取到的是
   *    undefined，短回路条件恒为 false，整段「本地记录直接交付」的逻辑变成死代码。
   *    后果（实测）：① 每次合法重放都再打一次远程验付（沙箱偶发非标准响应，
   *    抖动直接被放大成用户可见的失败）；② 多额度买家每重放一次就被
   *    grantEntitlementForOrder 多扣 1 次额度（买 10 次送 3 次重放 = 只剩 6 次）。
   *    现在映射逻辑抽成同步函数，两个查询方法共用，字段口径保持一致。
   */
  const mapOrderRow = (row) => ({
    outTradeNo: row.out_trade_no,
    amount: row.amount,
    currency: row.currency,
    resourceId: row.resource_id,
    goodsName: row.goods_name,
    tier: row.tier,
    payBefore: row.pay_before,
    orderStatus: row.order_status,
    fulfillStatus: row.fulfill_status,
    tradeNo: row.trade_no,
    visitorId: row.visitor_id,
    refCode: row.ref_code,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // 落库存 JSON 字符串，出库统一还原为对象，保证调用方拿到的类型恒定
    serviceResult: parseServiceResult(row.service_result),
  });

  const insertOrder = db.prepare(`
    INSERT INTO orders (
      out_trade_no, amount, currency, resource_id, goods_name, tier,
      pay_before, order_status, fulfill_status, source, created_at, updated_at
    ) VALUES (
      @outTradeNo, @amount, @currency, @resourceId, @goodsName, @tier,
      @payBefore, 'PENDING_PAYMENT', 'UNFULFILLED', @source, @createdAt, @updatedAt
    )
  `);

  const selectOrder = db.prepare('SELECT * FROM orders WHERE out_trade_no = ?');
  const selectOrderByTradeNo = db.prepare('SELECT * FROM orders WHERE trade_no = ?');

  const claimFulfillment = db.prepare(`
    UPDATE orders
       SET fulfill_status = 'PENDING_CONFIRM', updated_at = ?
     WHERE out_trade_no = ? AND fulfill_status = 'UNFULFILLED'
  `);

  const releaseFulfillment = db.prepare(`
    UPDATE orders
       SET fulfill_status = 'UNFULFILLED', updated_at = ?
     WHERE out_trade_no = ? AND fulfill_status = 'PENDING_CONFIRM'
  `);

  const storeServiceResult = db.prepare(`
    UPDATE orders
       SET service_result = @serviceResult, updated_at = @updatedAt
     WHERE out_trade_no = @outTradeNo
  `);

  const markFulfilled = db.prepare(`
    UPDATE orders
       SET fulfill_status = 'FULFILLED', order_status = 'PAID',
           trade_no = @tradeNo, updated_at = @updatedAt
     WHERE out_trade_no = @outTradeNo
  `);

  const insertUsage = db.prepare(`
    INSERT INTO usage_records (out_trade_no, meter, quantity, unit, created_at)
    VALUES (@outTradeNo, @meter, @quantity, @unit, @createdAt)
  `);

  /* ────────────── 权益额度台账 ────────────── */

  // 同一笔订单只发一次额度：ON CONFLICT DO NOTHING 保证重试幂等
  const grantEntitlementStmt = db.prepare(`
    INSERT INTO entitlements (visitor_id, tier, out_trade_no, quota, used, created_at, expires_at)
    VALUES (@visitorId, @tier, @outTradeNo, @quota, 0, @createdAt, @expiresAt)
    ON CONFLICT(out_trade_no) DO NOTHING
  `);

  // 扣减：条件里的 used < quota 让 UPDATE 本身成为原子操作，并发不会超扣
  const consumeEntitlementStmt = db.prepare(`
    UPDATE entitlements SET used = used + 1 WHERE id = @id AND used < quota
  `);

  // 归还：资源生成失败时把刚扣掉的那次还回去
  const refundEntitlementStmt = db.prepare(`
    UPDATE entitlements SET used = used - 1 WHERE id = @id AND used > 0
  `);

  const selectEntitlementsStmt = db.prepare(
    'SELECT * FROM entitlements WHERE visitor_id = ? ORDER BY created_at, id',
  );

  return {
    /** 创建待支付订单。out_trade_no 唯一约束保证幂等。 */
    async createPending(order) {
      insertOrder.run({
        outTradeNo: order.outTradeNo,
        amount: order.amount,
        currency: order.currency,
        resourceId: order.resourceId,
        goodsName: order.goodsName,
        tier: order.tier,
        payBefore: order.payBefore,
        source: order.source ?? 'api',
        createdAt: now(),
        updatedAt: now(),
      });
      return this.findByOutTradeNo(order.outTradeNo);
    },

    async findByOutTradeNo(outTradeNo) {
      const row = selectOrder.get(outTradeNo);
      if (!row) return null;
      return mapOrderRow(row);
    },

    /**
     * 原子地「抢占」履约权并生成资源。
     *
     * - 只有把 fulfill_status 从 UNFULFILLED 改写为 PENDING_CONFIRM 成功的那次调用才生成资源，
     *   因此并发重试不会重复生成（幂等）。
     * - 资源生成失败时回退为 UNFULFILLED，允许后续重试。
     * - 已经是 PENDING_CONFIRM / FULFILLED 的订单直接返回已持久化的结果。
     */
    async prepareFulfillment({ outTradeNo, tradeNo, expectedAmount, expectedResourceId, createResource }) {
      const order = await this.findByOutTradeNo(outTradeNo);
      if (!order) throw new Error(`ORDER_NOT_FOUND: ${outTradeNo}`);
      if (order.amount !== expectedAmount) throw new Error(`AMOUNT_MISMATCH: ${outTradeNo}`);
      if (order.resourceId !== expectedResourceId) throw new Error(`RESOURCE_ID_MISMATCH: ${outTradeNo}`);

      if (order.fulfillStatus === 'FULFILLED' && order.serviceResult) {
        return { state: 'FULFILLED', serviceResult: order.serviceResult };
      }

      if (order.fulfillStatus === 'PENDING_CONFIRM' && order.serviceResult) {
        return { state: 'PENDING_CONFIRM', serviceResult: order.serviceResult };
      }

      let claimed = claimFulfillment.run(now(), outTradeNo).changes > 0;
      if (!claimed) {
        // 🔴 同进程已有人在这笔订单上生成 → 直接复用它的在途任务，
        //    不要走下面的「崩溃孤儿」分支（2026-11-23 并发测试复现的缺陷）。
        //    孤儿判定只看数据库状态，分不清「上一个进程崩了」和「隔壁请求
        //    还在生成」——旧实现在这里把在途抢占权释放掉再抢回来，
        //    并发下 N 个重复 Payment-Proof 会生成 N 次资源，
        //    且每个调用方各拿到**不同**的交付内容（幂等履约被打破）。
        const inflight = generating.get(outTradeNo);
        if (inflight) return inflight;

        const current = await this.findByOutTradeNo(outTradeNo);
        if (current?.serviceResult) {
          return { state: current.fulfillStatus, serviceResult: current.serviceResult };
        }
        // 🔴 崩溃恢复（2026-11-23 遍历审查发现）：PENDING_CONFIRM 但资源未持久化 =
        //    孤儿状态——进程在「抢占之后、资源落库之前」崩溃（2026-11-22 部署事故的
        //    崩溃循环正好会制造这种订单）。不处理的话该订单**永久砖死**：
        //    重抢条件只匹配 UNFULFILLED（必然失败），又没有结果可返回，
        //    之后每一次重试都抛 FULFILLMENT_CLAIM_FAILED。释放孤儿状态后重抢。
        //    能走到这里说明 generating 里没有在途任务，才可能是真孤儿。
        if (current?.fulfillStatus === 'PENDING_CONFIRM') {
          releaseFulfillment.run(now(), outTradeNo);
          claimed = claimFulfillment.run(now(), outTradeNo).changes > 0;
        }
        if (!claimed) {
          throw new Error(`FULFILLMENT_CLAIM_FAILED: ${outTradeNo}`);
        }
      }

      // 抢占成功 → 登记在途任务。整段「抢占 + 登记」之间没有 await，
      // 因此对同一进程内的其它调用是原子的：后来者只会在 claimFulfillment
      // 失败后看到这个登记项，进而复用它。
      const task = (async () => {
        let generated;
        try {
          generated = await createResource();
        } catch (err) {
          releaseFulfillment.run(now(), outTradeNo);
          throw err;
        }

        const serviceResult = JSON.stringify(generated.serviceResult);
        const usage = generated.usage ?? [];

        const persist = db.transaction(() => {
          storeServiceResult.run({ outTradeNo, serviceResult, updatedAt: now() });
          this.recordUsage({ outTradeNo, usage });
        });
        persist();

        return { state: 'PENDING_CONFIRM', serviceResult: generated.serviceResult };
      })();
      generating.set(outTradeNo, task);
      try {
        return await task;
      } finally {
        generating.delete(outTradeNo);
      }
    },

    /** 履约回执成功后标记完成。 */
    async markFulfilled(outTradeNo, tradeNo) {
      markFulfilled.run({ outTradeNo, tradeNo, updatedAt: now() });
      return this.findByOutTradeNo(outTradeNo);
    },

    /** 订单归因：记录来源访客与渠道（幂等覆盖） */
    attributeOrder(outTradeNo, { visitorId, refCode }) {
      db.prepare('UPDATE orders SET visitor_id = ?, ref_code = ? WHERE out_trade_no = ?').run(
        visitorId,
        refCode,
        outTradeNo,
      );
    },

    /**
     * 把订单标记为服务端自测（source='demo'）。
     *
     * 为什么由路由调用而不是读客户端头：公开 402 端点恒为 'api'，
     * 「这是自测」只能由服务端自己知道——/api/v1/demo/pay 是站内唯一
     * 的自测入口，它在拿到挑战后调用本方法。旧实现信任 `x-sg-demo` 头，
     * 任一调用方带头就能把自己的订单从「真实付费用户」里抹掉（实测复现）。
     */
    markSelfTest(outTradeNo) {
      db.prepare("UPDATE orders SET source = 'demo' WHERE out_trade_no = ?").run(outTradeNo);
    },

    /**
     * 按交易号查订单（幂等重放走本地记录的短回路；字段口径与 findByOutTradeNo 一致）。
     *
     * 🔴 同步方法，**不得**委托 async 的 findByOutTradeNo（2026-11-23 修复）：
     *    调用方 routes/guide.js 的短回路不 await 它，返回 Promise 会让
     *    `existing.orderStatus === 'PAID'` 恒为 false、整段重放保护失效，
     *    进而造成「多额度买家每重放一次多扣 1 次额度」的真实资损。
     */
    findByTradeNo(tradeNo) {
      if (!tradeNo) return null;
      const row = selectOrderByTradeNo.get(tradeNo);
      return row ? mapOrderRow(row) : null;
    },

    /* ────────────── 权益额度台账 ────────────── */

    /**
     * 发放权益额度（幂等）。
     * 同一笔订单重复履约（例如重试同一笔 Payment-Proof）不会重复发放。
     */
    grantEntitlement({ visitorId, tier, outTradeNo, quota, validDays = 90 }) {
      if (!visitorId) return null;
      const total = Number(quota ?? 0);
      if (!Number.isFinite(total) || total <= 1) return null; // 单次商品不需要额度台账

      const expiresAt = new Date(Date.now() + validDays * 86400_000).toISOString();
      grantEntitlementStmt.run({
        visitorId,
        tier,
        outTradeNo,
        quota: total,
        createdAt: now(),
        expiresAt,
      });
      const row = db.prepare('SELECT * FROM entitlements WHERE out_trade_no = ?').get(outTradeNo);
      if (!row) return null;
      return {
        id: row.id,
        visitorId: row.visitor_id,
        tier: row.tier,
        outTradeNo: row.out_trade_no,
        quota: row.quota,
        used: row.used,
        remaining: row.quota - row.used,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
      };
    },

    /**
     * 扣减一次额度（FIFO：先用最早到账的那笔）。
     * 没有可用额度时返回 null —— 调用方据此回到 402 支付挑战。
     */
    consumeEntitlement(visitorId) {
      if (!visitorId) return null;
      for (const row of selectEntitlementsStmt.all(visitorId)) {
        if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) continue;
        if (row.used >= row.quota) continue;
        // 条件更新是原子的：并发下第二次可能 changes=0，此时继续找下一笔
        const changed = consumeEntitlementStmt.run({ id: row.id }).changes;
        if (changed > 0) {
          return {
            id: row.id,
            tier: row.tier,
            outTradeNo: row.out_trade_no,
            quota: row.quota,
            used: row.used + 1,
            remaining: row.quota - row.used - 1,
            expiresAt: row.expires_at,
          };
        }
      }
      return null;
    },

    /** 归还一次额度（资源生成失败时回滚） */
    refundEntitlement(id) {
      if (!id) return;
      refundEntitlementStmt.run({ id });
    },

    /** 访客的额度余额（看板与前端展示用）。
     *  🔴 过期台账不进余额合计（2026-11-23 遍历审查发现）：消费路径
     *     `consumeEntitlement` 会跳过过期台账，但旧实现的 granted/used/remaining
     *     把过期行也加进去——用户「看着有余额却花不了」（两边口径不一致，实测复现）。
     *     过期行仍在 entitlements 数组里逐条展示（带 expired 标记），只是不计入合计。 */
    entitlementBalance(visitorId) {
      const empty = { granted: 0, used: 0, remaining: 0, entitlements: [] };
      if (!visitorId) return empty;
      const rows = selectEntitlementsStmt.all(visitorId);
      const nowMs = Date.now();
      const entitlements = rows.map((row) => ({
        id: row.id,
        tier: row.tier,
        quota: row.quota,
        used: row.used,
        remaining: Math.max(0, row.quota - row.used),
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        expired: row.expires_at ? Date.parse(row.expires_at) <= nowMs : false,
      }));
      const activeRows = entitlements.filter((e) => !e.expired);
      const granted = activeRows.reduce((s, e) => s + e.quota, 0);
      const used = activeRows.reduce((s, e) => s + e.used, 0);
      return { granted, used, remaining: Math.max(0, granted - used), entitlements };
    },

    /**
     * 订单侧近 7 天汇总（周维度，呼应官方热度榜的周榜节奏）。
     * 与 orderStatsByVisitor 的区别：不带归因维度，只看时间窗。
     *
     * 🔴 paid / paid_real 是**去重访客数**（2026-11-23 修正，与 funnel 口径对齐）：
     *    旧实现是订单数（COUNT(*)），而前端把 w.paid 与 w.visitors（新访客数）
     *    并列展示，一个买家下 3 单就会出现「3 付费 / 2 新访客」的倒挂。
     *    revenue 仍是订单金额合计——钱不能按人去重。
     */
    orderStatsWeekly() {
      const since = new Date(Date.now() - 7 * 86400_000).toISOString();
      return db
        .prepare(`
          SELECT COUNT(DISTINCT visitor_id) AS paid,
                 COUNT(DISTINCT CASE WHEN NOT ${SELF_TEST_SQL} THEN visitor_id END) AS paid_real,
                 CAST(SUM(CASE WHEN refund_status != 'REFUNDED'
                               THEN CAST(amount AS REAL) ELSE 0 END) AS REAL) AS revenue
          FROM orders
          WHERE order_status = 'PAID' AND created_at >= ?
        `)
        .get(since);
    },

    /**
     * 订单侧漏斗预聚合（按访客）。
     * 供 analytics.funnel() 消费 —— SQLite 不能跨库 JOIN，两边各自聚合后 JS 合并。
     */
    orderStatsByVisitor() {
      return db
        .prepare(`
          SELECT visitor_id,
                 COUNT(*) AS challenges,
                 SUM(CASE WHEN order_status = 'PAID' THEN 1 ELSE 0 END) AS paid,
                 SUM(CASE WHEN order_status = 'PAID' AND refund_status != 'REFUNDED'
                          THEN CAST(amount AS REAL) ELSE 0 END) AS revenue,
                 SUM(CASE WHEN order_status = 'PAID' AND ${SELF_TEST_SQL} THEN 1 ELSE 0 END) AS paid_selftest,
                 SUM(CASE WHEN order_status = 'PAID' AND NOT ${SELF_TEST_SQL} THEN 1 ELSE 0 END) AS paid_real
          FROM orders
          WHERE visitor_id IS NOT NULL
          GROUP BY visitor_id
        `)
        .all();
    },

    /* ────────────── 场景任务与打卡 ────────────── */

    /** 任务落库（支付履约时创建） */
    createQuest(quest) {
      const stmt = db.prepare(`
        INSERT INTO quests (
          id, out_trade_no, scene_id, title, level, brief,
          total_distance_m, estimated_minutes, checkpoints, clues, legs, scoring,
          status, created_at
        ) VALUES (
          @id, @outTradeNo, @sceneId, @title, @level, @brief,
          @totalDistanceM, @estimatedMinutes, @checkpoints, @clues, @legs, @scoring,
          'IN_PROGRESS', @createdAt
        )
      `);
      stmt.run({
        id: quest.id,
        outTradeNo: quest.outTradeNo ?? null,
        sceneId: quest.sceneId,
        title: quest.title,
        level: quest.level,
        brief: quest.brief,
        totalDistanceM: quest.totalDistanceM,
        estimatedMinutes: quest.estimatedMinutes,
        checkpoints: JSON.stringify(quest.checkpoints),
        clues: JSON.stringify(quest.clues),
        legs: JSON.stringify(quest.legs),
        scoring: JSON.stringify(quest.scoring),
        createdAt: now(),
      });
      return this.findQuest(quest.id);
    },

    findQuest(questId) {
      const row = db.prepare('SELECT * FROM quests WHERE id = ?').get(questId);
      if (!row) return null;
      const checkins = db
        .prepare('SELECT point_id, point_name, seq, checked_at FROM quest_checkins WHERE quest_id = ? ORDER BY seq')
        .all(questId);
      return {
        id: row.id,
        outTradeNo: row.out_trade_no,
        sceneId: row.scene_id,
        title: row.title,
        level: row.level,
        brief: row.brief,
        totalDistanceM: row.total_distance_m,
        estimatedMinutes: row.estimated_minutes,
        checkpoints: JSON.parse(row.checkpoints),
        clues: JSON.parse(row.clues),
        legs: JSON.parse(row.legs),
        scoring: JSON.parse(row.scoring),
        status: row.status,
        score: row.score,
        certificate: row.certificate ? JSON.parse(row.certificate) : null,
        checkins,
        createdAt: row.created_at,
        completedAt: row.completed_at,
      };
    },

    /** 打卡：必须按线索链顺序，重复打卡会被拒绝 */
    checkin(questId, pointId) {
      const quest = this.findQuest(questId);
      if (!quest) return { ok: false, code: 'QUEST_NOT_FOUND' };
      if (quest.status === 'COMPLETED') return { ok: false, code: 'QUEST_ALREADY_COMPLETED' };

      const existing = quest.checkins.find((c) => c.point_id === pointId);
      if (existing) return { ok: false, code: 'ALREADY_CHECKED_IN', quest };

      const target = quest.checkpoints.find((c) => c.id === pointId);
      if (!target) return { ok: false, code: 'UNKNOWN_POINT', quest };

      const expectedSeq = quest.checkins.length;
      const targetSeq = quest.checkpoints.findIndex((c) => c.id === pointId);
      if (targetSeq !== expectedSeq) {
        return { ok: false, code: 'OUT_OF_ORDER', expectedSeq, quest };
      }

      db.prepare(
        'INSERT INTO quest_checkins (quest_id, point_id, point_name, seq, checked_at) VALUES (?, ?, ?, ?, ?)',
      ).run(questId, pointId, target.name, expectedSeq, now());

      return { ok: true, quest: this.findQuest(questId) };
    },

    /** 全部打卡完成 → 计算评分并颁发证书（此时才生成可核验哈希） */
    completeQuest(questId, certificate) {
      const quest = this.findQuest(questId);
      if (!quest) return null;
      if (quest.status === 'COMPLETED') return quest;

      const done = quest.checkins.length === quest.checkpoints.length;
      if (!done) return quest;

      // 🔴 「按时完成」必须真的看时间：旧实现对 under_time 只检查
      //    estimatedMinutes > 0 就无条件发加分——证书分数恒为 150，
      //    与用户实际耗时无关，评委核验证书时会发现这个奖励从未被验证（实测复现）。
      //    口径：首站到末站的打卡时间差 ≤ 预估用时 × 1.5（留 50% 余量给看线索的时间）。
      //    分数走唯一的 computeQuestScore，与证书里的分数同源。
      const score = computeQuestScore(quest);

      db.prepare(
        `UPDATE quests SET status = 'COMPLETED', score = ?, certificate = ?, completed_at = ? WHERE id = ?`,
      ).run(score, JSON.stringify(certificate), now(), questId);

      return this.findQuest(questId);
    },

    /** 用量明细（自建计量层的数据源） */
    listUsage(outTradeNo) {
      return db
        .prepare('SELECT meter, quantity, unit FROM usage_records WHERE out_trade_no = ?')
        .all(outTradeNo);
    },

    /** 订单概览看板（/api/v1/stats 与 /api/v1/meta 的「商业化表现」证据面板）
     *  🔴 收入必须排除已退款订单：旧实现退款后收入数字不动，评委核对
     *  「退款后收入是否变化」会发现对不上（实测复现）。
     *  🔴 paid_real 与漏斗/周报同口径（SELF_TEST_SQL），三个并列数字必须自洽。 */
    stats() {
      const orders = db.prepare('SELECT COUNT(*) AS n FROM orders').get();
      const paid = db
        .prepare("SELECT COUNT(*) AS n FROM orders WHERE order_status = 'PAID'")
        .get();
      const revenue = db
        .prepare(
          "SELECT COALESCE(SUM(CAST(amount AS REAL)), 0) AS total FROM orders" +
            " WHERE order_status = 'PAID' AND refund_status != 'REFUNDED'",
        )
        .get();
      const paidReal = db
        .prepare(
          `SELECT COUNT(*) AS n FROM orders WHERE order_status = 'PAID' AND NOT ${SELF_TEST_SQL}`,
        )
        .get();
      const usage = db
        .prepare('SELECT meter, SUM(quantity) AS total FROM usage_records GROUP BY meter')
        .all();
      return {
        orders: orders.n,
        paid: paid.n,
        paidReal: paidReal.n,
        // 金额统一在服务端收敛到两位小数：SQLite 的 SUM(CAST(amount AS REAL))
        // 会带出 0.8300000000000001 这类浮点尾巴，页面与 API 消费者都不该拿到它。
        revenueCny: Math.round(Number(revenue.total || 0) * 100) / 100,
        usage,
      };
    },

    /** 库体检（/healthz 与 scripts/db-check.mjs 用）：返回 'ok' 或损坏描述 */
    quickCheck() {
      return db.pragma('quick_check', { simple: true });
    },

    /**
     * 落一条用量记录（付费履约与权益额度交付两条路径共用）。
     *
     * 🔴 权益路径也必须调它：旧实现只有 prepareFulfillment 写 usage_records，
     *    买包用户用余额的每一次调用都不进计量看板——pack10 用掉 9 次，
     *    看板上这 9 次「不存在」（实测复现，看板系统性少算）。
     *
     * 宽容处理：`usage_records.out_trade_no` 有指向 orders 的外键，而**礼品码
     * 兑换出来的权益**其 out_trade_no 是 `GIFT_<code>`（不是真实订单行）——
     * 硬插会 FOREIGN KEY 失败，把一次正常交付打成 500（实测复现）。
     * 因此引用的订单不存在时跳过计量并告警，绝不能让记账问题影响交付。
     */
    recordUsage({ outTradeNo, usage }) {
      if (!(usage ?? []).length) return 0;
      const orderExists = db
        .prepare('SELECT 1 AS x FROM orders WHERE out_trade_no = ?')
        .get(outTradeNo);
      if (!orderExists) {
        console.warn(
          `[metering] 跳过用量记录：${outTradeNo} 不是订单行` +
            '（礼品码兑换的权益不走订单计量，属已知口径）',
        );
        return 0;
      }
      for (const item of usage) {
        insertUsage.run({
          outTradeNo,
          meter: item.meter,
          quantity: item.quantity,
          unit: item.unit,
          createdAt: now(),
        });
      }
      return usage.length;
    },

    /** 供增长漏斗做 JOIN 查询（analytics.funnel(ordersDb)） */
    getDb() {
      return db;
    },

    /* ────────────── 买家账户中心 ────────────── */

    /**
     * 我的订单（按访客）。
     * 只返回摘要：不含完整交付内容（那仍是付费内容本身，核验走 /api/v1/verify）。
     */
    listOrdersByVisitor(visitorId, limit = 50) {
      if (!visitorId) return [];
      return db
        .prepare(`
          SELECT out_trade_no, amount, currency, goods_name, tier,
                 order_status, fulfill_status, refund_status, refunded_at, refund_reason,
                 trade_no, source, created_at
          FROM orders
          WHERE visitor_id = ?
          ORDER BY created_at DESC
          LIMIT ?
        `)
        .all(visitorId, limit)
        .map((row) => ({
          outTradeNo: row.out_trade_no,
          amount: row.amount,
          currency: row.currency,
          goodsName: row.goods_name,
          tier: row.tier,
          orderStatus: row.order_status,
          fulfillStatus: row.fulfill_status,
          refundStatus: row.refund_status ?? 'NONE',
          refundedAt: row.refunded_at,
          refundReason: row.refund_reason,
          tradeNo: row.trade_no,
          source: row.source ?? 'api',
          createdAt: row.created_at,
        }));
    },

    /**
     * 申请退款（沙箱口径：权益回收 + 工单留痕 + 订单标注）。
     *
     * 业务规则（都写在明处，避免「假装能退真钱」）：
     *   - 只有已支付且已履约的订单可退；
     *   - 12 个月内（支付宝官方退款时效口径）；
     *   - 每笔订单只能退一次；每位访客每天最多 3 笔（防刷）；
     *   - 权益回收：该交付消耗的 1 次还回访客余额（FIFO 的逆操作——
     *     找最早一条还有「已用」记录的未过期台账还 1 次）；
     *   - 整包退款：退「十次包」这类发放源订单时，收回该台账的**剩余**次数
     *     （历史已消耗的不追回——内容已交付，防白嫖）；
     *   - 资金原路退回需生产环境 service_id：沙箱里资金是 mock，
     *     本动作只做权益与标注（前端有对应诚实说明）。
     */
    refundOrder({ outTradeNo, visitorId, reason }) {
      const order = db
        .prepare('SELECT * FROM orders WHERE out_trade_no = ?')
        .get(outTradeNo);
      if (!order) return { ok: false, code: 'ORDER_NOT_FOUND' };
      if (order.visitor_id && visitorId && order.visitor_id !== visitorId) {
        return { ok: false, code: 'NOT_YOUR_ORDER' };
      }
      if (order.order_status !== 'PAID' || order.fulfill_status !== 'FULFILLED') {
        return { ok: false, code: 'NOT_REFUNDABLE_STATE' };
      }
      if ((order.refund_status ?? 'NONE') === 'REFUNDED') {
        return { ok: false, code: 'ALREADY_REFUNDED' };
      }
      const ageMs = Date.now() - Date.parse(order.created_at);
      if (ageMs > 365 * 86400_000) {
        return { ok: false, code: 'REFUND_WINDOW_EXPIRED' };
      }
      const today = new Date().toISOString().slice(0, 10);
      const todayCount = db
        .prepare(
          "SELECT COUNT(*) AS n FROM refund_tickets WHERE visitor_id = ? AND substr(created_at, 1, 10) = ?",
        )
        .get(visitorId, today).n;
      if (todayCount >= 3) return { ok: false, code: 'REFUND_DAILY_LIMIT' };

      const tx = db.transaction(() => {
        db.prepare(
          "UPDATE orders SET refund_status = 'REFUNDED', refunded_at = ?, refund_reason = ? WHERE out_trade_no = ?",
        ).run(now(), reason ?? null, outTradeNo);

        // 整包退款：该订单自己就是额度发放源 → 收回剩余次数
        const ownLedger = db
          .prepare('SELECT * FROM entitlements WHERE out_trade_no = ?')
          .get(outTradeNo);
        if (ownLedger) {
          db.prepare('UPDATE entitlements SET quota = used WHERE id = ?').run(ownLedger.id);
        }
        // 🔴 其他档位（single/trial/quest）**不动任何台账**（2026-11-23 遍历审查修正）：
        //    单次直付订单的交付根本没走权益台账（quota≤1 不发台账）——旧实现在这里
        //    「找最早一条 used>0 的台账还 1 次」，等于给恰好持有十次包的退款访客
        //    白送一次额度（实测路径推演复现）。台账只该在「额度真的被这笔订单
        //    消耗过」时才回补，而这样的订单只有整包自己（上面 ownLedger 分支）。

        db.prepare(
          'INSERT INTO refund_tickets (out_trade_no, visitor_id, amount, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(outTradeNo, visitorId, order.amount, reason ?? null, 'ACCEPTED', now());
      });
      tx();
      return { ok: true, outTradeNo, amount: order.amount };
    },

    /* ────────────── 礼品码（额度转赠） ────────────── */

    /** 生成礼品码：从赠予者当前额度扣 1 次（FIFO），码未兑换前可撤销 */
    createGiftCode({ visitorId, tier = 'single' }) {
      if (!visitorId) return { ok: false, code: 'NO_VISITOR' };
      const consumed = this.consumeEntitlement(visitorId);
      if (!consumed) return { ok: false, code: 'NO_ENTITLEMENT' };
      const code = `GIFT-${crypto.randomBytes(6).toString('hex').toUpperCase().slice(0, 10)}`;
      db.prepare(
        'INSERT INTO gift_codes (code, from_visitor, tier, quota, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(code, visitorId, tier, 1, 'ACTIVE', now());
      return { ok: true, code, quota: 1, remaining: consumed.remaining };
    },

    /** 兑换礼品码：给接收方发 1 次额度（out_trade_no=GIFT_<code> 唯一约束保证幂等） */
    redeemGiftCode({ code, visitorId }) {
      if (!visitorId) return { ok: false, code: 'NO_VISITOR' };
      const normalized = String(code ?? '').trim().toUpperCase();
      const row = db.prepare('SELECT * FROM gift_codes WHERE code = ?').get(normalized);
      if (!row) return { ok: false, code: 'GIFT_NOT_FOUND' };
      if (row.status !== 'ACTIVE') return { ok: false, code: 'GIFT_NOT_ACTIVE' };
      if (row.from_visitor === visitorId) return { ok: false, code: 'GIFT_SELF_REDEEM' };

      const expiresAt = new Date(Date.now() + 90 * 86400_000).toISOString();
      const tx = db.transaction(() => {
        db.prepare(
          "UPDATE gift_codes SET status = 'REDEEMED', redeemed_by = ?, redeemed_at = ? WHERE code = ?",
        ).run(visitorId, now(), normalized);
        db.prepare(
          'INSERT OR IGNORE INTO entitlements (visitor_id, tier, out_trade_no, quota, used, created_at, expires_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
        ).run(visitorId, row.tier, `GIFT_${normalized}`, row.quota, now(), expiresAt);
      });
      tx();
      return { ok: true, code: normalized, quota: row.quota };
    },

    /** 撤销未兑换的礼品码：额度还给赠予者 */
    revokeGiftCode({ code, visitorId }) {
      const normalized = String(code ?? '').trim().toUpperCase();
      const row = db.prepare('SELECT * FROM gift_codes WHERE code = ?').get(normalized);
      if (!row) return { ok: false, code: 'GIFT_NOT_FOUND' };
      if (row.from_visitor !== visitorId) return { ok: false, code: 'NOT_YOUR_GIFT' };
      if (row.status !== 'ACTIVE') return { ok: false, code: 'GIFT_NOT_ACTIVE' };

      const expiresAt = new Date(Date.now() + 90 * 86400_000).toISOString();
      const tx = db.transaction(() => {
        db.prepare("UPDATE gift_codes SET status = 'REVOKED' WHERE code = ?").run(normalized);
        db.prepare(
          'INSERT OR IGNORE INTO entitlements (visitor_id, tier, out_trade_no, quota, used, created_at, expires_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
        ).run(visitorId, row.tier, `GIFTBACK_${normalized}`, row.quota, now(), expiresAt);
      });
      tx();
      return { ok: true, code: normalized };
    },

    /** 我生成的和收到的礼品码 */
    listGiftsByVisitor(visitorId) {
      if (!visitorId) return { created: [], redeemed: [] };
      const created = db
        .prepare('SELECT * FROM gift_codes WHERE from_visitor = ? ORDER BY created_at DESC LIMIT 50')
        .all(visitorId)
        .map((r) => ({
          code: r.code,
          quota: r.quota,
          status: r.status,
          createdAt: r.created_at,
          redeemedAt: r.redeemed_at,
        }));
      const redeemed = db
        .prepare('SELECT * FROM gift_codes WHERE redeemed_by = ? ORDER BY redeemed_at DESC LIMIT 50')
        .all(visitorId)
        .map((r) => ({
          code: r.code,
          quota: r.quota,
          status: r.status,
          redeemedAt: r.redeemed_at,
        }));
      return { created, redeemed };
    },

    close() {
      db.close();
    },
  };
}
