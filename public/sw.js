/**
 * SceneGuide Service Worker
 *
 * 存在的理由：Vibe Pay 赛道的交付形态之一是「桌面应用」。
 * 把它做成可安装的 PWA，就能以桌面应用形态被安装到系统，
 * 而不必为 Electron 付出额外的体积与维护成本。
 *
 * 缓存策略：
 *   - 静态资源（html/css/js/图标/数据快照）：stale-while-revalidate —— 离线可看，联网时后台更新
 *   - /api/ 与 /mcp：network-only —— 支付链路绝不能被缓存命中，否则会拿到过期的 402 账单
 */

const VERSION = 'sg-v10';
const STATIC_CACHE = `sceneguide-static-${VERSION}`;

// 相对路径：按 SW 所在目录解析，部署在任意前缀下都成立
const PRECACHE = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './three-scene.js',
  './404.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './data/protocol-trace.json',
  './data/api-reference.json',
  './vendor/three.module.js',
  './vendor/three.core.js',
  './vendor/OrbitControls.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      // 单个资源失败不应让整次安装失败
      .then((cache) => Promise.allSettled(PRECACHE.map((u) => cache.add(u))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== STATIC_CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 支付与数据接口一律走网络，绝不缓存（前缀无关的判定）
  if (url.pathname.includes('/api/') || url.pathname.endsWith('/mcp')) return;

  // 第三方库与图标是不可变资源：缓存优先，命中即用，不浪费往返
  const immutable = /\/vendor\/|\/icon-\d+\.png$|\.woff2?$/.test(url.pathname);

  if (immutable) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req)
          .then((res) => {
            if (res && res.status === 200 && res.type === 'basic') {
              const copy = res.clone();
              caches.open(STATIC_CACHE).then((c) => c.put(req, copy));
            }
            return res;
          })
          .catch(() => cached);
      }),
    );
    return;
  }

  // 应用外壳（HTML / CSS / JS）：网络优先，断网才回退缓存。
  //
  // 为什么不是缓存优先：这是一个**持续迭代中**的参赛作品，评测期间要反复更新。
  // 缓存优先会让老访客拿到上一版的 app.js（实测踩过：新版因为命中旧缓存而根本没上线，
  // 页面直接空白）。网络优先保证「发布即生效」，缓存只作为断网兜底。
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(STATIC_CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req)),
  );
});
