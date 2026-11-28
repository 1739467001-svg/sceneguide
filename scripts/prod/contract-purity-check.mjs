#!/usr/bin/env node
/**
 * A2M 契约纯度审计（离线静态检查）。
 *
 * 依据官方《A2M 接口契约》原文：
 *   「AI 按量付费只实现 HTTP 402、Payment-Needed、Payment-Proof、
 *    alipay.aipay.agent.payment.verify 和 alipay.aipay.agent.fulfillment.confirm。
 *    不得混入 AI 网页应用收款或 AI 移动应用收款的统一收单接口、异步通知或 notify_url。」
 *
 * 背景（2026-11-28 决策留痕）：本项目曾挂过一个统一收单风格的「异步通知」端点
 * （POST /api/v1/pay/notify + markPaidByNotification），依据《支付 MCP Server》文档实现。
 * 下线原因：按量付费订单不走统一收单，该端点在生产部署里**从不会有真实通知流入**，
 * 只会留下「无验签可伪造状态」的裸攻击面 + 产品混用的合规瑕疵。
 * 结果感知回到协议内通道：买方携 Payment-Proof 重试 + 订单查询端点轮询。
 *
 * 本脚本把这条契约变成可验证的恒定约束：谁往代码里加回统一收单接口 /
 * notify_url / 异步通知，验收就会红。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const SRC = path.join(ROOT, 'src');
const CONFIG = path.join(ROOT, 'config');

let pass = 0;
let fail = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`✓ ${label}`);
    pass++;
  } else {
    console.error(`✗ ${label}${detail ? `：${detail}` : ''}`);
    fail++;
  }
}

/** 递归收集目录下的源文件（跳过 node_modules / data / 点文件） */
function collectSourceFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'data' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectSourceFiles(full, out);
    else if (/\.(js|mjs|json)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const files = [...collectSourceFiles(SRC), ...collectSourceFiles(CONFIG)];
const contents = files.map((f) => [path.relative(ROOT, f), fs.readFileSync(f, 'utf8')]);

// ① 统一收单接口族不得被真正调用：扫描 exec('alipay.trade.*') 形态的调用点。
//    （注释里对历史实验的记录——如「沙箱实测 alipay.trade.refund → 40004」——不算调用，
//    那是「我们试过、被官方拒绝」的宝贵证据，应当保留。）
const tradeCallHits = contents.filter(([, text]) =>
  /exec\(\s*(['"`])alipay\.trade\./.test(text),
);
check(
  '无统一收单接口调用（exec("alipay.trade.*") 零命中）',
  tradeCallHits.length === 0,
  tradeCallHits.map(([f]) => f).join(', '),
);

// ② 异步通知通道不得复活：路由文件 / 端点路径 / 仓储方法 / 配置项四条路全堵。
//    只认代码级标识符与路由字面量；决策留痕注释用自然语言描述，不写这些字面量。
const notifyRouteGone = !fs.existsSync(path.join(SRC, 'routes', 'notify.js'));
check('notify 路由文件已删除（src/routes/notify.js）', notifyRouteGone);

const notifyCodeHits = contents.filter(
  ([, text]) =>
    /markPaidByNotification|createNotifyRouter|AP_NOTIFY_URL|notify_url|['"`]\/api\/v1\/(pay\/)?notify['"`]/.test(text),
);
check(
  '代码与运行时配置中无异步通知端点 / 方法 / 配置引用',
  notifyCodeHits.length === 0,
  notifyCodeHits.map(([f]) => f).join(', '),
);

// ③ 官方商家侧接口族恰好是 verify + confirm（+ 可选 precreate），缺一不可、多一不行
const clientText = fs.readFileSync(path.join(SRC, 'a2m', 'client.js'), 'utf8');
check('实现 payment.verify（官方商家接口 1/2）', clientText.includes('alipay.aipay.agent.payment.verify'));
check('实现 fulfillment.confirm（官方商家接口 2/2）', clientText.includes('alipay.aipay.agent.fulfillment.confirm'));
const allowedApis = [
  'alipay.aipay.agent.payment.verify',
  'alipay.aipay.agent.fulfillment.confirm',
  'alipay.aipay.agent.payment.precreate', // 官方 MACHINE_PAY.md 的可选预下单形态
];
const calledApis = [...clientText.matchAll(/alipay\.aipay\.[a-z.]+/g)].map((m) => m[0]);
const illegal = calledApis.filter((api) => !allowedApis.includes(api));
check(
  'OpenAPI 调用面恰好等于官方允许集合（verify/confirm/precreate）',
  illegal.length === 0,
  `越界调用：${[...new Set(illegal)].join(', ')}`,
);

// ④ 站点对外物料不再宣传「异步通知」通道（llms.txt / 首页 / SKILL.md 是评委与 Agent 的读物）
const publicDocs = ['public/llms.txt', 'public/index.html', 'public/app.js', 'SKILL.md']
  .map((rel) => path.join(ROOT, rel))
  .filter((f) => fs.existsSync(f))
  .map((f) => [path.relative(ROOT, f), fs.readFileSync(f, 'utf8')]);
const docHits = publicDocs.filter(
  ([, text]) => /AP_NOTIFY_URL|\/api\/v1\/pay\/notify|notify_url/.test(text),
);
check(
  '对外物料（llms.txt / 首页 / SKILL.md）不再引用 notify 通道',
  docHits.length === 0,
  docHits.map(([f]) => f).join(', '),
);

// ⑤ 结果感知双通道在位：Payment-Proof 验付 + 订单查询端点
const guideText = fs.readFileSync(path.join(SRC, 'routes', 'guide.js'), 'utf8');
check('协议内通道 1/2：Payment-Proof 验付路径在位', guideText.includes("req.headers['payment-proof']"));
check('协议内通道 2/2：订单状态查询端点在位', guideText.includes('/api/v1/orders/:outTradeNo'));

console.log('');
process.exit(fail === 0 ? 0 : 1);
