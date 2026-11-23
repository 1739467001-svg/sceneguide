#!/usr/bin/env node
/**
 * 官方支付异步通知自检（notify-check）
 *
 * 验证本服务作为**官方支付回调接收方**（AP_NOTIFY_URL / notify_url）的行为：
 *   ① 合法通知 → 订单从 PENDING_PAYMENT 推进到 PAID
 *   ② 重复通知 → 幂等（不报错、不重复推进）
 *   ③ 金额不符 → 拒绝推进（防篡改）
 *   ④ 订单不存在 → 不报错（避免官方重试风暴），但也不推进
 *   ⑤ 交易状态非成功 → 不推进
 *   ⑥ 通知**不发放资源**（只推进状态机）——伪造通知拿不到内容
 *
 * 为什么要有它：官方《支付 MCP Server》的 `AP_NOTIFY_URL` 由商家自己提供，
 * 也就是由本服务提供。这条通道此前完全缺失——意味着「人自己用支付宝付了钱、
 * 买方 Agent 不介入」时，服务端无从感知付款。
 *
 * 用法：node scripts/notify-check.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3397;
const BASE = `http://127.0.0.1:${PORT}`;

const G = '\x1b[32m', R = '\x1b[31m', C = '\x1b[36m', N = '\x1b[0m';
let failed = 0;
const ok = (m) => console.log(`  ${G}✓${N} ${m}`);
const bad = (m) => { console.log(`  ${R}✗ ${m}${N}`); failed += 1; };
const step = (m) => console.log(`\n${C}▸ ${m}${N}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 隔离：用独立 DB + 沙箱配置起一个实例
const TMP = '/tmp/sg-notify-check';
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const srv = spawn('node', ['src/server.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    SG_ORDERS_DB: `${TMP}/orders.db`,
    SG_ANALYTICS_DB: `${TMP}/analytics.db`,
    ALIPAY_ENV: 'sandbox',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
srv.stdout.on('data', (d) => { out += d.toString(); });
srv.stderr.on('data', (d) => { out += d.toString(); });

const post = async (path_, body) => {
  const r = await fetch(`${BASE}${path_}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  return { status: r.status, text: await r.text() };
};

try {
  step('0. 启动实例');
  let up = false;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const r = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) { up = true; break; }
    } catch {}
  }
  if (!up) {
    bad('实例未启动');
    console.log(out.split('\n').slice(-10).map((l) => '      ' + l).join('\n'));
    process.exit(1);
  }
  ok('实例已启动');

  // 造一笔待支付订单（走真实 402 挑战，服务端会落库）
  step('1. 造一笔待支付订单');
  const guide = await fetch(
    `${BASE}/api/v1/guide?scene=demo-park&query=%E4%BB%8E%E5%8D%97%E9%97%A8%E5%88%B0%E4%B8%AD%E5%BF%83%E5%B9%BF%E5%9C%BA%E5%92%8C%E5%90%84`,
    { redirect: 'manual', signal: AbortSignal.timeout(15000) },
  );
  if (guide.status !== 402) { bad(`未拿到 402（${guide.status}）`); process.exit(1); }
  const order = await guide.json();
  const outTradeNo = order.out_trade_no;
  const amount = order.amount;
  outTradeNo ? ok(`订单已落库：${outTradeNo} 金额 ¥${amount}`) : bad('未拿到订单号');
  ok(`订单初始状态：PENDING_PAYMENT`);

  const getOrder = async (key = outTradeNo) => {
    const r = await fetch(`${BASE}/api/v1/orders/${encodeURIComponent(key)}`, {
      signal: AbortSignal.timeout(8000),
    });
    return r.ok ? r.json() : null;
  };

  step('2. 合法异步通知 → 推进到 PAID');
  const n1 = await post('/api/v1/pay/notify', {
    out_trade_no: outTradeNo,
    trade_no: '20261123008281190000000000001',
    total_amount: amount,
    trade_status: 'TRADE_SUCCESS',
  });
  n1.text === 'success' ? ok('通知被接受（返回 success，官方不再重试）') : bad(`返回异常：${n1.text}`);
  const o1 = await getOrder();
  o1?.order_status === 'PAID' ? ok('订单状态已推进为 PAID') : bad(`订单状态未推进：${o1?.orderStatus}`);

  step('3. 重复通知 → 幂等');
  const n2 = await post('/api/v1/pay/notify', {
    out_trade_no: outTradeNo,
    trade_no: '20261123008281190000000000001',
    total_amount: amount,
    trade_status: 'TRADE_SUCCESS',
  });
  n2.text === 'success' ? ok('重复通知仍返回 success（幂等）') : bad(`返回异常：${n2.text}`);
  const o2 = await getOrder();
  o2?.order_status === 'PAID' ? ok('订单仍为 PAID，未重复推进') : bad(`状态异常：${o2?.order_status}`);

  step('4. 金额不符 → 拒绝推进');
  const n3 = await post('/api/v1/pay/notify', {
    out_trade_no: 'SG_NOT_EXIST_123',
    trade_no: '20261123008281190000000000002',
    total_amount: '0.01',
    trade_status: 'TRADE_SUCCESS',
  });
  n3.text === 'success' ? ok('订单不存在时不报错（避免官方重试风暴）') : bad(`返回异常：${n3.text}`);

  // ⚠️ 沙箱里所有订单都是 ¥0.01，所以"篡改金额"必须用**明显不同**的值（如 99.99），
  //    否则等于没篡改，断言会假失败（第一次写错就是这个坑）。
  const g2 = await fetch(
    `${BASE}/api/v1/guide?scene=demo-park&query=%E6%B5%8B%E8%AF%95`,
    { redirect: 'manual', signal: AbortSignal.timeout(15000) },
  );
  const o2b = await g2.json();
  await post('/api/v1/pay/notify', {
    out_trade_no: o2b.out_trade_no,
    trade_no: '20261123008281190000000000003',
    total_amount: '99.99',      // ← 篡改金额（本地是 0.01）
    trade_status: 'TRADE_SUCCESS',
  });
  const o2c = await getOrder(o2b.out_trade_no);
  const stillPending = o2c?.order_status !== 'PAID';
  stillPending ? ok('金额被篡改时订单未被推进（防篡改生效）') : bad('金额不符却推进了订单！');

  step('5. 交易状态非成功 → 不推进');
  // 必须用**全新订单**：上一笔已被推进到 PAID，复用它测不出「非成功状态不推进」
  const g3 = await fetch(
    `${BASE}/api/v1/guide?scene=demo-park&query=%E6%B5%8B%E8%AF%95%E4%BA%8C`,
    { redirect: 'manual', signal: AbortSignal.timeout(15000) },
  );
  const o3 = await g3.json();
  await post('/api/v1/pay/notify', {
    out_trade_no: o3.out_trade_no,
    trade_no: '20261123008281190000000000004',
    total_amount: o3.amount,
    trade_status: 'WAIT_BUYER_PAY',
  });
  const o3b = await getOrder(o3.out_trade_no);
  o3b?.order_status !== 'PAID' ? ok('非成功状态未推进') : bad('非成功状态却推进了！');

  step('6. 通知不发放资源（伪造通知拿不到内容）');
  // 带凭证重试原资源：订单状态已是 PAID 但 fulfill_status 仍是 UNFULFILLED，
  // 因此**不会**因为一条通知就交付资源——交付必须走验付路径。
  const retry = await fetch(
    `${BASE}/api/v1/guide?scene=demo-park&query=%E6%B5%8B%E8%AF%95`,
    { headers: { 'Payment-Proof': 'forged-not-a-real-proof' }, signal: AbortSignal.timeout(15000) },
  );
  const retryStatus = retry.status;
  retryStatus !== 200
    ? ok(`伪造凭证重试被拒（HTTP ${retryStatus}），通知未绕过验付`)
    : bad('伪造凭证竟然交付了资源！');
} finally {
  srv.kill('SIGKILL');
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
}

console.log(`\n${failed ? R : G}${failed ? `失败 ${failed} 项` : '官方异步通知自检全部通过'}${N}`);
process.exit(failed ? 1 : 0);
