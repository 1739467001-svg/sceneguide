#!/usr/bin/env node
/**
 * 查「AI 按量付费」签约状态（check-sign-status）
 *
 * 为什么单独一个脚本：
 *   签约提交后到生效之间要反复查同一个 MCP 接口，而返回体是
 *   `{"content":[{"text":"<JSON 字符串>"}]}` —— 两层 JSON。
 *   每次在 shell 里内联一段解析代码，既长又容易写错（这个仓库已经因此踩过一次）。
 *
 * 用法：
 *   node scripts/check-sign-status.mjs            # 查一次
 *   node scripts/check-sign-status.mjs --watch    # 持续轮询直到「已生效」
 */
import { execFileSync } from 'node:child_process';

const SALES_CODE = 'I1080300001000160457';
const WATCH = process.argv.includes('--watch');
const INTERVAL_MS = 15000;

function call() {
  const raw = execFileSync('alipay-cli', [
    'mcp', 'call', 'ar-query.queryArInfosBySalesProd',
    '-d', JSON.stringify({ request: { salesProductCodes: [SALES_CODE] }, ctx: {} }),
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  // 外层是 {content:[{text:"..."}]}，text 里面又是一层 JSON 字符串
  const m = raw.match(/"text": "([\s\S]*?)",\s*\n/);
  if (!m) throw new Error('未取得可解析的 MCP 响应');
  const inner = JSON.parse(`"${m[1]}"`);
  const payload = JSON.parse(inner);
  if (!payload.success) throw new Error(`查询失败：${payload.errorMessage ?? '未知'}`);
  return payload.resultObj?.arInfoList?.[0] ?? null;
}

function show(info) {
  if (!info) return '(无记录)';
  const fee = (info.priceDesc ?? '').split('\n').filter(Boolean).slice(0, 2).join(' ｜ ');
  return [
    `状态=${info.arStatusDesc}`,
    `申请单=${info.arNo}`,
    `生效=${info.gmtValid ?? '未生效'}`,
    fee ? `费率口径=${fee}` : '',
  ].filter(Boolean).join('  ');
}

let last = '';
for (;;) {
  let line;
  try {
    line = show(call());
  } catch (err) {
    line = `查询异常：${err.message}`;
  }
  if (line !== last) {
    console.log(`[${new Date().toLocaleTimeString('zh-CN')}] ${line}`);
    last = line;
  }
  if (!WATCH) break;
  if (line.includes('已生效')) {
    console.log('✅ 签约已生效');
    break;
  }
  await new Promise((r) => setTimeout(r, INTERVAL_MS));
}
