#!/usr/bin/env node
/**
 * 演示视频自动录制（CDP screencast → ffmpeg）
 *
 * 为什么要有这个脚本（2026-11-23 补记）：11-20 那版视频是用临时目录里的
 * 一次性脚本录的，脚本随 /tmp 清空而丢失；结果 11-23 线上 UI 改过之后
 * 视频里的数字（已支付订单 323）与档位表（3 档）都对不上现网——
 * **提交实物与作品不一致，评委一眼能看出**。所以这次把录制器收进仓库，
 * 以后每次 UI 变更都能一键重录。
 *
 * 做法（沿用 UI审美/README §9.3 记录的经验）：
 *   ① CDP `Page.startScreencast` —— 帧按**真实到达时间**落盘
 *      （不用固定间隔截图：那样会把静态停留段压没）
 *   ② ffmpeg concat：按帧间隔生成 duration 列表，fps=30 重采样成 CFR
 *   ③ 软件渲染（swiftshader）下 3D 的 rAF 长任务会把页面 JS 饿死，
 *      所以**交互环节切 2D 视图**，拿到结果再切 3D 拍 money shot
 *
 * 用法：
 *   node scripts/record-demo.mjs                       # 默认拍线上 https://121.43.80.231/sceneguide
 *   BASE_URL=http://127.0.0.1:3000 node scripts/record-demo.mjs
 *   OUT=提交材料/演示视频-三维问路-SceneGuide-<日期>.mp4 node scripts/record-demo.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const BASE = (process.env.BASE_URL ?? 'https://121.43.80.231/sceneguide').replace(/\/$/, '');
// 文件名统一用 YYYYMMDD（与既有物料命名一致，避免出现两份同内容不同名的视频）
// ⚠️ 用**本地日期**，不是 UTC：本机在 UTC+8，凌晨录的话 toISOString 会给前一天，
//    于是「今天的视频」被命名成昨天——和评审包的命名错位，闸门按文件名挑最新会挑错。
const now = new Date();
const today = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
const OUT = process.env.OUT
  ?? path.resolve(`提交材料/演示视频-三维问路-SceneGuide-${today}.mp4`);
const WORK = process.env.WORK ?? '/tmp/sg-record';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VIEW = { width: 1440, height: 900 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 清理 & 建工作目录 ────────────────────────────────────────────
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(path.join(WORK, 'frames'), { recursive: true });

// ── 启动 Chrome ─────────────────────────────────────────────────
const port = 9720 + Math.floor(Math.random() * 150);
const profile = path.join(WORK, 'profile');
const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--hide-scrollbars',
  '--disable-features=HttpsUpgrades,HttpsFirstModeV2,HttpsFirstBalancedModeAutoEnable',
  `--user-data-dir=${profile}`,
  '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
  `--remote-debugging-port=${port}`, `--window-size=${VIEW.width},${VIEW.height}`, 'about:blank',
], { stdio: 'ignore' });

let target = null;
for (let i = 0; i < 90; i++) {
  await sleep(300);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
    target = await res.json();
    break;
  } catch {}
}
if (!target) { console.error('✗ 无法启动 Chrome'); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });

let msgId = 0;
const pending = new Map();
const frames = [];           // { file, ts }
const consoleErrors = [];
let recording = false;

ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Page.screencastFrame') {
    if (!recording) return;
    const idx = frames.length;
    const file = path.join(WORK, 'frames', String(idx).padStart(4, '0') + '.png');
    fs.writeFileSync(file, Buffer.from(m.params.data, 'base64'));
    frames.push({ file, ts: Date.now() });
    // ack，否则录屏会在 ~10 帧后自动停
    try { ws.send(JSON.stringify({ id: ++msgId, method: 'Page.screencastFrameAck', params: { sessionId: m.params.sessionId } })); } catch {}
  }
  if (m.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(m.params.exceptionDetails?.text ?? 'exception');
  }
};

const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++msgId;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});

const evalJs = async (expr) => {
  const m = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return m.result?.result?.value;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: VIEW.width, height: VIEW.height, deviceScaleFactor: 1, mobile: false });

// ── 打开页面 ────────────────────────────────────────────────────
await send('Page.navigate', { url: `${BASE}/?ref=demo` });
await sleep(9000);
await evalJs(`document.querySelectorAll('.reveal').forEach(e => e.classList.add('in')); window.scrollTo(0,0); true`);
await sleep(1200);

// ── 镜头编排 ────────────────────────────────────────────────────
/** 每个镜头：滚动/点击 + 停留时长；停留时长直接决定成片节奏 */
async function shot(name, ms, action) {
  if (action) await action();
  await sleep(ms);
  process.stdout.write(`  · ${name}\n`);
}

