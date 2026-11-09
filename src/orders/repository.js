import fs from 'node:fs';
import path from 'node:path';
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
export function createOrderRepository({ file = 'data/orders.db' } = {}) {
  const dbFile = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });

  const db = new Database(dbFile);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

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

  const now = () => new Date().toISOString();

  /** 落库是 JSON 字符串，出库统一还原为对象 */
  const parseServiceResult = (raw) => {
    if (raw === null || raw === undefined) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  };

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
      return {
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
      };
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

      const claimed = claimFulfillment.run(now(), outTradeNo).changes > 0;
      if (!claimed) {
        const current = await this.findByOutTradeNo(outTradeNo);
        if (current?.serviceResult) {
          return { state: current.fulfillStatus, serviceResult: current.serviceResult };
        }
        throw new Error(`FULFILLMENT_CLAIM_FAILED: ${outTradeNo}`);
      }

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
        for (const item of usage) {
          insertUsage.run({
            outTradeNo,
            meter: item.meter,
            quantity: item.quantity,
            unit: item.unit,
            createdAt: now(),
          });
        }
      });
      persist();

      return { state: 'PENDING_CONFIRM', serviceResult: generated.serviceResult };
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

    /** 访客的额度余额（看板与前端展示用） */
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
      const granted = entitlements.reduce((s, e) => s + e.quota, 0);
      const used = entitlements.reduce((s, e) => s + e.used, 0);
      return { granted, used, remaining: Math.max(0, granted - used), entitlements };
    },

    /**
     * 订单侧近 7 天汇总（周维度，呼应官方热度榜的周榜节奏）。
     * 与 orderStatsByVisitor 的区别：不带归因维度，只看时间窗。
     */
    orderStatsWeekly() {
      const since = new Date(Date.now() - 7 * 86400_000).toISOString();
      return db
        .prepare(`
          SELECT COUNT(*) AS paid,
                 SUM(CASE WHEN source != 'demo' THEN 1 ELSE 0 END) AS paid_real,
                 CAST(SUM(CASE WHEN order_status = 'PAID' THEN CAST(amount AS REAL) ELSE 0 END) AS REAL) AS revenue
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
                 SUM(CASE WHEN order_status = 'PAID' THEN CAST(amount AS REAL) ELSE 0 END) AS revenue,
                 SUM(CASE WHEN order_status = 'PAID' AND source = 'demo' THEN 1 ELSE 0 END) AS paid_selftest,
                 SUM(CASE WHEN order_status = 'PAID' AND source != 'demo' THEN 1 ELSE 0 END) AS paid_real
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

      let score = quest.scoring.base ?? 100;
      for (const bonus of quest.scoring.bonuses ?? []) {
        if (bonus.key === 'all_checkpoints') score += bonus.points;
        if (bonus.key === 'under_time' && (quest.estimatedMinutes ?? 0) > 0) score += bonus.points;
      }

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

    /** 订单概览看板 */
    stats() {
      const orders = db.prepare('SELECT COUNT(*) AS n FROM orders').get();
      const paid = db
        .prepare("SELECT COUNT(*) AS n FROM orders WHERE order_status = 'PAID'")
        .get();
      const revenue = db
        .prepare("SELECT COALESCE(SUM(CAST(amount AS REAL)), 0) AS total FROM orders WHERE order_status = 'PAID'")
        .get();
      const usage = db
        .prepare('SELECT meter, SUM(quantity) AS total FROM usage_records GROUP BY meter')
        .all();
      return { orders: orders.n, paid: paid.n, revenueCny: revenue.total, usage };
    },

    /** 供增长漏斗做 JOIN 查询（analytics.funnel(ordersDb)） */
    getDb() {
      return db;
    },

    close() {
      db.close();
    },
  };
}
