// 按提交表单「如何获取作品」写的 7 步，逐条核对真实站点上是否存在对应入口
import { spawn } from 'node:child_process';
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE='https://121.43.80.231/sceneguide';
const port=9820+Math.floor(Math.random()*50);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const chrome=spawn(CHROME,['--headless=new','--no-sandbox','--hide-scrollbars',
 '--disable-features=HttpsUpgrades,HttpsFirstModeV2,HttpsFirstBalancedModeAutoEnable',
 `--user-data-dir=/tmp/sg-jp-${port}`,'--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader',
 `--remote-debugging-port=${port}`,'--window-size=1440,900','about:blank'],{stdio:'ignore'});
let t=null;
for(let i=0;i<80;i++){await sleep(300);try{const r=await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'});t=await r.json();break;}catch{}}
const ws=new WebSocket(t.webSocketDebuggerUrl);
await new Promise(r=>{ws.onopen=r;});
let id=0;const pend=new Map();
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);}};
const send=(method,params={})=>new Promise(res=>{const i=++id;pend.set(i,res);ws.send(JSON.stringify({id:i,method,params}));});
const ev=async x=>{const m=await send('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true});return m.result?.result?.value;};
await send('Runtime.enable');await send('Page.enable');
await send('Page.navigate',{url:BASE+'/'});
await sleep(9000);
const steps = await ev(`JSON.stringify({
  '①首屏402协议终端': (()=>{const e=document.querySelector('#termBody');return !!e && /402|Payment-Needed/.test(e.innerText);})(),
  '①b底部工程细节区': !!document.querySelector('#engineering'),
  '②输入框+查询路线按钮': !!document.querySelector('#q') && !!document.querySelector('#askBtn'),
  '③免费试看按钮': !!document.querySelector('#previewBtn'),
  '④支付按钮': !!document.querySelector('#payBtn'),
  '⑤生成核验卡入口': /核验卡/.test(document.body.innerText),
  '⑥我的账户入口': !!document.querySelector('a[href*="account.html"]'),
  '⑦场景切换下拉': (()=>{const s=document.querySelector('#sceneSel');return s? s.options.length : 0;})(),
  '良渚文化村可选': [...document.querySelectorAll('#sceneSel option')].some(o=>/良渚/.test(o.textContent)),
  '徽标含良渚': /良渚/.test(document.body.innerText),
})`);
console.log('=== 评委指引 7 步逐条核对 ===');
const o=JSON.parse(steps);
let bad=0;
for(const [k,v] of Object.entries(o)){
  const okv = typeof v==='number'? v>=2 : v===true;
  console.log(`  ${okv?'✓':'✗'} ${k}${typeof v==='number'&&v<2?' → '+v:''}`);
  if(!okv) bad++;
}
console.log(bad? `\n有 ${bad} 步对不上` : '\n指引 7 步全部对得上');
ws.close();chrome.kill();process.exit(bad?1:0);
