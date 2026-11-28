#!/usr/bin/env node
/**
 * 三维渲染完整性验收（浏览器层）
 *
 * 为什么单独一个脚本：2026-11-21 的 code review 发现两个**现有三套 e2e 都覆盖不到**的
 * 渲染级 bug，都在默认演示路径上：
 *
 *   1. 建筑体块在南北轴上与路网/信标/路线**镜像**（shape 的 y 取负与
 *      rotateX(-90°) 双重取负互相抵消）——楼压在错误位置的道路上；
 *   2. demo-park 场景 graph.nodes 为空 → 相机/雾/取景全 NaN → **3D 整屏黑屏**，
 *      不抛错、无提示，而该场景在场景下拉框里可选。
 *
 * 本脚本用 CDP 驱动无头 Chrome，对**运行中的页面**做数值级断言：
 *   A. 下沙场景：112 栋建筑的几何中心与 footprint 期望位置逐一比对（容差 2m）；
 *   B. demo-park 场景：相机坐标必须有限（NaN 即黑屏）。
 *
 * 用法（需要服务已起）：
 *   node scripts/verify/verify-render.mjs                    # 默认 http://127.0.0.1:3000
 *   BASE_URL=http://121.43.80.231/sceneguide node scripts/verify/verify-render.mjs
 *
 * 依赖：本机 Chrome（/Applications/Google Chrome.app）。软件渲染（swiftshader）
 * 下可跑，约需 30–60 秒。
 */
import { spawn } from 'node:child_process';

const BASE = (process.env.BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

let passed = 0;
let failed = 0;
const ok = (m) => { passed += 1; console.log(`  ${GREEN}✓${RESET} ${m}`); };
const bad = (m) => { failed += 1; console.log(`  ${RED}✗ ${m}${RESET}`); };
const step = (m) => console.log(`\n${CYAN}▸ ${m}${RESET}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const port = 9700 + Math.floor(Math.random() * 200);
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--hide-scrollbars',
    // ⚠️ Chrome 的 HTTPS 自动升级会把 http://<IP> 升级成 https://<IP>，而裸 IP 的 443
    //    没有 TLS → 直接落到 chrome-error://chromewebdata/（实测 2026-11-23）。
    //    禁用该升级后页面正常加载。这是浏览器安全策略，与作品无关，但必须显式关掉，
    //    否则「渲染验收」会误报成产品失败。
    '--disable-features=HttpsUpgrades,HttpsFirstModeV2,HttpsFirstBalancedModeAutoEnable',
    // 独立 profile：避免与正在使用的 Chrome 实例抢默认 profile
    `--user-data-dir=/tmp/sg-verify-render-${port}`,
    '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
    `--remote-debugging-port=${port}`, '--window-size=1440,900', 'about:blank',
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
      target = await res.json();
      break;
    } catch {}
  }
  if (!target) { console.error('无法启动 Chrome'); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const evalJs = async (expr) =>
    (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;

  try {
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: `${BASE}/` });
    await sleep(6500);
    await evalJs(`document.documentElement.style.scrollBehavior='auto'; window.scrollTo(0, 1950)`);
    await sleep(500);
    // 问一条路线，触发三维场景创建
    await evalJs(`document.querySelector('#askBtn').click()`);
    for (let i = 0; i < 120; i++) {
      if (await evalJs(`document.querySelector('.result-lead') !== null`)) break;
      await sleep(500);
    }
    await sleep(5000);

    step('A. 建筑体块与 footprint 对齐（南北轴镜像修复的回归）');
    const align = await evalJs(`(async () => {
      const s = window.__scene3d;
      if (!s) return JSON.stringify({ error: 'no-scene' });
      const res = await fetch('api/v1/scene/zjgsu-xiasha');
      const data = await res.json();
      const nodes = data.graph?.nodes ?? [];
      if (!nodes.length) return JSON.stringify({ error: 'no-nodes' });
      const xs = nodes.map(n => n[0]), ys = nodes.map(n => n[1]);
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
      const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
      const exp = (data.footprints ?? []).filter(f => f.ring?.length >= 3).map(f => {
        const fx = f.ring.map(r => r[0]), fy = f.ring.map(r => r[1]);
        return { name: f.name,
                 x: (Math.min(...fx) + Math.max(...fx)) / 2 - cx,
                 z: -((Math.min(...fy) + Math.max(...fy)) / 2 - cy) };
      });
      let checked = 0, bad = 0, maxErr = 0;
      for (const m of s.buildingGroup.children) {
        if (!m.userData?.name) continue;
        m.geometry.computeBoundingBox();
        const bb = m.geometry.boundingBox;
        const gx = (bb.min.x + bb.max.x) / 2, gz = (bb.min.z + bb.max.z) / 2;
        let best = Infinity;
        for (const e of exp) {
          if (e.name !== m.userData.name) continue;
          best = Math.min(best, Math.hypot(e.x - gx, e.z - gz));
        }
        if (!Number.isFinite(best)) continue;
        checked++;
        maxErr = Math.max(maxErr, best);
        if (best > 2) bad++;
      }
      return JSON.stringify({ checked, bad, maxErr: Math.round(maxErr * 100) / 100 });
    })()`);
    const a = JSON.parse(align ?? '{}');
    if (a.error) bad(`场景检查失败：${a.error}`);
    else if (a.checked >= 100 && a.bad === 0) ok(`下沙场景 ${a.checked} 栋建筑全部对齐 footprint（最大误差 ${a.maxErr}m）`);
    else bad(`建筑对齐异常：${JSON.stringify(a)}`);

    step('B. demo-park 场景三维不黑屏（空 nodes 兜底的回归）');
    await evalJs(`(() => { const sel = document.querySelector('#sceneSel'); if (!sel) return;
      const opt = [...sel.options].find(o => o.value === 'demo-park');
      if (opt) { sel.value = 'demo-park'; sel.dispatchEvent(new Event('change')); } })()`);
    await sleep(9000);
    const cam = await evalJs(`(() => { const s = window.__scene3d; if (!s) return 'no-scene';
      const p = s.camera.position;
      return JSON.stringify({ finite: Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z), x: Math.round(p.x), z: Math.round(p.z) }); })()`);
    if (cam === 'no-scene') bad('demo-park 场景未创建 3D');
    else {
      const c = JSON.parse(cam);
      if (c.finite) ok(`demo-park 相机坐标有限（${c.x}, ${c.z}）——不再 NaN 黑屏`);
      else bad(`demo-park 相机坐标为 NaN：${cam}`);
    }
  } finally {
    ws.close();
    chrome.kill();
  }

  console.log('\n────────────────────────────────────────────────────────');
  if (failed === 0) {
    console.log(`${GREEN}三维渲染完整性全部通过：${passed} 项${RESET}`);
    process.exit(0);
  }
  console.log(`${RED}失败 ${failed} 项 / 通过 ${passed} 项${RESET}`);
  process.exit(1);
}

main().catch((err) => { console.error(`脚本异常：${err.message}`); process.exit(1); });
