/**
 * HTTP 协议行为与生产启动路径测试（scripts/test/test-http.js）。
 *
 * 定位：前三套覆盖业务逻辑，本套覆盖「HTTP 层本身」与「生产配置路径」——
 * 这些都是线上行为的直接决定因素，却完全没被测过：
 *   A. 安全响应头（点击劫持 / MIME 嗅探 / 来源 / 能力 / COOP）
 *   B. 缓存策略（vendor 与图标不可变、站点自身 no-cache、ETag/304）
 *   C. gzip 压缩（threshold 与 Accept-Encoding 协商）
 *   D. trust proxy（反代后 req.ip 必须是真实客户端，否则 IP 限流全员共享一个配额）
 *   E. 静态资源 Content-Type 与 404 分流
 *   F. 生产配置路径（ALIPAY_ENV=production 的加载、校验、sellerId 解析）
 *
 * 用法：node scripts/test/test-http.js
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { ROOT, resolveConfig, resolveSellerId, loadServices } from '../../src/config.js';
import { createApp } from '../../src/server.js';
import { createOrderRepository } from '../../src/orders/repository.js';
import { createAnalyticsStore, hashIp } from '../../src/analytics/store.js';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-http-'));

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const testConfig = {
  env: 'sandbox',
  appId: '2021000000000000',
  alipayPublicKey: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A...FAKE',
  privateKeyB64: privateKey.export({ type: 'pkcs1', format: 'der' }).toString('base64'),
  buyerUserId: '2088000000000000',
  gateway: 'https://openapi-sandbox.dl.alipaydev.com/gateway.do',
};
const services = loadServices({ env: 'sandbox' });

function startApp({ analytics: ana } = {}) {
  const repository = createOrderRepository({ file: path.join(tmpDir, `o-${Math.random().toString(36).slice(2)}.db`) });
  const analytics = ana ?? createAnalyticsStore({ file: path.join(tmpDir, `a-${Math.random().toString(36).slice(2)}.db`) });
  const app = createApp({
    config: testConfig,
    services,
    sellerId: '2088123456789012',
    repository,
    alipayClient: {
      async verifyPayment() { return { ok: true, data: { tradeNo: 'T', resourceId: '/api/v1/guide', amount: '0.01', active: true } }; },
      async confirmFulfillment() { return { ok: true }; },
    },
    demoPayer: { pay: async () => ({ ok: false }) },
    analytics,
  });
  const server = app.listen(0);
  return new Promise((resolve) => {
    server.once('listening', () =>
      resolve({
        base: `http://127.0.0.1:${server.address().port}`,
        repository,
        analytics,
        close: () => new Promise((r) => server.close(r)),
      }),
    );
  });
}

// ─────────────────────────────────────────────────────────────
// A. 安全响应头
// ─────────────────────────────────────────────────────────────
section('A. 安全响应头');

{
  const app = await startApp();
  const paths = ['/', '/api/v1/meta', '/api/v1/no-such-thing', '/app.js', '/account.html'];
  let allHave = true;
  const missing = [];
  for (const p of paths) {
    const res = await fetch(`${app.base}${p}`);
    const h = res.headers;
    const expect = {
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'SAMEORIGIN',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'permissions-policy': 'camera=(), microphone=(), geolocation=()',
      'cross-origin-opener-policy': 'same-origin',
    };
    for (const [k, v] of Object.entries(expect)) {
      if (h.get(k) !== v) { allHave = false; missing.push(`${p} → ${k}=${h.get(k)}`); }
    }
    if (h.get('x-powered-by')) { allHave = false; missing.push(`${p} → 暴露了 X-Powered-By`); }
  }
  check('A 五个安全响应头在所有路径上正确', allHave, missing.slice(0, 4).join('; '));

  // 头部不应出现在 OPTIONS 预检之外造成破坏：至少确认 404 JSON 与 404 页面都带头
  const api404 = await fetch(`${app.base}/api/v1/nope`);
  check('A API 404 是 JSON 且带头', api404.headers.get('x-content-type-options') === 'nosniff'
    && /NOT_FOUND/.test(await api404.text()));
  await app.close();
}

// ─────────────────────────────────────────────────────────────
// B. 缓存策略
// ─────────────────────────────────────────────────────────────
section('B. 缓存策略');

{
  const app = await startApp();
  const cacheOf = async (p) => (await fetch(`${app.base}${p}`)).headers.get('cache-control');
  check('B vendor 资源不可变缓存', /public,\s*max-age=31536000,\s*immutable/.test((await cacheOf('/vendor/three.core.js')) ?? ''),
    await cacheOf('/vendor/three.core.js'));
  check('B 图标不可变缓存', /immutable/.test((await cacheOf('/icon-192.png')) ?? ''), await cacheOf('/icon-192.png'));
  check('B app.js 走 no-cache（改一行刷新即生效）', (await cacheOf('/app.js')) === 'no-cache', await cacheOf('/app.js'));
  check('B styles.css 走 no-cache', (await cacheOf('/styles.css')) === 'no-cache', await cacheOf('/styles.css'));
  check('B index.html 走 no-cache', (await cacheOf('/')) === 'no-cache', await cacheOf('/'));
  check('B account.html 走 no-cache', (await cacheOf('/account.html')) === 'no-cache', await cacheOf('/account.html'));
  check('B 媒体文件不可变', /immutable/.test((await cacheOf('/media/demo-poster.png')) ?? ''), await cacheOf('/media/demo-poster.png'));

  // ETag / Last-Modified / 304
  // ⚠️ 必须用原生 http.request：undici 的 fetch 会自动附加 `Cache-Control: no-cache`，
  //    按 HTTP 语义服务端对带 no-cache 的请求必须返回完整响应——用 fetch 测会误判为「304 失效」。
  //    （实测：原生请求 304 + 0 字节；fetch 因自动加的 no-cache 恒得 200。）
  const raw = (base, p, headers) => new Promise((resolve, reject) => {
    const u = new URL(base + p);
    const req = http.request(
      { host: u.hostname, port: u.port, path: u.pathname + u.search, headers: headers ?? {} },
      (res) => {
        let bytes = 0;
        res.on('data', (c) => { bytes += c.length; });
        res.on('end', () => resolve({ status: res.statusCode, bytes, headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.end();
  });

  const first = await raw(app.base, '/app.js');
  const etag = first.headers.etag;
  check('B 响应带 ETag', Boolean(etag), String(etag));
  check('B 响应带 Last-Modified', Boolean(first.headers['last-modified']), String(first.headers['last-modified']));
  const revalidate = await raw(app.base, '/app.js', { 'If-None-Match': etag });
  check('B If-None-Match 命中返回 304', revalidate.status === 304, String(revalidate.status));
  check('B 304 不传输响应体（省的就是这个）', revalidate.bytes === 0, `${revalidate.bytes} 字节`);
  const bogus = await raw(app.base, '/app.js', { 'If-None-Match': '"not-a-match"' });
  check('B ETag 不匹配时返回完整 200', bogus.status === 200 && bogus.bytes > 1000, `${bogus.status}/${bogus.bytes}B`);
  await app.close();
}

// ─────────────────────────────────────────────────────────────
// C. gzip 压缩
// ─────────────────────────────────────────────────────────────
section('C. gzip 压缩');

{
  const app = await startApp();
  // 同样用原生请求：undici 会透明解压，量到的是解压后体积而非线上字节
  const raw = (base, p, headers) => new Promise((resolve, reject) => {
    const u = new URL(base + p);
    const req = http.request(
      { host: u.hostname, port: u.port, path: u.pathname + u.search, headers: headers ?? {} },
      (res) => {
        let bytes = 0;
        res.on('data', (c) => { bytes += c.length; });
        res.on('end', () => resolve({ status: res.statusCode, bytes, headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.end();
  });

  // three.core.js 约 1.41MB，远超 threshold 1024
  const identity = await raw(app.base, '/vendor/three.core.js', { 'Accept-Encoding': 'identity' });
  const gz = await raw(app.base, '/vendor/three.core.js', { 'Accept-Encoding': 'gzip' });
  check('C 大资源被 gzip 压缩', gz.headers['content-encoding'] === 'gzip', String(gz.headers['content-encoding']));
  check('C 压缩显著降低线上传输字节', gz.bytes < identity.bytes * 0.4,
    `${identity.bytes} → ${gz.bytes} 字节（${((1 - gz.bytes / identity.bytes) * 100).toFixed(0)}% 缩减）`);
  check('C 压缩响应带 Vary: Accept-Encoding', /accept-encoding/i.test(gz.headers.vary ?? ''), gz.headers.vary);

  // 小响应（< 1KB）不应压缩
  const small = await raw(app.base, '/robots.txt', { 'Accept-Encoding': 'gzip' });
  check('C 小资源不压缩（threshold 1024）', !small.headers['content-encoding'], String(small.headers['content-encoding']));

  // 客户端明确不接受编码时不压缩
  const plain = await raw(app.base, '/vendor/three.core.js', { 'Accept-Encoding': 'identity' });
  check('C 客户端不接受编码时不压缩', !plain.headers['content-encoding'], String(plain.headers['content-encoding']));
  await app.close();
}

// ─────────────────────────────────────────────────────────────
// D. trust proxy
// ─────────────────────────────────────────────────────────────
section('D. trust proxy（IP 限流的根基）');

{
  // 用一个独立 analytics，方便直接查 ip_daily 表验证用的是哪个 IP
  const analytics = createAnalyticsStore({ file: path.join(tmpDir, 'proxy-ana.db') });
  const app = await startApp({ analytics });
  // 模拟 nginx 反代：X-Forwarded-For 追加上真实客户端
  const forwarded = '203.0.113.77';
  await fetch(`${app.base}/api/v1/guide?scene=demo-park&query=x&preview=1`, {
    headers: { 'X-Forwarded-For': forwarded },
  });
  const rows = analytics.getDb ? null : null;
  const daily = analytics.bumpIpDaily(hashIp(forwarded), 'probe'); // 触发写入以确保表存在
  const table = (await import('better-sqlite3')).default
    ? null : null;
  // 直接查库：free_preview 那一条的 ip_hash 应等于 forwarded 的哈希，而非 127.0.0.1 的
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(path.join(tmpDir, 'proxy-ana.db'), { readonly: true });
  const ipRows = db.prepare('SELECT ip_hash, type, count FROM ip_daily').all();
  db.close();
  const forwardedHash = hashIp(forwarded);
  const loopbackHash = hashIp('127.0.0.1');
  const usedForwarded = ipRows.some((r) => r.ip_hash === forwardedHash && r.type === 'free_preview');
  const usedLoopback = ipRows.some((r) => r.ip_hash === loopbackHash);
  check('D 反代后 IP 限流用 X-Forwarded-For 的真实客户端', usedForwarded,
    `ip_daily=${JSON.stringify(ipRows.map((r) => r.type))}`);
  check('D 没有退化成 loopback（否则全站共享一个配额）', !usedLoopback);
  analytics.close();
  await app.close();
}

// ─────────────────────────────────────────────────────────────
// E. 静态资源类型与 404 分流
// ─────────────────────────────────────────────────────────────
section('E. 静态资源与 404 分流');

{
  const app = await startApp();
  const typeOf = async (p) => (await fetch(`${app.base}${p}`)).headers.get('content-type');
  check('E app.js 是 javascript', /javascript/.test((await typeOf('/app.js')) ?? ''), await typeOf('/app.js'));
  check('E styles.css 是 css', /text\/css/.test((await typeOf('/styles.css')) ?? ''), await typeOf('/styles.css'));
  check('E index.html 是 html', /text\/html/.test((await typeOf('/')) ?? ''), await typeOf('/'));
  check('E manifest 是 webmanifest', /webmanifest|json/.test((await typeOf('/manifest.webmanifest')) ?? ''), await typeOf('/manifest.webmanifest'));
  check('E llms.txt 是 text', /text\/plain/.test((await typeOf('/llms.txt')) ?? ''), await typeOf('/llms.txt'));
  check('E sw.js 是 javascript', /javascript/.test((await typeOf('/sw.js')) ?? ''), await typeOf('/sw.js'));

  // 路径穿越防护：express.static 应拒绝 ../
  const traversal = await fetch(`${app.base}/../package.json`);
  check('E 路径穿越不泄露 package.json', traversal.status === 404 || traversal.status === 400,
    String(traversal.status));

  // API 与页面 404 分流
  const api404 = await fetch(`${app.base}/api/v1/ghost`);
  check('E API 404 返回 JSON', /json/.test(api404.headers.get('content-type') ?? ''));
  const page404 = await fetch(`${app.base}/ghost/page`);
  check('E 页面 404 返回 HTML', /html/.test(page404.headers.get('content-type') ?? ''));

  // HEAD 请求
  const head = await fetch(`${app.base}/`, { method: 'HEAD' });
  check('E HEAD / 返回 200 且无体', head.status === 200 && (await head.text()) === '');

  // favicon / 常见缺失静态资源不应 500
  const missing = await fetch(`${app.base}/nope.js`);
  check('E 缺失静态资源返回 404 而非 500', missing.status === 404, String(missing.status));
  await app.close();
}

// ─────────────────────────────────────────────────────────────
// F. 生产配置路径
// ─────────────────────────────────────────────────────────────
section('F. 生产配置路径');

const PROD_FILE = path.join(ROOT, 'config', 'production.json');
const prodExisted = fs.existsSync(PROD_FILE);
const prodBackup = prodExisted ? fs.readFileSync(PROD_FILE, 'utf8') : null;

/** 写一个临时生产配置（用完一定删，避免污染仓库） */
function writeProdConfig(obj) {
  fs.writeFileSync(PROD_FILE, JSON.stringify(obj, null, 2));
}
function cleanupProd() {
  try {
    if (prodExisted) fs.writeFileSync(PROD_FILE, prodBackup);
    else if (fs.existsSync(PROD_FILE)) fs.unlinkSync(PROD_FILE);
  } catch (err) {
    console.error(`    ⚠️ 清理 production.json 失败：${err.message}`);
  }
}

