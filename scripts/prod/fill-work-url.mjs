#!/usr/bin/env node
/**
 * 把官方作品详情页 URL 灌进分发文案包（fill-work-url）
 *
 * 为什么值得一个脚本：
 *   官方细则把「作品影响力 20%」定义为「参赛作品详情页在支付宝 AI 付官网的浏览、
 *   点赞、评论等互动量综合评定」——**我们自己站的流量不计入**。
 *   而这个 URL 只有在作品提交并审核通过后才存在。
 *   ⇒ 「审核通过当天」是整个 20% 维度开始计分的时刻，那一两个小时里要改的地方很多
 *     （分发文案包里有 4 处模板引用它），手工改容易漏，漏一处的后果是那篇帖子白发。
 *
 * 用法：
 *   node scripts/prod/fill-work-url.mjs --url 'https://aipay.alipay.com/community?view=work%2FHKWI_xxxx'
 *   node scripts/prod/fill-work-url.mjs --status     # 只看当前填了没有，不改
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PACK = path.join(ROOT, '提交材料', '社区分发文案包.md');

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', C = '\x1b[36m', N = '\x1b[0m';
let failed = 0;
const ok = (m) => console.log(`  ${G}✓${N} ${m}`);
const bad = (m) => { console.log(`  ${R}✗ ${m}${N}`); failed += 1; };
const warn = (m) => console.log(`  ${Y}!${N} ${m}`);
const step = (m) => console.log(`\n${C}▸ ${m}${N}`);

const STATUS_ONLY = process.argv.includes('--status');
const argUrl = (() => {
  const i = process.argv.indexOf('--url');
  return i >= 0 ? process.argv[i + 1] : null;
})();

step('① 读取分发文案包');
if (!fs.existsSync(PACK)) {
  bad(`找不到 ${PACK}`);
  process.exit(1);
}
let text = fs.readFileSync(PACK, 'utf8');
const slotCount = (text.match(/官方作品详情页/g) ?? []).length;
ok(`分发文案包里共有 ${slotCount} 处引用「官方作品详情页」`);
const unfilled = (text.match(/【[^】]*官方作品详情页[^】]*】/g) ?? []).filter((s) => !/^【https?:/.test(s));
unfilled.length
  ? warn(`还有 ${unfilled.length} 处未填：${[...new Set(unfilled)].slice(0, 3).join(' / ')}${unfilled.length > 3 ? ' …' : ''}`)
  : ok('所有引用处都已填入真实 URL');

if (STATUS_ONLY || !argUrl) {
  if (!argUrl) {
    console.log(`\n${Y}未提供 --url，只做状态查看${N}`);
    console.log('用法：node scripts/prod/fill-work-url.mjs --url \'https://aipay.alipay.com/community?view=work%2F<作品ID>\'');
  }
  process.exit(failed ? 1 : 0);
}

step('② 校验 URL 形制');
if (!/^https:\/\/aipay\.alipay\.com\/community\?view=work%2F[\w-]+$/.test(argUrl)) {
  bad(`URL 形制不对。官方作品页形如：
     https://aipay.alipay.com/community?view=work%2F<作品ID>
     实际收到：${argUrl}`);
  process.exit(1);
}
ok(`URL 形制正确：${argUrl}`);

step('③ 灌入所有模板');
const before = text;
// 表头的「待填」槽位
text = text.replace(
  /`【提交并审核通过后填入：https:\/\/aipay\.alipay\.com\/community\?view=work%2F______】`/g,
  `\`${argUrl}\``,
);
// 三个模板里的占位
text = text.replace(/【官方作品详情页链接】/g, argUrl);
if (text === before) {
  warn('没有任何占位符被替换——可能已经填过了，或占位符写法变了');
} else {
  const changed = (before.match(/【[^】]*】/g) ?? []).length - (text.match(/【[^】]*】/g) ?? []).length;
  ok(`替换了 ${changed} 处占位符`);
}

step('④ 复查');
const still = (text.match(/【[^】]*官方作品详情页[^】]*】/g) ?? []);
still.length === 0
  ? ok('分发文案包里已无「官方作品详情页」占位符')
  : bad(`仍残留 ${still.length} 处：${[...new Set(still)].join(' / ')}`);
(text.match(new RegExp(argUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length >= 3
  ? ok(`URL 在文案包里出现 ${(text.match(new RegExp(argUrl.replace(/[.*+?^$/\\]/g, '\\$&'), 'g')) ?? []).length} 次（长贴/短贴/垂直社群/CTA 都覆盖到）`)
  : warn('URL 出现次数偏少——确认每个模板都带上了');

fs.writeFileSync(PACK, text, 'utf8');
console.log(`\n${failed ? R : G}${failed ? `失败 ${failed} 项` : '分发文案包已就绪——可以开始铺量了'}${N}`);
if (!failed) {
  console.log(`\n下一步（铺量节奏见文案包 §5）：`);
  console.log('  · 审核通过当天：GitHub/OSCHINA 自荐 + 博客园/CSDN 长贴');
  console.log('  · D+2：掘金/公众号长贴（换标题）');
  console.log('  · D+3：一句话短贴 + 7 个渠道二维码');
  console.log('  · 之后每周至少 2 条新帖 + 每日回评论，一直铺到 12.09');
}
process.exit(failed ? 1 : 0);
