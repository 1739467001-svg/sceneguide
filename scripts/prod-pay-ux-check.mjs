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
import { spawn, execFileSync } from 'node:child_process';
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

const dbFile = path.join(ROOT, 'config', '.prod-ux-orders.db');
const anFile = path.join(ROOT, 'config', '.prod-ux-analytics.db');
const srv = spawn('node', ['src/server.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    ALIPAY_ENV: 'production',
    ALIPAY_PRODUCTION_CONFIG: prodCfg,
    ALIPAY_SERVICES_CONFIG: svcCfg,
    PORT: String(PORT),
    ALIPAY_SELLER_ID: '2088032169158784',
    // 临时数据库：本自检要读订单的 source 字段（验证生产分支没有把真人订单标成自测），
    // 同时避免往真实本地库里写测试订单。
    // ⚠️ server.js 读的是 ORDER_DB / ANALYTICS_DB（不是仓储层的 SG_ORDERS_DB 默认值）——
    //    写错变量名的后果是**静默落到真实 data/orders.db**，测试订单会污染本地库。
    ORDER_DB: dbFile,
    ANALYTICS_DB: anFile,
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
  // 带 Host 头发请求：模拟反代透传公网 Host（nginx 只透传 Host，不透传协议/前缀）。
  // ⚠️ 必须用 curl 而不是 Node 的 fetch：undici 会用 URL 里的主机覆盖自定义 Host 头，
  //    于是服务端永远只看到 127.0.0.1——推导逻辑等于没验（第一版就踩了这个）。
  const demoRaw = execFileSync('curl', [
    '-s', '-m', '25', '-X', 'POST', `${BASE}/api/v1/demo/pay`,
    '-H', 'Content-Type: application/json',
    '-H', 'Host: 121.43.80.231',
    '-d', JSON.stringify({ scene: 'zjgsu-xiasha', query: '从图书馆到行政楼怎么走' }),
    '-w', '\n%{http_code}',
  ], { encoding: 'utf8' });
  const [demoBody, demoCode] = [demoRaw.slice(0, demoRaw.lastIndexOf('\n')), demoRaw.slice(demoRaw.lastIndexOf('\n') + 1).trim()];
  const j = JSON.parse(demoBody || '{}');
  if (demoCode === '409') ok('返回 409（不是 403 死路、也不是 500）');
  else bad(`期望 409，实际 ${demoCode}`);
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

  // 生产账单卡（前端 renderProductionBill）依赖的字段
  j.payment_needed && /^[A-Za-z0-9_-]{20,}$/.test(j.payment_needed)
    ? ok('带 payment_needed（形态 A 原文，买方 CLI --file 要用）')
    : bad('缺 payment_needed 或形制不对');
  j.resource_url && String(j.resource_url).includes('/api/v1/guide')
    ? ok('带 resource_url（人/Agent 复现 402 的完整地址）')
    : bad('缺 resource_url');
  j.buyer_command && /alipay-bot 402-buyer-pay/.test(j.buyer_command)
    ? ok('带 buyer_command（一键可跑的官方买方命令）')
    : bad('缺 buyer_command');
  j.buyer_command && j.resource_url && String(j.buyer_command).includes(String(j.resource_url))
    ? ok('buyer_command 里的资源 URL 与本次 402 一致')
    : bad('buyer_command 里的资源 URL 与本次 402 不一致');
  // 🔴 2026-11-27：resource_url 曾默认取 http://127.0.0.1:PORT（服务器上没设 SELF_BASE_URL），
  //    导致给评委的「一条命令付完」指向一个他访问不到的地址 → connection refused。
  //    现在按 Host 头推导公网地址；这里断言它**不是**回环/内网地址。
  const ru = String(j.resource_url ?? '');
  /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)(:|\/|$)/.test(ru)
    ? bad(`resource_url 是内网回环地址（${ru}）——评委复制买方命令也连不上`)
    : ok(`resource_url 是公网可达地址（${ru}）`);

  // 🔴 关键回归（2026-11-27）：生产分支曾把订单 markSelfTest，
  //    导致真人买家通过站点 UI 付的钱被排除在「真实付费用户数」之外（静默清零 25%）。
  step('2b 生产分支不得把真人订单标成自测');
  {
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(dbFile, { readonly: true });
    const row = db.prepare('SELECT source, order_status FROM orders WHERE out_trade_no = ?')
      .get(j.out_trade_no);
    db.close();
    if (!row) bad(`订单 ${j.out_trade_no} 未落库`);
    else if (String(row.source) === 'demo') bad('订单被标成 source=demo——真人付费会被排除出商业化统计');
    else ok(`订单 source=${row.source}（计入真实付费用户数）`);
  }

  // ── 2c 验付失败必须告知「上一次为什么没成」，且不得泄露内部细节 ──
  // 官方时序图：验证失败 → 402 + 「支付凭证无效或已过期」→ 提示需重新支付。
  // 旧实现返回通用新账单，买方看不出上一笔为什么失败；而直接把 SDK 的
  // errorMessage 透传出去又会泄露 traceId 与内部排查链接。两者都要防。
  step('2c 验付失败的反馈（清晰 + 不泄露内部细节）');
  {
    const badProof = Buffer.from(JSON.stringify({
      protocol: { payment_proof: 'deadbeef', trade_no: '2026112422001492830500001234' },
      method: { client_session: 'x' },
    })).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const r = await fetch(
      `${BASE}/api/v1/guide?scene=zjgsu-xiasha&query=%E6%B5%8B%E8%AF%95`,
      { headers: { 'Payment-Proof': badProof }, redirect: 'manual', signal: AbortSignal.timeout(20000) },
    );
    const b = await r.json().catch(() => ({}));
    r.status === 402 ? ok('验付失败返回 402（与官方流程一致）') : bad(`期望 402，实际 ${r.status}`);
    b.previous_failure
      ? ok(`带 previous_failure：「${String(b.previous_failure).slice(0, 50)}」`)
      : bad('缺 previous_failure——买方看不出上一笔为什么没成');
    const leak = /traceId|errCheck|https?:\/\//.test(JSON.stringify(b));
    leak ? bad('响应体泄露了 traceId / 内部排查链接') : ok('未泄露 traceId 与内部排查链接');
    String(b.message ?? '').includes('重新支付')
      ? ok('message 明示需重新支付（官方口径）')
      : bad('message 未说明要重新支付');
  }

  // ── 2d MCP 端点在生产模式下也必须带着**真实 service_id** 发起挑战 ──
  // 官方 Machine Pay 定位：「专为智能体经济打造，让每一个 AI 技能、MCP 服务、API 都能实时变现」。
  // MCP 是我们的第二条付费入口（与 HTTP 路径同构），但它走的是内部回环，
  // 历史上最容易出现「HTTP 路径换了真实 service_id、MCP 路径还在用 mock」的漂移。
  step('2d 生产模式下 MCP 端点的支付挑战');
  {
    const list = await (await fetch(`${BASE}/mcp`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      signal: AbortSignal.timeout(20000),
    })).json();
    const tools = ((list.result ?? {}).tools ?? []).map((x) => x.name);
    tools.includes('scene_guide')
      ? ok(`MCP 工具已暴露：${tools.join(' / ')}`)
      : bad(`MCP 未暴露 scene_guide 工具（实际：${tools.join(' / ') || '无'}）`);

    const call = await (await fetch(`${BASE}/mcp`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'scene_guide', arguments: { scene: 'zjgsu-xiasha', query: '从图书馆到行政楼怎么走' } },
      }),
      signal: AbortSignal.timeout(25000),
    })).json();
    const sc = (call.result ?? {}).structuredContent ?? {};
    sc.status === 'payment_required'
      ? ok('MCP 无凭证调用返回 payment_required（订单同步落库）')
      : bad(`MCP 未返回支付挑战（status=${sc.status}）`);
    const mcpSid = (sc.payment_needed ?? {}).method?.service_id;
    mcpSid && mcpSid !== 'api_mock_service_id'
      ? ok(`MCP 挑战携带真实 service_id（${mcpSid}）——与 HTTP 路径没有漂移`)
      : bad(`MCP 挑战的 serviceId 仍是 mock 或缺失（${mcpSid}）`);
    String(sc.amount) === '0.50'
      ? ok(`MCP 挑战金额 ¥${sc.amount} 与注册价一致`)
      : bad(`MCP 挑战金额 ¥${sc.amount} 与注册价 0.50 不一致`);
    (sc.payment_needed_header ?? '').length > 100
      ? ok('MCP 挑战带 Base64URL 原文（买方技能只认这个）')
      : bad('MCP 挑战缺 payment_needed_header 原文');
    (sc.next ?? {}).skill === 'alipay-pay-for-402-service'
      ? ok('MCP 挑战指向官方买方技能 alipay-pay-for-402-service')
      : bad('MCP 挑战未指向官方买方技能');
  }

  // ── 3. meta.env 供前端判断 ────────────────────────────────
  step('3. meta 暴露 env（前端按钮文案依据）');
  const meta = await (await fetch(`${BASE}/api/v1/meta`, { signal: AbortSignal.timeout(10000) })).json();
  meta.env === 'production' ? ok('meta.env = production') : bad(`meta.env = ${meta.env}`);
} finally {
  srv.kill('SIGKILL');
  try { fs.rmSync(prodCfg, { force: true }); } catch {}
  try { fs.rmSync(svcCfg, { force: true }); } catch {}
  try { fs.rmSync(dbFile, { force: true }); } catch {}
  try { fs.rmSync(anFile, { force: true }); } catch {}
}

console.log(`\n${failed ? R : G}${failed ? `失败 ${failed} 项` : '生产模式支付体验自检全部通过'}${N}`);
process.exit(failed ? 1 : 0);