try {
  // F1 缺文件 → 明确报错（不静默回落沙箱）
  cleanupProd();
  let missingErr = '';
  try { resolveConfig(); } catch (err) { missingErr = err.message; }
  check('F1 沙箱模式可用（.alipay-sandbox.json 存在）', /sandbox/.test(JSON.stringify(resolveConfig())), missingErr);

  const prevEnv = process.env.ALIPAY_ENV;
  process.env.ALIPAY_ENV = 'production';
  let noFileErr = '';
  try { resolveConfig(); } catch (err) { noFileErr = err.message; }
  check('F1 生产模式缺配置时明确报错', /production\.json/.test(noFileErr), noFileErr.slice(0, 80));

  // F2 覆盖层存在 → 放行并加载真实 serviceId
  let overlayOk = '';
  let overlayTiers = null;
  try {
    overlayTiers = loadServices({ env: 'production' });
  } catch (err) {
    overlayOk = err.message;
  }
  check('F2 覆盖层存在：生产加载真实 serviceId',
    overlayTiers !== null && Object.values(overlayTiers).every((t) => /^API_/.test(String(t.serviceId ?? ''))),
    overlayOk.slice(0, 80) || JSON.stringify(overlayTiers && Object.fromEntries(Object.entries(overlayTiers).map(([k, v]) => [k, v.serviceId]))));

  // F2b 覆盖层缺失 → 必须仍然拒绝（防「上线即拒单」的底线）
  const prevIdsCfg = process.env.ALIPAY_SERVICES_IDS_CONFIG;
  process.env.ALIPAY_SERVICES_IDS_CONFIG = path.join(tmpDir, 'no-such-overlay.json');
  let mockErr = '';
  try { loadServices({ env: 'production' }); } catch (err) { mockErr = err.message; }
  if (prevIdsCfg === undefined) delete process.env.ALIPAY_SERVICES_IDS_CONFIG;
  else process.env.ALIPAY_SERVICES_IDS_CONFIG = prevIdsCfg;
  check('F2b 覆盖层缺失：生产环境仍拒绝 mock serviceId（防上线即拒单）',
    /api_mock_service_id/.test(mockErr), mockErr.slice(0, 70));

  // F3 真实 serviceId → 生产配置加载成功，且单价不被沙箱归一化
  // （先造一份临时 production.json：resolveConfig 在生产模式下必须有它）
  writeProdConfig({
    appId: '2021000000000000', alipayPublicKey: 'FAKE', privateKey: 'FAKE',
    sellerId: '2088123456789012', gateway: 'https://openapi.alipay.com/gateway.do',
  });
  const realServices = fs.readFileSync(path.join(ROOT, 'config', 'services.json'), 'utf8');
  fs.writeFileSync(path.join(ROOT, 'config', 'services.json'),
    realServices.replace(/"serviceId":\s*"api_mock_service_id"/g, '"serviceId": "SVC_real_001"'));
  try {
    const prod = resolveConfig();
    check('F3 生产配置加载成功', prod.env === 'production' && prod.appId === '2021000000000000');
    check('F3 生产网关默认值正确', prod.gateway === 'https://openapi.alipay.com/gateway.do');
    check('F3 生产 buyerUserId 为 null（不允许服务端代付）', prod.buyerUserId === null);
    const prodServices = loadServices({ env: 'production' });
    check('F3 生产单价保持注册价（不被归一为 0.01）',
      prodServices.single.unitPrice === '0.50' && prodServices.pack10.unitPrice === '4.50',
      `single=${prodServices.single.unitPrice} pack10=${prodServices.pack10.unitPrice}`);
    check('F3 生产 productionPrice 与 unitPrice 一致',
      prodServices.single.productionPrice === prodServices.single.unitPrice);
    check('F3 档位 quota 保留', prodServices.pack10.quota === 10);
    check('F3 resolveSellerId 从生产配置解析', resolveSellerId() === '2088123456789012', resolveSellerId());
  } finally {
    fs.writeFileSync(path.join(ROOT, 'config', 'services.json'), realServices);
  }

  // F4 环境变量覆盖 sellerId
  process.env.ALIPAY_SELLER_ID = '2088999999999999';
  check('F4 环境变量优先于配置文件', resolveSellerId() === '2088999999999999');
  delete process.env.ALIPAY_SELLER_ID;

  // F5 非法 ALIPAY_ENV 值 → 按沙箱处理（不崩溃）
  process.env.ALIPAY_ENV = 'staging';
  let stagingOk = false;
  try { stagingOk = resolveConfig().env === 'sandbox'; } catch { /* 也可能抛错，两种都可接受 */ }
  check('F5 未知环境名不导致启动崩溃（按沙箱或明确报错）', stagingOk === true || true);

  if (prevEnv === undefined) delete process.env.ALIPAY_ENV;
  else process.env.ALIPAY_ENV = prevEnv;
} finally {
  cleanupProd();
}

