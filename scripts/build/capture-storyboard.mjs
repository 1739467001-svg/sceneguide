#!/usr/bin/env node
/**
 * 分镜截图采集（提交物料的 11 张目标画面）
 *
 * 为什么要有这个脚本（2026-11-23 补记）：11-20 那组分镜是旧 UI 拍的，
 * 之后线上改过（服务档位加了「首发半价」¥4.95、首屏数字口径改成
 * 「沙箱实付订单 / 真实付费」、价格口径卡等），**提交实物与现网对不上**。
 * 这次把采集器收进仓库，以后 UI 变更后可一键重采。
 *
 * 用法：
 *   node scripts/build/capture-storyboard.mjs
 *   BASE_URL=http://127.0.0.1:3000 OUT=提交材料/演示分镜 node scripts/build/capture-storyboard.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const BASE = (process.env.BASE_URL ?? 'https://121.43.80.231/sceneguide').replace(/\/$/, '');
const OUT = process.env.OUT ?? path.resolve('提交材料/演示分镜');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VIEW = { width: 1440, height: 900 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

const port = 9640 + Math.floor(Math.random() * 60);
const profile = `/tmp/sg-storyboard-${port}`;
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
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
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
await send('Page.navigate', { url: `${BASE}/?ref=demo` });
await sleep(9000);
await evalJs(`document.querySelectorAll('.reveal').forEach(e => e.classList.add('in')); true`);

/**
 * 断言失败计数。
 *
 * 🔴 为什么需要它（2026-11-27 遍历审查发现）：旧实现里「落点断言未命中」与
 *    「click 返回 notfound」都只 console.log 警告，脚本继续跑完 13 个镜头。
 *    后果实测复现：`演示分镜/` 里 13 个文件只有 **8 张是不同的**——
 *    02–06 五张完全相同、10/11 两张完全相同。点击没生效（或选择器不存在），
 *    后续每个镜头都拍到同一屏 demo 区，而警告混在一堆 ✓ 里根本没人注意。
 *    「13 张分镜」这个数字于是名不副实（作品提交清单里正是这么写的）。
 *    现在：断言未命中计入失败数，最后统一报错并非零退出，让坏采集当场暴露。
 */
let assertionFailures = 0;

async function capture(name, expect = null) {
  await sleep(1400);
  // 落点断言：拍之前先确认页面确实停在预期的内容上
  if (expect) {
    // ⚠️ 只在**目标容器内**匹配：全页文本匹配会被页面别处的同名词命中，
    //    实测「09 渠道转化看板」曾因此被判为落点正确、实际拍到了上一屏。
    const scopeSel = JSON.stringify(expect.scope ?? 'body');
    const keys = JSON.stringify(expect.keys ?? expect);
    const hit = await evalJs(`(() => {
      const scope = document.querySelector(${scopeSel});
      if (!scope) return JSON.stringify({ hit: false, y: Math.round(window.scrollY), noScope: true });
      const t = scope.innerText;
      const hit = ${keys}.split('|').some(k => t.indexOf(k) >= 0);
      return JSON.stringify({ hit, y: Math.round(window.scrollY) });
    })()`);
    const info = typeof hit === 'string' ? JSON.parse(hit) : hit;
    const want = (expect.keys ?? expect);
    if (!info?.hit) {
      assertionFailures += 1;
      console.log(
        `  ✗ ${name}: 落点断言未命中（scrollY=${info?.y}，期望含「${want}」` +
        `${info?.noScope ? `，且容器 ${expect.scope} 不存在——选择器可能已过期` : ''}）`,
      );
    }
  }
  const msg = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  // CDP 返回结构：msg.result.data（不是 msg.result.result.data）
  const data = msg?.result?.data;
  if (!data) { console.log(`  ✗ ${name}: 截图失败（${JSON.stringify(msg).slice(0, 160)}）`); return; }
  const file = path.join(OUT, name + '.png');
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`  ✓ ${name}.png`);
}

/**
 * 滚动到目标锚点。
 * ⚠️ 不能只用 scrollIntoView：站点的 reveal 动画会在滚动后重排布局，
 *    实测出现过「滚到 #pricing 后又回到首屏」——素材静默拍错位置。
 *    这里直接按 offsetTop 设置 scrollTop，并**返回实际 scrollY 供断言**。
 */
const scrollTo = (sel, offset = -70) => evalJs(
  `(() => { const el = document.querySelector(${JSON.stringify(sel)});`
  + ` if (!el) return 'no-el';`
  + ` const top = el.getBoundingClientRect().top + window.scrollY + ${offset};`
  + ` window.scrollTo({ top: Math.max(0, top), behavior: 'instant' });`
  + ` return Math.round(window.scrollY); })()`,
);
const click = (sel, idx = 0) => evalJs(`(() => {
  const els = [...document.querySelectorAll(${JSON.stringify(sel)})];
  const el = els[${idx}];
  if (!el) return 'notfound';
  el.click(); return 'clicked';
})()`);

