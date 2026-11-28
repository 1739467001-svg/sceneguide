#!/usr/bin/env node
/**
 * 生产切换链路的契约自检（verify-prod-cutover）
 *
 * 为什么要有这一项：
 *   「切生产 → 取交易号 → 提交作品」是整条链上**不可逆且只有一次机会**的一段。
 *   其中最容易出错、又最难在事后看出来的两件事：
 *     ① 拿错交易号 —— 沙箱号是 32 位、生产号是 28 位，填错了表单会判无效凭证；
 *     ② 脚本与提交文书不同步 —— 取号脚本写的槽位格式，和就绪包里预留的槽位对不上，
 *        到了提交那一刻才发现，就绪包里还是「待填」。
 *   这两件事都能**离线**测出来，所以不该留到截止日前夜才发现。
 *
 * 本项做的是**真实行为测试**（不是静态检查）：
 *   ① 用一个临时订单库造三种订单，验证取号脚本挑的是哪一个：
 *      32 位沙箱号 / 28 位真人单 / 28 位自测单；
 *   ② 验证就绪包里的槽位格式与脚本写入的格式一致（用临时副本，不动真文件）；
 *   ③ 验证生产配置缺失时切换脚本会**拒绝**执行而不是照样切。
 *
 * 用法：node scripts/verify/verify-prod-cutover.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', C = '\x1b[36m', N = '\x1b[0m';
let failed = 0;
const ok = (m) => console.log(`  ${G}✓${N} ${m}`);
const bad = (m) => { console.log(`  ${R}✗ ${m}${N}`); failed += 1; };
// warn：待办提醒（如「交易号待填」是提交前的**合法状态**），不算失败、不计入退出码。
// 🔴 这个 helper 曾经缺失——「槽位待填」分支调用未定义的 warn 直接 ReferenceError 崩掉，
//    把「合法待办」伪装成了「脚本崩溃」，整个 §23 因此永远红。
const warn = (m) => console.log(`  ${Y}⚠ ${m}${N}`);
const step = (m) => console.log(`\n${C}▸ ${m}${N}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-cutover-'));

// ── ① 造三种订单，验证取号脚本挑对了 ───────────────────────
step('① 取号脚本挑的是「28 位 + 非自测」那一笔');
const dbPath = path.join(tmp, 'orders.db');
{
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE orders (
    out_trade_no TEXT PRIMARY KEY, amount TEXT, currency TEXT, resource_id TEXT,
    goods_name TEXT, tier TEXT, pay_before TEXT, order_status TEXT, fulfill_status TEXT,
    trade_no TEXT, service_result TEXT, created_at TEXT, updated_at TEXT,
    visitor_id TEXT, ref_code TEXT, source TEXT NOT NULL DEFAULT 'api')`);
  const ins = db.prepare(`INSERT INTO orders
    (out_trade_no, amount, currency, resource_id, goods_name, tier, pay_before,
     order_status, fulfill_status, trade_no, created_at, updated_at, visitor_id, source)
    VALUES (?, '0.50', 'CNY', '/api/v1/guide', '单次导览', 'single', '2099-01-01T00:00:00+08:00',
            'PAID', 'FULFILLED', ?, '2026-11-24T00:00:00Z', ?, ?, ?)`);
  // ① 沙箱单：32 位交易号（真实存在的那类）
  ins.run('SG_sandbox_1', '20261124008281003704280000037890', '2026-11-24T01:00:00Z', 'v-sandbox', 'api');
  // ② 真人单：28 位生产交易号
  ins.run('SG_real_1', '2026112422001492830500001234', '2026-11-24T02:00:00Z', 'v-real', 'api');
  // ③ 自测单：28 位，但是验收脚本造的访客
  ins.run('SG_selftest_1', '2026112422001492830500005678', '2026-11-24T03:00:00Z', 'acct-verify-x', 'api');
  // ④ 真人单（较新）：另一个 28 位，用来验证取的是最新还是任意
  ins.run('SG_real_2', '2026112422001492830500009012', '2026-11-24T04:00:00Z', 'v-real2', 'api');
  db.close();
  ok('临时订单库已造好（32 位沙箱 ×1 / 28 位真人 ×2 / 28 位自测 ×1）');
}

// 用临时就绪包副本跑取号脚本
const readyCopy = path.join(tmp, 'ready.md');
fs.copyFileSync(path.join(ROOT, '提交材料', '作品提交就绪包.md'), readyCopy);
{
  let out = '';
  let code = 0;
  try {
    out = execFileSync('node', [
      path.join(ROOT, 'scripts', 'prod', 'first-trade-no.mjs'),
      '--db', dbPath, '--ready', readyCopy,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    code = err.status ?? 1;
  }
  const text = fs.readFileSync(readyCopy, 'utf8');
  const m = text.match(/支付宝交易号（28 位）：【([^】]+)】/);
  const chosen = m?.[1] ?? '';
  chosen === '2026112422001492830500009012'
    ? ok(`选中了最新的 28 位真人交易号（${chosen}）——没选沙箱号、没选自测单`)
    : bad(`选错了交易号：${chosen || '(未写入)'}（应是 2026112422001492830500009012）`);
  out.includes('32 位')
    ? ok('输出里明确区分了沙箱位数')
    : warn('输出里没有提沙箱位数');
}

// ── ② 槽位格式与就绪包一致 ─────────────────────────────────
step('② 脚本写入的槽位格式 = 就绪包预留的槽位格式');
{
  const real = fs.readFileSync(path.join(ROOT, '提交材料', '作品提交就绪包.md'), 'utf8');
  /支付宝交易号（28 位）：【[^】]*】/.test(real)
    ? ok('就绪包里存在「支付宝交易号（28 位）：【…】」槽位，脚本写入格式一致')
    : bad('就绪包里没有「支付宝交易号（28 位）：【…】」槽位——脚本写不进去');
  real.includes('【待填')
    ? ok('槽位当前仍是「待填」（生产交易完成后由脚本替换）')
    : warn('槽位里已经没有「待填」了——确认是不是已经填过真实交易号');
}

// ── ③ 生产配置缺失时切换脚本必须拒绝 ───────────────────────
step('③ 生产配置缺失时，切生产脚本必须拒绝执行');
{
  const prodPath = path.join(ROOT, 'config', 'production.json');
  const had = fs.existsSync(prodPath);
  if (had) fs.renameSync(prodPath, path.join(tmp, 'production.json.bak'));
  let code = 0;
  let out = '';
  try {
    out = execFileSync('node', [path.join(ROOT, 'scripts', 'prod', 'prod-cutover.mjs'), '--check'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    code = err.status ?? 1;
  }
  if (had) fs.renameSync(path.join(tmp, 'production.json.bak'), prodPath);
  code !== 0
    ? ok('缺少生产配置时退出码非 0（拒绝切生产）')
    : bad('缺少生产配置居然通过了体检——会切到生产却用不了真实凭证');
  out.includes('production.json')
    ? ok('报错里点名了缺哪个文件')
    : warn('报错里没点名缺失文件');
}

// ── ④ 切换脚本不会把私钥打印出来 ───────────────────────────
step('④ 切换脚本不会把私钥写进输出');
{
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'prod', 'prod-cutover.mjs'), 'utf8');
  const logsSecret = /console\.(log|info|warn)\([^)]*privateKey[^)]*\)/.test(src);
  logsSecret
    ? bad('prod-cutover.mjs 里有直接打印 privateKey 的语句')
    : ok('没有直接打印 privateKey 的语句（只做格式体检）');
  /只验格式|绝不打印|不打印/.test(src)
    ? ok('脚本注释里写明了私钥边界')
    : warn('脚本没有写明私钥边界');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${failed ? R : G}${failed ? `失败 ${failed} 项` : '生产切换链路契约自检全部通过'}${N}`);
process.exit(failed ? 1 : 0);