const click = (sel, idx = 0) => evalJs(`(() => {
  const els = [...document.querySelectorAll(${JSON.stringify(sel)})];
  const el = els[${idx}];
  if (!el) return 'notfound';
  el.click();
  return 'clicked';
})()`);

const setQuery = (text) => evalJs(`(() => {
  const q = document.querySelector('#q');
  if (!q) return 'no-input';
  q.value = ${JSON.stringify(text)};
  q.dispatchEvent(new Event('input', { bubbles: true }));
  return 'set';
})()`);

const switchView = (v) => click(`[data-view="${v}"]`);

console.log('▸ 录制镜头：');
await send('Page.startScreencast', { format: 'png', quality: 90, everyNthFrame: 1 });
recording = true;

await shot('1 Hero 真实协议终端', 2600);
await shot('2 滚到演示区', 2200, async () => {
  await evalJs(`document.querySelector('#demo')?.scrollIntoView({block:'start'}); true`);
});
await shot('3 输入问题 → 402 支付挑战', 2600, async () => {
  await setQuery('从A教学楼到C教学楼怎么走');
  await click('#askBtn');
});
await shot('4 一键沙箱支付 → 交付', 6500, async () => {
  await click('#payBtn');
});
await shot('5 切 3D 看发光路线', 3200, async () => {
  await switchView('3d');
});
await shot('6 证据哈希与计量', 2400, async () => {
  await evalJs(`document.querySelector('#result')?.scrollIntoView({block:'center'}); true`);
});
await shot('7 服务档位（含首发半价 ¥4.95）', 2800, async () => {
  // 档位表在演示区右栏（不是商业化区）——滚到面板本体
  await evalJs(`(() => { const p = document.querySelector('#tierPanel');
    if (!p) return 'no-panel';
    window.scrollTo({ top: Math.max(0, p.getBoundingClientRect().top + window.scrollY - 90), behavior: 'instant' });
    return 'ok'; })()`);
});
await shot('8 商业化看板与口径说明', 3000, async () => {
  await evalJs(`document.querySelector('#pricing')?.scrollIntoView({block:'end'}); true`);
});
await shot('9 支付链路真实报文', 2600, async () => {
  await evalJs(`document.querySelector('#protocol')?.scrollIntoView({block:'start'}); true`);
});
await shot('10 交付验收清单', 2600, async () => {
  await evalJs(`document.querySelector('#deliverables')?.scrollIntoView({block:'start'}); true`);
});
await shot('11 社区反馈', 2600, async () => {
  await evalJs(`document.querySelector('#wall')?.scrollIntoView({block:'start'}); true`);
});
await shot('12 官方接口对齐表', 3000, async () => {
  await evalJs(`(() => {
    const el = document.querySelector('#alignPanel');
    if (!el) return 'no-panel';
    window.scrollTo({ top: Math.max(0, el.getBoundingClientRect().top + window.scrollY - 80), behavior: 'instant' });
    return 'ok';
  })()`);
});
await shot('13 我的账户入口', 2400, async () => {
  await evalJs(`document.querySelector('#demo')?.scrollIntoView({block:'start'}); true`);
});

recording = false;
try { await send('Page.stopScreencast'); } catch {}
await sleep(600);

if (frames.length < 10) {
  console.error(`✗ 只录到 ${frames.length} 帧，放弃`);
  ws.close(); chrome.kill(); process.exit(1);
}

// ── 生成 duration 列表（按帧到达间隔）────────────────────────────
const durations = [];
for (let i = 0; i < frames.length; i++) {
  const next = frames[i + 1];
  durations.push(next ? Math.max(0.04, (next.ts - frames[i].ts) / 1000) : 0.2);
}
// ffmpeg concat 清单：每帧一行 file + duration，末帧再补一次（concat 要求重复末帧）
const listPath = path.join(WORK, 'durations.txt');
fs.writeFileSync(
  listPath,
  frames.map((f, i) => `file '${f.file}'\nduration ${durations[i].toFixed(3)}`).join('\n')
    + `\nfile '${frames[frames.length - 1].file}'\n`,
);

// ── ffmpeg 合成 ─────────────────────────────────────────────────
console.log(`▸ 合成 ${frames.length} 帧 → ${OUT}`);
const ff = spawn('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'concat', '-safe', '0', '-i', listPath,
  '-vf', 'fps=30,scale=960:-2',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '23',
  '-movflags', '+faststart', OUT,
], { stdio: 'inherit' });
const ffCode = await new Promise((r) => ff.on('close', r));
ws.close();
chrome.kill();

if (ffCode !== 0) { console.error('✗ ffmpeg 合成失败'); process.exit(1); }
console.log(`✓ 视频已生成：${OUT}（${(fs.statSync(OUT).size / 1048576).toFixed(1)} MB）`);
if (consoleErrors.length) console.log(`  （页面有 ${consoleErrors.length} 条 JS 异常，仅供参考）`);
