import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import compression from 'compression';
import { resolveConfig, resolveSellerId, loadServices } from './config.js';
import { createAlipayClient } from './a2m/client.js';
import { createOrderRepository } from './orders/repository.js';
import { createGuideRouter } from './routes/guide.js';
import { createFeedbackRouter } from './routes/feedback.js';
import { createAccountRouter } from './routes/account.js';
import { createDemoPayer } from './demo/pay.js';
import { createAnalyticsStore } from './analytics/store.js';

const SELLER_NAME = process.env.ALIPAY_SELLER_NAME ?? '三维问路';
const PUBLIC_DIR = path.resolve(import.meta.dirname, '..', 'public');

export function createApp({ config, services, sellerId, repository, alipayClient, demoPayer, analytics }) {
  const app = express();
  app.disable('x-powered-by');
  // 🔴 trust proxy：nginx 反代到 127.0.0.1:3001 后，不设这一项 req.ip 永远是
  //    127.0.0.1——所有 IP 维度的限流（留言 50/日、回复、留资 5/日、免费试看）
  //    会退化成「全站共享一个配额」：第 51 位评委开始所有人 429。
  //    生产前置恰好一跳受信反代，trust proxy = 1 即取 X-Forwarded-For 最后一段
  //    （nginx 的 $proxy_add_x_forwarded_for 追加上去的真实客户端）。
  //    本地直连（无代理头）时 Express 自动回落 socket 地址，行为不变。
  app.set('trust proxy', 1);
  // gzip：three.js 模块约 2MB，压缩后线上传输约 500KB——评委手机打开的体验差距就在这
  app.use(compression({ threshold: 1024 }));
  app.use(express.json());

  /* ── 访客归因中间件 ──
     静态资源不打点；每个访客一个随机 cookie id（不存任何个人信息）；
     首触渠道 ?ref= 落库，归因口径 first touch wins。 */
  const COOKIE = 'sg_vid';
  const readCookie = (req) => {
    for (const part of (req.headers.cookie ?? '').split(';')) {
      const [k, ...rest] = part.trim().split('=');
      if (k === COOKIE) return rest.join('=');
    }
    return null;
  };
  app.use((req, res, next) => {
    const staticPath =
      req.path.startsWith('/vendor') ||
      req.path.startsWith('/assets') ||
      req.path.startsWith('/data') ||
      [
        '/styles.css', '/app.js', '/three-scene.js', '/sw.js', '/manifest.webmanifest',
        '/icon-192.png', '/icon-512.png', '/robots.txt', '/sitemap.xml', '/llms.txt',
      ].includes(req.path);
    if (staticPath) return next();

    let vid = readCookie(req);
    if (!vid) {
      vid = crypto.randomUUID();
      res.setHeader('Set-Cookie', `${COOKIE}=${vid}; Path=/; Max-Age=15552000; HttpOnly; SameSite=Lax`);
    }
    req.visitorId = vid;

    if (analytics) {
      const ref = typeof req.query.ref === 'string' && req.query.ref ? req.query.ref : null;
      const touched = analytics.touchVisitor(vid, ref, req.ip);
      if (!touched.refCode && ref) analytics.bindRef(vid, ref);
      req.visitorRef = touched.refCode ?? ref ?? null;
      if (req.path === '/' || req.path.startsWith('/r/')) {
        analytics.recordEvent(vid, 'visit', req.visitorRef, { path: req.path });
      }
    } else {
      req.visitorRef = null;
    }
    next();
  });

  app.get('/healthz', (req, res) => {
    // 带上两个库的体检结果：部署脚本的健康门只看 HTTP 200，
    // 库损坏时页面照样能开——必须让「数据层坏了」在健康检查里可见。
    const dbStatus = {};
    for (const [name, store] of [['orders', repository], ['analytics', analytics]]) {
      try {
        dbStatus[name] = store.quickCheck?.() ?? 'unknown';
      } catch (err) {
        dbStatus[name] = `error: ${err.message}`;
      }
    }
    res.json({
      ok: true,
      env: config.env,
      gateway: config.gateway,
      appId: config.appId,
      sellerId,
      db: dbStatus,
    });
  });

  /* ── 基线安全响应头 ──
     上线作品的底层卫生：不嵌他站（防点击劫持）、MIME 嗅探防护、
     引用来源最小化、禁用不需要的浏览器能力。CSP 不在此处：
     本站内联脚本/样式较多，贸然上 CSP 容易把站点自己打挂，等 HTTPS 后单独评估。 */
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'SAMEORIGIN');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.set('Cross-Origin-Opener-Policy', 'same-origin');
    next();
  });

  app.use(
    createGuideRouter({
      repository,
      alipayClient,
      config,
      services,
      sellerId,
      sellerName: SELLER_NAME,
      demoPayer,
      analytics,
    }),
  );

  /* 买家账户中心：我的订单 / 权益额度 / 礼品码 / 售后 */
  app.use(createAccountRouter({ repository, analytics }));

  /* ── 社区反馈墙：点赞 / 评论 / 举报 ── */
  app.use(createFeedbackRouter({ analytics }));

  /* ── 渠道短链：/r/:code → /?ref=code（好记、好做二维码）── */
  app.get('/r/:code', (req, res) => {
    const ref = analytics?.getRef(req.params.code);
    if (!ref) return res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html'));
    return res.redirect(302, `/?ref=${encodeURIComponent(req.params.code)}`);
  });

  /* ── 转化漏斗看板 ── */
  app.get('/api/v1/growth', (req, res) => {
    if (!analytics) return res.status(503).json({ code: 'ANALYTICS_DISABLED' });
    return res.json(analytics.funnel(repository.orderStatsByVisitor(), { weekly: repository.orderStatsWeekly() }));
  });

  /* ── 渠道注册（幂等）。生产环境需要 token，沙箱开放 ── */
  app.post('/api/v1/invites', (req, res) => {
    if (config.env !== 'sandbox') {
      const token = req.get('x-invite-token');
      if (!process.env.INVITE_TOKEN || token !== process.env.INVITE_TOKEN) {
        return res.status(403).json({ code: 'FORBIDDEN', message: '生产环境注册渠道需要 x-invite-token' });
      }
    }
    const { code, label } = req.body ?? {};
    if (!code || !label) return res.status(400).json({ code: 'INVALID', message: 'code 与 label 必填' });
    if (!/^[a-z0-9-]{2,32}$/.test(String(code))) {
      return res.status(400).json({ code: 'INVALID', message: 'code 仅允许小写字母/数字/连字符，2–32 位' });
    }
    return res.status(201).json(analytics.ensureRef(String(code), String(label)));
  });

  /* ── 客户端补充事件（如分享点击）── */
  app.post('/api/v1/track', (req, res) => {
    const ALLOWED = new Set(['share', 'upsell_click', 'scene_switch']);
    const { type, meta } = req.body ?? {};
    if (!ALLOWED.has(type)) return res.status(400).json({ code: 'UNKNOWN_EVENT' });
    if (req.visitorId) analytics?.recordEvent(req.visitorId, type, req.visitorRef, meta);
    return res.json({ ok: true });
  });

  // 演示前端。
  // 这个站的 JS 就是作品本体（402 协议、三维场景、实时支付都在里面跑），
  // 所以用 no-cache：浏览器每次都带 ETag 协商（命中就是 304，很便宜），
  // 但永远不会拿到过期版本 —— 改一行代码刷新即生效。
  // 版本号统一在这里改，index.html 与 app.js 里的引用必须一致
  const ASSET_VERSION = process.env.ASSET_VERSION ?? '20261107-live4';

  app.use(
    express.static(PUBLIC_DIR, {
      etag: true,
      lastModified: true,
      setHeaders(res, filePath) {
        // vendor 与图标内容不变，可用不可变缓存；站点自身 JS/CSS/HTML 保持 no-cache
        if (filePath.includes(`${path.sep}vendor${path.sep}`) || /\.(png|jpg|webp|ico|webm)$/.test(filePath)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    }),
  );

  // API 路径返回 JSON 404；页面路径返回风格统一的 404 页
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'no such resource' });
    }
    // 404 页里的资源引用写成绝对路径（/styles.css、/#demo）在**子路径部署**下会全部落空：
    // nginx 把 /sceneguide/ 前缀剥掉后，Node 看到的是 /some/deep/path，而浏览器仍停在
    // 带前缀的地址上——绝对引用会打到宿主机根（线上实测 /styles.css → 404，错误页裸奔）。
    // 因此按请求深度把绝对引用改写成相对引用；文件本身保持默认写法，直接打开也不难看。
    const depth = req.path.split('/').filter(Boolean).length;
    const prefix = '../'.repeat(Math.max(0, depth - 1)) || './';
    let html;
    try {
      html = fs
        .readFileSync(path.join(PUBLIC_DIR, '404.html'), 'utf8')
        .replace(/(href|src)="\/([^"]*)"/g, `$1="${prefix}$2"`);
    } catch {
      // 读不到文件时退回原样发送，至少还是一个 404
      return res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html'));
    }
    res.status(404).type('html').send(html);
  });

  return app;
}

