#!/usr/bin/env node
/**
 * 取首笔生产真实交易号（first-trade-no）
 *
 * 提交表单的「AI 付接入凭证」要填**支付宝交易号（28 位）**。
 * 这个脚本负责在生产切换后找到那一笔，并把号码写进提交就绪包。
 *
 * ## 为什么要按「位数」筛，而不是按「最新一笔」取
 *
 *   2026-11-24 实测：沙箱收银给出的 trade_no 是 **32 位**
 *   （形如 20261124008281003704280000037890），而**生产真实交易号是 28 位**。
 *   ⇒ 位数就是「沙箱 / 生产」的分界线。直接取最新一笔会把沙箱号当成生产凭证
 *     填进表单——评委那边会被判为无效凭证，而且很难看出是哪一步错的。
 *
 * ## 还要排除自测订单
 *
 *   站内演示代付（source='demo'）与验收脚本产生的订单都不算真人付费，
 *   必须排除（口径与 src/orders/repository.js 的 SELF_TEST_SQL 一致）。
 *
 * 用法：
 *   node scripts/first-trade-no.mjs --db /srv/apps/sceneguide/app/data/orders.db
 *   node scripts/first-trade-no.mjs --remote          # 直接从线上服务器取
 *   node scripts/first-trade-no.mjs --dry             # 只看，不写入
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST = process.env.SG_DEPLOY_HOST ?? 'aliyun';
const REMOTE_DB = '/srv/apps/sceneguide/app/data/orders.db';
// --ready 可覆盖就绪包路径（行为测试用，避免改真文件）
const readyArg = (() => {
  const i = process.argv.indexOf('--ready');
  return i >= 0 ? process.argv[i + 1] : null;
})();
const READY = readyArg ? path.resolve(readyArg) : path.join(ROOT, '提交材料', '作品提交就绪包.md');

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', C = '\x1b[36m', N = '\x1b[0m';
let failed = 0;
const ok = (m) => console.log(`  ${G}✓${N} ${m}`);
const bad = (m) => { console.log(`  ${R}✗ ${m}${N}`); failed += 1; };
const warn = (m) => console.log(`  ${Y}!${N} ${m}`);
const step = (m) => console.log(`\n${C}▸ ${m}${N}`);

const DRY = process.argv.includes('--dry');
const REMOTE = process.argv.includes('--remote');
const dbArg = (() => {
  const i = process.argv.indexOf('--db');
  return i >= 0 ? process.argv[i + 1] : null;
})();

// ── 取库 ─────────────────────────────────────────────────────
step('① 读取订单库');
let dbPath = dbArg;
if (REMOTE) {
  const tmp = path.join(os.tmpdir(), `sg-orders-${process.pid}.db`);
  try {
    execFileSync('scp', ['-q', `${HOST}:${REMOTE_DB}`, tmp]);
    dbPath = tmp;
    ok(`已从 ${HOST}:${REMOTE_DB} 取回订单库`);
  } catch (err) {
    bad(`从服务器取订单库失败：${err.message}`);
  }
} else if (!dbPath) {
  dbPath = path.join(ROOT, 'data', 'orders.db');
}
if (!dbPath || !fs.existsSync(dbPath)) bad(`订单库不存在：${dbPath ?? '(未知)'}`);

let rows = [];
if (fs.existsSync(dbPath ?? '')) {
  try {
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(dbPath, { readonly: true });
    rows = db.prepare(`
      SELECT o.out_trade_no, o.trade_no, o.amount, o.tier, o.source, o.visitor_id,
             o.order_status, o.fulfill_status, o.updated_at
        FROM orders o
       WHERE o.trade_no IS NOT NULL AND o.trade_no <> ''
         AND o.order_status = 'PAID' AND o.fulfill_status = 'FULFILLED'
       ORDER BY o.updated_at DESC
    `).all();
    db.close();
    ok(`已支付且已履约的订单 ${rows.length} 笔`);
  } catch (err) {
    bad(`读取订单库失败：${err.message}`);
  }
}

// ── 分类 ─────────────────────────────────────────────────────
step('② 按「位数 + 非自测」筛出生产真实交易');
// 自测口径与 src/orders/repository.js 的 SELF_TEST_SQL 保持一致：
//   站内演示代付（source='demo'）+ 验收脚本造的访客前缀，都不算真人付费。
const SELF_TEST_PREFIXES = ['mcp-e2e-', 'acct-', 'verify-', 'probe-', 'story-demo-'];
const isSelfTest = (r) => {
  if (r.source === 'demo') return true;
  const v = String(r.visitor_id ?? '');
  return SELF_TEST_PREFIXES.some((p) => v.startsWith(p));
};

const sandboxRows = rows.filter((r) => String(r.trade_no).length !== 28);
const prodRows = rows.filter((r) => String(r.trade_no).length === 28);
const realProd = prodRows.filter((r) => !isSelfTest(r));

sandboxRows.length
  ? ok(`${sandboxRows.length} 笔是沙箱交易号（${String(sandboxRows[0].trade_no).length} 位）——已排除`)
  : ok('没有沙箱交易号');
prodRows.length === 0
  ? bad('没有找到 28 位交易号——生产切换尚未生效，或还没有真人完成过真实付款')
  : ok(`找到 ${prodRows.length} 笔 28 位交易号`);
realProd.length === 0
  ? warn('28 位交易号里全部是自测订单——它们不计入「真实付费用户数」，不能作为凭证')
  : ok(`其中 ${realProd.length} 笔是非自测（真人付费）`);

const chosen = realProd[0] ?? prodRows[0] ?? null;

// ── 写入就绪包 ───────────────────────────────────────────────
step('③ 写入提交就绪包');
if (!chosen) {
  bad('没有可写入的交易号');
} else {
  const tradeNo = String(chosen.trade_no);
  ok(`选中交易号：${tradeNo}（${chosen.tier} / ¥${chosen.amount} / ${chosen.out_trade_no}）`);
  if (realProd.length === 0) {
    warn('这是自测订单的交易号——只能用于打通链路，不足以支撑「真实付费用户数」这一维度');
  }
  if (!fs.existsSync(READY)) {
    bad(`找不到就绪包：${READY}`);
  } else {
    const text = fs.readFileSync(READY, 'utf8');
    const re = /支付宝交易号（28 位）：【[^】]*】/;
    if (!re.test(text)) {
      bad('就绪包里没找到交易号槽位（格式应为「支付宝交易号（28 位）：【…】」）');
    } else if (text.includes(tradeNo)) {
      ok('就绪包已含该交易号，无需改动');
    } else if (DRY) {
      warn(`DRY：将会把交易号写入就绪包`);
    } else {
      fs.writeFileSync(READY, text.replace(re, `支付宝交易号（28 位）：【${tradeNo}】`), 'utf8');
      ok('已写入就绪包');
    }
  }
}

console.log(`\n${failed ? R : G}${failed ? `失败 ${failed} 项` : '交易号提取完成'}${N}`);
process.exit(failed ? 1 : 0);