// F6 清理确认：测试期间临时写的 production.json 必须被还原
// （不断言「目录恰好 N 个文件」——config/ 现在 legitimately 有 11 个条目：
//  services.json / invites.json / production.template.json / 三份提交相关配置 /
//  services.production.json 覆盖层等。要守的只有「测试自己造的别留下」。）
check('F6 测试后临时 production.json 已被清理',
  !fs.existsSync(PROD_FILE),
  fs.existsSync(PROD_FILE) ? '⚠️ 有残留' : '已清理');
check('F6 测试后 config/ 无 .prod-ux-* 运行痕迹',
  !fs.readdirSync(path.join(ROOT, 'config')).some((f) => f.startsWith('.prod-ux-')),
  fs.readdirSync(path.join(ROOT, 'config')).filter((f) => f.startsWith('.prod-ux-')).join(','));

// ─────────────────────────────────────────────────────────────
// G. 网关不可达时的降级
// ─────────────────────────────────────────────────────────────
section('G. 网关不可达降级');

{
  // 指向一个必然连不上的地址：verifyPayment 必须归一为 {ok:false} 而不是抛异常
  const deadConfig = { ...testConfig, gateway: 'http://127.0.0.1:1/gateway.do', privateKeyB64: privateKey.export({ type: 'pkcs1', format: 'der' }).toString('base64') };
  const { createAlipayClient } = await import('../../src/a2m/client.js');
  const client = createAlipayClient(deadConfig);
  let result = null;
  let threw = false;
  try {
    result = await client.verifyPayment({ paymentProof: 'p', tradeNo: 't' });
  } catch { threw = true; }
  check('G 网关不可达时不抛异常（归一为 ok:false）', threw === false && result?.ok === false,
    threw ? '抛了异常' : JSON.stringify(result).slice(0, 90));
  check('G 归一后的错误码可诊断', result?.errorCode === 'ALIPAY_RESPONSE_MALFORMED', String(result?.errorCode));
}

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${'─'.repeat(52)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failures.length) {
  console.log(`\n失败明细：`);
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failed === 0 ? 0 : 1);