function bootstrap() {
  const config = resolveConfig();
  const services = loadServices({ env: config.env });
  const sellerId = resolveSellerId();
  const repository = createOrderRepository({ file: process.env.ORDER_DB ?? 'data/orders.db' });
  const alipayClient = createAlipayClient(config);
  const demoPayer = createDemoPayer({ config });
  const analytics = createAnalyticsStore({ file: process.env.ANALYTICS_DB ?? 'data/analytics.db' });

  // 种子渠道：config/invites.json 由 scripts/make-invites.mjs 生成
  const invitesFile = path.resolve('config/invites.json');
  if (fs.existsSync(invitesFile)) {
    try {
      for (const { code, label } of JSON.parse(fs.readFileSync(invitesFile, 'utf8'))) {
        analytics.ensureRef(code, label);
      }
    } catch (err) {
      console.warn(`[invites] 种子渠道解析失败：${err.message}`);
    }
  }

  const app = createApp({ config, services, sellerId, repository, alipayClient, demoPayer, analytics });

  const port = Number(process.env.PORT ?? 3000);
  const server = app.listen(port, () => {
    console.log('三维问路 · SceneGuide —— 可被 Agent 自动购买的场景导览服务');
    console.log(`  环境      : ${config.env}`);
    console.log(`  网关      : ${config.gateway}`);
    console.log(`  appId     : ${config.appId}`);
    console.log(`  sellerId  : ${sellerId}`);
    console.log(`  演示前端  : http://localhost:${port}/`);
    console.log(`  付费资源  : GET http://localhost:${port}/api/v1/guide?scene=zjgsu-xiasha&query=...`);
    console.log(`  场景目录  : GET http://localhost:${port}/api/v1/scenes`);
    console.log(`  订单看板  : GET http://localhost:${port}/api/v1/stats`);
    console.log(`  转化漏斗  : GET http://localhost:${port}/api/v1/growth`);
  });

  const shutdown = (signal) => {
    console.log(`\n收到 ${signal}，正在关闭…`);
    server.close(() => {
      repository.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

const isEntry = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntry) bootstrap();

export { bootstrap };
