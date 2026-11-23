#!/usr/bin/env node
/**
 * 生产模式支付体验自检（prod-pay-ux-check）
 *
 * 为什么需要它：生产模式与服务端的 demo/pay 契约是 409 + PRODUCTION_PAYMENT_REQUIRED，
 * 与沙箱的 200 + content 完全不同。前端若按沙箱逻辑处理，会给评委显示
 * 「生产环境不代付真实资金」+「支付宝沙箱偶发繁忙，请重试」这种自相矛盾的提示。
 * 这个脚本起一个**本地生产模式实例**（不需要真密钥——precreate 默认关闭，
 * 生产分支不依赖 OpenAPI 调用），验证：
 *   ① 402 挑战在生产模式下依然正确（Payment-Needed 头 + 五项字段）
 *   ② demo/pay 返回 409 + code + 可操作指引（不是 403 死路，也不是 500）
 *   ③ 响应体带齐前端渲染「支付账单卡」所需的字段
 *
 * 用法：node scripts/prod-pay-ux-check.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3399;
const BASE = `http://127.0.0.1:${PORT}`;

const G = '\x1b[32m', R = '\x1b[31m', C = '\x1b[36m', N = '\x1b[0m';
let failed = 0;
const ok = (m) => console.log(`  ${G}✓${N} ${m}`);
const bad = (m) => { console.log(`  ${R}✗ ${m}${N}`); failed += 1; };
const step = (m) => console.log(`\n${C}▸ ${m}${N}`);

// ── 造一份最小生产配置 ──────────────────────────────────────
// 🔴 密钥必须是**语法合法**的：AlipaySdk 在构造时就会解析私钥，占位符会直接
//    抛 ERR_OSSL_ASN1_NOT_ENOUGH_DATA 而起不来。这里用 Node crypto 现生成一把
//    一次性 RSA 密钥（本地、随机、不入库、不接触任何真实支付宝密钥），
//    支付宝公钥同样用这把钥匙的公钥部分占位——本自检不发起任何 OpenAPI 调用
//    （precreate 默认关闭），只验协议契约。
import crypto from 'node:crypto';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const privPkcs1Pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const privB64 = privPkcs1Pem
  .replace(/-----(BEGIN|END) RSA PRIVATE KEY-----/g, '')
  .replace(/\s+/g, '');
const pubB64 = publicKey
  .export({ type: 'spki', format: 'pem' })
  .toString()
  .replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '')
  .replace(/\s+/g, '');

const prodCfg = path.join(ROOT, 'config', '.prod-ux-check.json');
fs.writeFileSync(prodCfg, JSON.stringify({
  appId: '2021000000000000',
  alipayPublicKey: pubB64,
  privateKey: privB64,
  sellerId: '2088032169158784',
  gateway: 'https://openapi.alipay.com/gateway.do',
  precreate: { enabled: false },
}, null, 2));

// 生产模式会拒绝 mock serviceId（真实切生产的闸门在 prod-check.mjs）。
// 本自检用**临时档位表**提供非 mock 的 serviceId，让生产分支能离线跑起来。
const svcCfg = path.join(ROOT, 'config', '.prod-ux-services.json');
fs.writeFileSync(svcCfg, JSON.stringify({
  tiers: {
    single: { serviceId: 'CHECK_ONLY_NOT_A_REAL_SERVICE_ID', unitPrice: '0.50', quota: 1, label: '单次导览' },
  },
}, null, 2));

const srv = spawn('node', ['src/server.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    ALIPAY_ENV: 'production',
    ALIPAY_PRODUCTION_CONFIG: prodCfg,
    ALIPAY_SERVICES_CONFIG: svcCfg,
    PORT: String(PORT),
    ALIPAY_SELLER_ID: '2088032169158784',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
srv.stdout.on('data', (d) => { out += d.toString(); });
srv.stderr.on('data', (d) => { out += d.toString(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  // ── 等服务起来 ────────────────────────────────────────────
  step('0. 启动生产模式实例');
  let up = false;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const r = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) { up = true; break; }
    } catch {}
  }
  if (!up) {
    bad('生产模式实例未能启动');
    console.log(out.split('\n').slice(-12).map((l) => '      ' + l).join('\n'));
    process.exit(1);
  }
  ok(`生产模式实例已启动（${BASE}）`);

  // ── 1. 402 挑战 ───────────────────────────────────────────
  step('1. 生产模式下的 402 支付挑战');
  const guide = await fetch(
    `${BASE}/api/v1/guide?scene=zjgsu-xiasha&query=%E4%BB%8E%E5%9B%BE%E4%B9%A6%E9%A6%86%E5%88%B0%E8%A1%8C%E6%94%BF%E6%A5%BC%E6%80%8E%E4%B9%88%E8%B5%B0`,
    { redirect: 'manual', signal: AbortSignal.timeout(20000) },
  );
  if (guide.status !== 402) bad(`未返回 402（实际 ${guide.status}）`);
  else ok('402 状态正确');
  const needed = guide.headers.get('payment-needed');
  needed ? ok('Payment-Needed 头存在') : bad('缺少 Payment-Needed 头');
  const body = await guide.json().catch(() => ({}));
  for (const k of ['out_trade_no', 'amount', 'currency', 'goods_name']) {
    body[k] ? ok(`响应体含 ${k}`) : bad(`响应体缺 ${k}`);
  }

  // ── 2. demo/pay 生产分支 ───────────────────────────────────
  step('2. 生产模式下 demo/pay 的响应契约');
  const demo = await fetch(`${BASE}/api/v1/demo/pay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scene: 'zjgsu-xiasha', query: '从图书馆到行政楼怎么走' }),
    signal: AbortSignal.timeout(20000),
  });
  const j = await demo.json().catch(() => ({}));
  if (demo.status === 409) ok('返回 409（不是 403 死路、也不是 500）');
  else bad(`期望 409，实际 ${demo.status}`);
  j.code === 'PRODUCTION_PAYMENT_REQUIRED'
    ? ok('code = PRODUCTION_PAYMENT_REQUIRED（前端据此渲染账单卡）')
    : bad(`code 不对：${j.code}`);
  j.message && /alipay-pay-for-402-service/.test(j.message)
    ? ok('message 含官方买方技能指引')
    : bad('message 缺少官方买方技能指引');
  j.agent_instructions ? ok('带 agent_instructions（前端渲染用）') : bad('缺 agent_instructions');
  j.out_trade_no ? ok(`带 out_trade_no（${j.out_trade_no}）`) : bad('缺 out_trade_no');
  j.amount ? ok(`带 amount（¥${j.amount}）`) : bad('缺 amount');
  j.goods_name ? ok('带 goods_name') : bad('缺 goods_name');
  j.resource_id ? ok('带 resource_id') : bad('缺 resource_id');
  // amt_payment_link 只在 precreate 开启时存在——本自检未开，不应出现
  j.amt_payment_link === undefined
    ? ok('amt_payment_link 在 precreate 关闭时正确缺省')
    : bad('amt_payment_link 在 precreate 关闭时不应出现');

  // ── 3. meta.env 供前端判断 ────────────────────────────────
  step('3. meta 暴露 env（前端按钮文案依据）');
  const meta = await (await fetch(`${BASE}/api/v1/meta`, { signal: AbortSignal.timeout(10000) })).json();
  meta.env === 'production' ? ok('meta.env = production') : bad(`meta.env = ${meta.env}`);
} finally {
  srv.kill('SIGKILL');
  try { fs.rmSync(prodCfg, { force: true }); } catch {}
  try { fs.rmSync(svcCfg, { force: true }); } catch {}
}

console.log(`\n${failed ? R : G}${failed ? `失败 ${failed} 项` : '生产模式支付体验自检全部通过'}${N}`);
process.exit(failed ? 1 : 0);
