#!/usr/bin/env node
/**
 * 冷评委路径验收（judge-flow）
 *
 * 模拟一个**从未访问过**该站的评委，用全新浏览器 profile 走完整条路径：
 *
 * 🔴 关于「冷访客」的一处修正（2026-11-27）：
 *   旧实现强调「无任何 cookie」，本意是模拟真实冷访客。但副作用是：
 *   每一跑都生成一个**新的 visitor_id**，于是仓储层按 visitor_id 前缀的
 *   自测排除（mcp-e2e-% / acct-% / verify-% …）全部落空——
 *   我们自己的验收订单被计入「真实付费用户数」，站点把这个数字展示给评委。
 *   （2026-11-27 实测：线上 paidReal=33，逐笔查下来 100% 是本脚本与
 *     official-buyer-check.sh 自己造的，33 个互不相同的访客、每人 1 笔、全 ¥0.01。）
 *   ⇒ 「冷」指的是**状态**（没有订单、没有额度、没有权益），不是**匿名**。
 *     现在带 `sg_vid=judge-cold-<ts>` cookie：依然是全新访客，但身份可识别、
 *     可被自测口径排除。
 *   落地页 → 输入问题 → 得到 402 支付挑战 → 一键支付 → 拿到导览结果
 *   → 生成核验卡 → 我的账户（订单/额度）→ 反馈墙留言
 *
 * 为什么单独写：验收套件里的 76 项是「接口级」断言，
 * 而评委看到的是「页面级」体验——两者可能同时一个绿一个断。
 * 这条路径就是提交表单「如何获取作品」里承诺的那 7 步。
 *
 * 用法：BASE_URL=https://121.43.80.231/sceneguide node scripts/judge-flow.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const BASE = (process.env.BASE_URL ?? 'https://121.43.80.231/sceneguide').replace(/\/$/, '');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const G = '\x1b[32m', R = '\x1b[31m', C = '\x1b[36m', N = '\x1b[0m';
let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  ${G}✓${N} ${m}`); };
const bad = (m) => { fail++; console.log(`  ${R}✗ ${m}${N}`); };
const step = (m) => console.log(`\n${C}▸ ${m}${N}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const port = 9800 + Math.floor(Math.random() * 150);
const profile = `/tmp/sg-judge-profile-${port}`;
const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--hide-scrollbars',
  '--disable-features=HttpsUpgrades,HttpsFirstModeV2,HttpsFirstBalancedModeAutoEnable',
  `--user-data-dir=${profile}`,
  '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
  `--remote-debugging-port=${port}`, '--window-size=1440,900', 'about:blank',
], { stdio: 'ignore' });

let target = null;
for (let i = 0; i < 80; i++) {
  await sleep(300);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
    target = await res.json();
    break;
  } catch {}
}
if (!target) { console.error('无法启动 Chrome'); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let msgId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params) => new Promise((resolve) => {
  const id = ++msgId;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});
const evalJs = async (expr, timeout = 15000) => {
  const m = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (m.result?.exceptionDetails) return { __err: m.result.exceptionDetails.text };
  return m.result?.result?.value;
};

// 🔴 冷访客的身份标记：让本脚本产生的订单能被自测口径排除（见文件头说明）。
//    必须放在 send/evalJs 定义**之后**——send 是 const，提前调用会撞 TDZ。
//    不带它，每一跑都是一个「查不出身份」的新访客，真实付费数就被自己的验收抬高了。
const JUDGE_VISITOR = `judge-cold-${Date.now().toString(36)}`;
await send('Network.enable');
await send('Network.setCookie', {
  name: 'sg_vid', value: JUDGE_VISITOR,
  domain: new URL(BASE).hostname, path: '/', secure: true,
});

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: BASE + '/' });
await sleep(9000);

step('1. 落地页');
const landing = await evalJs(`JSON.stringify({
  title: document.title,
  hasCanvas: !!document.querySelector('#map3d,#map'),
  scene3d: !!window.__scene3d,
  bodyLen: document.body.innerText.length,
  secure: window.isSecureContext,
  sw: !!navigator.serviceWorker?.controller,
  links: [...document.querySelectorAll('a')].map(a=>a.textContent.replace(/\\s+/g,' ').trim()).filter(Boolean).slice(0,14),
})`);
const L = JSON.parse(landing);
L.title?.includes('三维问路') ? ok(`标题正确：${L.title.slice(0, 46)}…`) : bad(`标题异常：${L.title}`);
L.hasCanvas ? ok('演示画布已渲染') : bad('演示画布缺失');
L.secure ? ok('安全上下文成立（HTTPS 生效，Service Worker 可注册）') : bad('非安全上下文');
L.bodyLen > 2000 ? ok(`页面内容完整（${L.bodyLen} 字符）`) : bad(`页面内容过短（${L.bodyLen}）`);
console.log(`      可见入口：${L.links?.slice(0, 8).join(' / ')}`);

step('2. 提问 → 402 支付挑战（冷访客，无任何 cookie）');
const challenged = await evalJs(`(async () => {
  const q = document.querySelector('#q');
  const btn = document.querySelector('#askBtn');
  if (!q || !btn) return JSON.stringify({ error: 'no-input' });
  q.value = '从A教学楼到C教学楼怎么走';
  q.dispatchEvent(new Event('input', { bubbles: true }));
  btn.click();
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    await new Promise(r => setTimeout(r, 400));
    const txt = document.body.innerText;
    if (/402|需要支付|Payment-Needed/.test(txt)) {
      return JSON.stringify({
        got402: true,
        hasAmount: /0\\.01|0\\.50|¥/.test(txt),
        mentions: (txt.match(/402[^\\n]{0,40}/) || [''])[0].slice(0, 60),
        elapsed: Date.now() - t0,
      });
    }
  }
  return JSON.stringify({ got402: false, snippet: document.body.innerText.slice(0, 200) });
})()`);
const C2 = JSON.parse(challenged);
if (C2.got402) ok(`拿到 402 支付挑战（${C2.elapsed}ms）：${C2.mentions}`);
else bad(`未出现 402 挑战：${C2.snippet?.slice(0, 80)}`);
C2.hasAmount ? ok('挑战卡显示金额') : bad('挑战卡未显示金额');

step('3. 一键支付 → 拿到导览结果');
// ⚠️ 三条铁律（都是踩过的坑）：
//  ① 断言必须**限定在 #result 容器内**——整页文本里本来就写着「证据哈希」「实测步道」
//     （工程细节章节的静态说明），扫全文会误判成已交付；
//  ② 交付前先断言 #result 为空——否则无法区分「本来就有」与「这次支付产生的」；
//  ③ 页面表达式里避免反斜杠转义（正则里的 \n 会经 Node 模板字符串变成真换行 → 页面 SyntaxError）。
const beforeResult = await evalJs(`(() => {
  const el = document.querySelector('#result');
  return el ? el.innerText.replace(/[\\r\\n]+/g, ' ').trim().slice(0, 80) : '(no #result)';
})()`);
const BR = typeof beforeResult === 'string' ? beforeResult : JSON.stringify(beforeResult);
// 交付前 #result 里应当只有 402 挑战卡（没有路线、没有证据哈希）
const hasRouteBefore = BR.indexOf('sha256:') >= 0 || BR.indexOf('实测步道') >= 0;
const hasChallenge = BR.indexOf('402') >= 0 || BR.indexOf('Payment-Needed') >= 0 || BR.indexOf('付费资源') >= 0;
hasChallenge && !hasRouteBefore
  ? ok('支付前 #result 是 402 挑战卡（尚无路线/证据哈希）——可判定随后的交付是新产生的')
  : bad('支付前 #result 状态异常（challenge=' + hasChallenge + ' route=' + hasRouteBefore + '）：' + BR.slice(0, 60));

const paid = await evalJs(`(async () => {
  const btns = [...document.querySelectorAll('button')];
  const pay = btns.find(b => /沙箱支付|真实支付|去支付|立即支付/.test(b.textContent));
  if (!pay) return JSON.stringify({ error: 'no-pay-button', buttons: btns.map(b => b.textContent.trim()).filter(Boolean).slice(0, 20) });
  pay.click();
  const t0 = Date.now();
  const seen = { paid: false, hash: false, type: false, validation: false };
  while (Date.now() - t0 < 90000) {
    await new Promise(r => setTimeout(r, 500));
    const el = document.querySelector('#result');
    const txt = el ? el.innerText : '';
    const body = document.body.innerText;
    if (txt.indexOf('支付中') >= 0 || body.indexOf('正在支付') >= 0) seen.paid = true;
    if (txt.indexOf('sha256:') >= 0) seen.hash = true;
    if (txt.indexOf('实测步道') >= 0 || txt.indexOf('直距估算') >= 0) seen.type = true;
    if (body.indexOf('Payment-Validation') >= 0) seen.validation = true;
    if (seen.hash && seen.type) {
      const i = txt.indexOf('全程约');
      return JSON.stringify({ delivered: true, elapsed: Date.now() - t0, seen,
        snippet: (i >= 0 ? txt.slice(i, i + 44) : txt.slice(0, 44)).replace(/[\\r\\n]+/g, ' ').slice(0, 70),
        len: txt.length });
    }
    if (seen.paid && body.indexOf('失败') >= 0 && !seen.hash) {
      return JSON.stringify({ delivered: false, seen, snippet: body.slice(0, 200) });
    }
  }
  return JSON.stringify({ delivered: false, timeout: true, seen, snippet: document.body.innerText.slice(0, 200) });
})()`);
const P = typeof paid === 'string' ? JSON.parse(paid) : paid;
if (P.__err) bad('页面脚本异常：' + P.__err);
else if (P.error) bad('找不到支付按钮：' + P.error + ' 可见按钮=' + (P.buttons || []).join('/'));
else if (P.delivered) ok('#result 内出现交付内容（' + P.elapsed + 'ms，' + P.len + ' 字符）：' + P.snippet);
else bad('未交付（seen=' + JSON.stringify(P.seen) + '）：' + String(P.snippet || '').slice(0, 100));
if (P.seen && P.seen.validation) ok('页面呈现 Payment-Validation 响应头');
if (P.seen && P.seen.hash) ok('#result 内含证据哈希 sha256（可复算）');

step('3.5 协议链路面板是否回填为「你刚这一笔」');
const live = await evalJs(`(() => {
  const tag = document.querySelector('#traceTag');
  const term = document.querySelector('#termBody');
  const note = document.querySelector('.live-trace-note');
  return JSON.stringify({
    tag: tag ? tag.textContent.trim() : '',
    hasTradeNo: /trade_no=\\d{20,}/.test(term ? term.innerText : ''),
    hasNote: !!note,
    noteText: note ? note.innerText.replace(/[\\r\\n]+/g, ' ').slice(0, 120) : '',
  });
})()`);
const L2 = typeof live === 'string' ? JSON.parse(live) : live;
L2.tag.indexOf('你刚完成的这一笔') >= 0
  ? ok('协议链路面板已切换为「你刚完成的这一笔」（非静态快照）')
  : bad('协议链路面板仍是静态快照：' + L2.tag);
L2.hasTradeNo ? ok('终端显示本次真实 trade_no') : bad('终端未显示本次 trade_no');
L2.hasNote ? ok('已给出 live 提示条（含 Payment-Proof 不回传原文的安全说明）') : bad('缺少 live 提示条');

step('4. 订单核验卡（公开可分享）');
const verify = await evalJs(`JSON.stringify({
  hasVerifyLink: !!document.querySelector('a[href*="verify"], [data-verify]'),
  mentionsVerify: /核验卡|verify/i.test(document.body.innerText),
})`);
const V = JSON.parse(verify);
V.mentionsVerify ? ok('页面提供订单核验卡入口') : bad('未找到核验卡入口');

step('5. 我的账户（订单 / 额度 / 礼品码 / 退款 / 收据）');
const acct = await evalJs(`JSON.stringify({
  link: !!document.querySelector('a[href*="account.html"]'),
  mentions: ['订单','额度','礼品码','退款','收据'].filter(w => document.body.innerText.includes(w)),
})`);
const A = JSON.parse(acct);
A.link ? ok('「我的账户」入口存在') : bad('缺少「我的账户」入口');
console.log(`      账户页能力词命中：${A.mentions?.join(' / ') || '（需进入账户页确认）'}`);

step('6. 反馈墙（访客可留言）');
const fb = await evalJs(`JSON.stringify({
  hasForm: !!document.querySelector('form textarea, #fbInput, textarea'),
  mentions: /留言|反馈|评论/.test(document.body.innerText),
})`);
const F = JSON.parse(fb);
F.mentions ? ok('反馈区存在') : bad('未找到反馈区');
F.hasForm ? ok('反馈输入框存在（访客可直接留言）') : bad('未找到反馈输入框');

step('7. 场景切换（同一管线泛化）');
const sw = await evalJs(`JSON.stringify({
  options: [...document.querySelectorAll('#sceneSel option')].map(o=>o.textContent.trim()),
})`);
const SW = JSON.parse(sw);
console.log(`      可选场景：${SW.options?.join(' | ')}`);
(SW.options?.length ?? 0) >= 2 ? ok(`场景可切换（${SW.options.length} 个）`) : bad('场景不可切换');

console.log(`\n${fail ? R : G}${fail ? `失败 ${fail} 项` : '冷评委路径全部通过'}${N}（通过 ${pass} 项）`);
ws.close();
chrome.kill();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
