#!/usr/bin/env node
// 公网页面 3D 初始化探针：收集 console/error + __scene3d 状态
import { spawn } from 'node:child_process';

const BASE = (process.env.BASE_URL ?? 'https://121.43.80.231/sceneguide/').replace(/\/$/, '');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const port = 9750 + Math.floor(Math.random() * 100);
const profile = `/tmp/sg-probe-profile-${port}`;
const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--hide-scrollbars',
  '--no-proxy-server',
  `--user-data-dir=${profile}`,
  '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
  `--remote-debugging-port=${port}`, '--window-size=1440,900', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
await new Promise((r) => { ws.onopen = r; });

const send = (id, method, params) => ws.send(JSON.stringify({ id, method, params }));
const logs = [];
let resolveWait;
const done = new Promise((r) => { resolveWait = r; });

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
    logs.push(`[console.${msg.params.type}] ` + msg.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 300));
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    logs.push(`[exception] ${d.text} ${d.exception?.description?.slice(0, 200) ?? ''}`);
  }
};

send(1, 'Runtime.enable');
send(2, 'Page.enable');
send(3, 'Page.navigate', { url: BASE });

await sleep(18000);

const state = await new Promise((resolve) => {
  const handler = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id === 10) { resolve(msg.result?.result?.value); ws.removeEventListener('message', handler); }
  };
  ws.addEventListener('message', handler);
  send(10, 'Runtime.evaluate', { expression: `JSON.stringify({
    scene3d: !!window.__scene3d,
    hasThree: typeof window.THREE !== 'undefined',
    readyState: document.readyState,
    scripts: [...document.scripts].map(s=>s.src.split('/').pop()).filter(Boolean).slice(0,10),
    location: location.href,
  })`, returnByValue: true });
});

console.log('== 页面状态 ==');
console.log(state);
console.log('== console/error/exception（前 15 条）==');
for (const l of logs.slice(0, 15)) console.log(l);

ws.close();
chrome.kill();
process.exit(0);
