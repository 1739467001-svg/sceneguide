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
import { createDemoPayer } from './demo/pay.js';
import { createAnalyticsStore } from './analytics/store.js';

const SELLER_NAME = process.env.ALIPAY_SELLER_NAME ?? '三维问路';
const PUBLIC_DIR = path.resolve(import.meta.dirname, '..', 'public');

export function createApp({ config, services, sellerId, repository, alipayClient, demoPayer, analytics }) {
  const app = express();
  app.disable('x-powered-by');
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
    res.json({
      ok: true,
      env: config.env,
      gateway: config.gateway,
      appId: config.appId,
      sellerId,
    });
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
    return res.json(analytics.funnel(repository.orderStatsByVisitor()));
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
    res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html'));
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