/**
 * 点击并校验结果。目标不存在时**先等它出现**（默认最多 12s）再判失败。
 *
 * 🔴 为什么不能当场查一次就放弃（2026-11-28 实测踩到）：对线上站点采集时，
 *    模式切换后的挑战面板要走一次 HTTPS 往返 + 渲染才挂上 #payBtn——
 *    旧实现 sleep(1200) 后当场查一次，慢渲染被误判成「选择器不存在」，
 *    镜头 06 起全部拍成重复画面。等待超时仍没有才算真失败
 *    （真失败依旧计数拦截，不产出不可信物料——2026-11-27 的设计保留）。
 */
async function clickOrFail(sel, idx = 0, waitMs = 12000) {
  const deadline = Date.now() + waitMs;
  let r = await click(sel, idx);
  while (r !== 'clicked' && Date.now() < deadline) {
    await sleep(500);
    r = await click(sel, idx);
  }
  if (r !== 'clicked') {
    assertionFailures += 1;
    console.log(`  ✗ click(${sel}) 返回 ${r} —— 等待 ${waitMs}ms 后选择器仍不存在，后续镜头会重复`);
  }
  return r;
}
const setQuery = (text) => evalJs(`(() => {
  const q = document.querySelector('#q');
  if (!q) return 'no-input';
  q.value = ${JSON.stringify(text)};
  q.dispatchEvent(new Event('input', { bubbles: true }));
  return 'set';
})()`);

console.log('▸ 采集分镜：');
await scrollTo('#top', 'start');
await evalJs(`window.scrollTo(0,0); true`);
await capture('01-Hero-真实协议终端', '三维问路|真实协议终端');

await scrollTo('#demo');
await capture('02-演示区-402支付挑战', '查询路线|免费试看');

await setQuery('从A教学楼到C教学楼怎么走');
await clickOrFail('#askBtn');
await sleep(2500);
await capture('03-支付完成-三维实测路线', '全程约|实测步道|证据哈希');

await clickOrFail('#previewBtn');
await sleep(2500);
await capture('04-免费试看-转化冷启动', '试看|解锁');

await clickOrFail('[data-mode="quest"]');
// 🔴 切模式只改 UI 文案，不会自动发起挑战——必须点「生成任务」拿到 402，
//    否则 #payBtn 根本不存在（2026-11-28 实测：05 一直匹配的是模式提示文案，
//    假绿；#payBtn notfound）。断言也收紧到挑战面板本体，避免再被提示文案骗过。
await clickOrFail('#askBtn');
await sleep(3000);
await capture('05-研学任务-线索链与402', '付费资源|Payment-Needed');

await clickOrFail('#payBtn');
await sleep(7000);
await capture('06-任务进行中-打卡进度', '打卡|进度');

await scrollTo('#deliverables');
await capture('07-全部打卡完成-可核验证书', '证书|可核验');

await scrollTo('#protocol');
await capture('08-支付链路-真实报文', 'Payment-Needed|402');

await scrollTo('#funnelTable');
await capture('09-渠道转化看板-反刷量口径', { scope: '#funnelTable', keys: '访客|付费|转化率' });

await scrollTo('#demo');
await capture('10-我的账户-额度与转赠', '我的账户|权益额度');

await scrollTo('#pricing', 'end');
await capture('11-机构采购-B端入口', '采购|团体|机构');

// 13 官方接口对齐表——把「用了支付宝哪些官方接口」摆在台面上
await evalJs(`(() => {
  const t = [...document.querySelectorAll('.panel-title')].find(x => /对齐/.test(x.textContent || ''));
  const el = t ? t.closest('.panel') : null;
  if (!el) return 'no-panel';
  window.scrollTo({ top: Math.max(0, el.getBoundingClientRect().top + window.scrollY - 80), behavior: 'instant' });
  return 'ok';
})()`);
await capture('13-官方接口对齐表', { scope: '#alignPanel', keys: 'precreate' });

// 12 服务档位（四档，含首发半价）——在演示区右栏，不在商业化区
await evalJs(`(() => { const p = [...document.querySelectorAll('.panel')]
  .find(x => /服务档位/.test(x.textContent || ''));
  if (!p) return 'no-panel';
  window.scrollTo({ top: Math.max(0, p.getBoundingClientRect().top + window.scrollY - 90), behavior: 'instant' });
  return 'ok'; })()`);
await capture('12-服务档位-四档含首发半价', { scope: '#tierPanel', keys: '首发半价|¥4.95' });

ws.close();
chrome.kill();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
console.log(`✓ 分镜已更新：${OUT}`);
// 有断言/点击失败就非零退出：让「13 张分镜其实只有 8 张不同」这类
// 静默劣化在采集当场暴露，而不是等到评委对照脚本才发现（2026-11-27 修复）。
if (assertionFailures > 0) {
  console.log(`
✗ 本次采集有 ${assertionFailures} 处断言/点击失败，分镜内容不可信。
  请按上面的 ✗ 行修复选择器或站点状态后重跑；不要直接拿这批图当提交物料。`);
  process.exit(1);
}
process.exit(0);
