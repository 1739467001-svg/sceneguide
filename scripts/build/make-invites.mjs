#!/usr/bin/env node
/**
 * 渠道邀请包生成器。
 *
 * 用途：备案/部署完成后，为 29 场活动积累的社群生成**带归因的分享链接**，
 *      让「真实付费用户」可以按渠道追踪——这是商业化表现评分的证据基础。
 *
 * 两种用法：
 *   1) node scripts/build/make-invites.mjs                     → 生成/更新 config/invites.json（服务启动时自动种子）
 *   2) BASE_URL=https://... node scripts/build/make-invites.mjs --register → 同时注册到线上服务
 *
 * 输出：每个渠道一条可直接复制进微信群/朋友圈的文案 + 短链。
 */

import fs from 'node:fs';
import path from 'node:path';

const CHANNELS = [
  { code: 'zjgsu', label: '浙工商同学群', blurb: '同学们，我做的「三维问路」上线了——问它浙工商校内怎么走，路线是真步道拓扑算出来的，不是 AI 编的。第一次可以免费试看。' },
  { code: 'liangzhu', label: '良渚少儿AI课家长群', blurb: '家长们，我给孩子们上课用的那套三维校园，现在做成了「校园寻宝任务」：孩子按线索依次打卡地标，全部走完能拿到一张带防伪哈希的完成证书。适合周末遛娃。' },
  { code: 'hackathon', label: '黑客松社群', blurb: '各位，PAYATHON 参赛作品「三维问路」：一个能被 Agent 自动购买的导览服务（HTTP 402 A2M）。欢迎用你的 Agent 来采购一次，或者人工点一遍支付链路。' },
  { code: 'hospital', label: '医院课题组', blurb: '课题组老师同学：我把 DrCopilot 里「AI 只出草稿、人来确认」的思路搬到了导览场景——AI 给的每条路线都带可复算的证据哈希。欢迎体验。' },
  { code: 'corp', label: '企业培训学员', blurb: '上次培训提到的「按量计费的 AI 服务」长这样：每次调用按次付费、用量可核验。这是我能收款的线上实例。' },
  { code: 'moments', label: '朋友圈', blurb: '博士入学前做的最后一个作品：三维问路——真实地理数据 + Agent 自动支付。点开就能玩，前三次免费。' },
  { code: 'general', label: '通用分享', blurb: '三维问路 · SceneGuide：基于真实 OpenStreetMap 拓扑的场景导览，支持支付宝按次付费，Agent 也能自己买。' },
];

const args = process.argv.slice(2);
const register = args.includes('--register');
const base = process.env.BASE_URL ?? 'http://127.0.0.1:3000';

// 1) 写种子文件（服务启动时自动注册）
const outFile = path.resolve('config/invites.json');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(CHANNELS.map(({ code, label }) => ({ code, label })), null, 2));
console.log(`✓ 已写入 ${path.relative(process.cwd(), outFile)}（重启服务后自动种子）`);

// 2) 可选：直接注册到线上
if (register) {
  for (const { code, label } of CHANNELS) {
    const res = await fetch(`${base}/api/v1/invites`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label }),
    });
    console.log(`  ${res.ok ? '✓' : '✗'} ${code} → HTTP ${res.status}`);
  }
}

// 3) 打印分享包
console.log('\n━━━ 分享包（复制即用）━━━\n');
for (const { code, label, blurb } of CHANNELS) {
  console.log(`【${label}】短链: ${base}/r/${code}`);
  console.log(`  ${blurb}`);
  console.log(`  👉 ${base}/?ref=${code}\n`);
}
