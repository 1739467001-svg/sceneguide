#!/usr/bin/env node
/**
 * 官方作品页分享链路验收（verify-community-share）
 *
 * 为什么要有这一项（2026-11-24 核实官方细则后新增）：
 *   官方《活动细则》把「作品影响力 20%」定义为
 *   ——「参赛作品详情页在支付宝 AI 付官网的浏览、点赞、评论等互动量综合评定」。
 *   ⇒ **我们自己站的流量不计入影响力**；被统计的是官方作品页上的互动。
 *   ⇒ 而买家手上现成愿意晒的东西就是**订单核验卡 / 交易收据**。
 *      把官方作品页的链接与二维码嵌进核验卡与收据，
 *      每一次分享就同时喂养「商业化 25%（真人付费）」与「影响力 20%（官方页浏览）」。
 *
 * 这一项验的是**接线**（最容易在改版时断掉的部分），不跑支付全流程：
 *   ① 模块：未配置 → 优雅降级返回 null（绝不能让核验卡 500）
 *   ② 模块：已配置 → 返回 URL + 标题 + CTA + 可扫的 SVG 二维码
 *   ③ 接口：/api/v1/verify 的响应里带 official 块
 *   ④ 前端：核验卡与打印收据都渲染这一块；未配置时整块不出现（不留空框）
 *   ⑤ 配置未填时，提交就绪闸门要能提醒（避免「作品已上线但没人引到官方页」）
 *
 * 用法：node scripts/verify/verify-community-share.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', C = '\x1b[36m', N = '\x1b[0m';
let passed = 0, failed = 0;
const ok = (m) => { passed += 1; console.log(`  ${G}✓${N} ${m}`); };
const bad = (m) => { failed += 1; console.log(`  ${R}✗ ${m}${N}`); };
const warn = (m) => console.log(`  ${Y}!${N} ${m}`);
const step = (m) => console.log(`\n${C}▸ ${m}${N}`);

const TEST_URL = 'https://aipay.alipay.com/community?view=work%2FHKWI_test0000';

// ── ①/② 模块行为（用临时配置注入，不动仓库文件）────────────────
step('① 未配置时优雅降级');
{
  const mod = await import('../../src/community.js');
  mod.resetCommunityCache();
  const unconfigured = await mod.getOfficialWork();
  unconfigured === null
    ? ok('officialWorkUrl 为空 → 返回 null（核验卡不会因此出错）')
    : bad(`officialWorkUrl 为空却返回了 ${JSON.stringify(unconfigured)?.slice(0, 60)}`);
}

step('② 已配置时返回 URL + 可扫二维码');
{
  const tmp = path.join(os.tmpdir(), `sg-community-${process.pid}.json`);
  fs.writeFileSync(tmp, JSON.stringify({
    officialWorkUrl: TEST_URL,
    officialWorkTitle: '三维问路 · SceneGuide（支付宝 AI 付黑客松参赛作品）',
    officialWorkCta: '去支付宝 AI 付官网看作品，顺手点个赞、留条评论',
    officialWorkNote: '这届黑客松的『作品影响力』按官方作品页上的浏览、点赞、评论统计。',
  }), 'utf8');
  process.env.SG_COMMUNITY_CONFIG = tmp;
  const mod = await import('../../src/community.js');
  mod.resetCommunityCache();
  const cfg = await mod.getOfficialWork();
  cfg?.url === TEST_URL ? ok(`URL 正确：${cfg.url}`) : bad(`URL 不对：${cfg?.url}`);
  cfg?.title ? ok(`标题：${cfg.title}`) : bad('缺标题');
  cfg?.cta ? ok('CTA 文案已带') : bad('缺 CTA 文案');
  if (cfg?.qrSvg) {
    const svg = cfg.qrSvg;
    svg.startsWith('<svg') ? ok(`二维码是 SVG（${svg.length} 字节）`) : bad('二维码不是 SVG');
    /<rect|<path/.test(svg) ? ok('二维码含图形元素（不是空壳）') : bad('二维码 SVG 内没有图形');
    svg.includes('<svg') && !svg.includes('NaN') ? ok('SVG 无 NaN（width/height 未被写坏）') : bad('SVG 含 NaN');
  } else {
    bad('没有生成二维码');
  }
  // 配置里塞非法值时也必须降级，而不是抛异常
  fs.writeFileSync(tmp, JSON.stringify({ officialWorkUrl: 'javascript:alert(1)' }), 'utf8');
  mod.resetCommunityCache();
  const evil = await mod.getOfficialWork();
  evil === null ? ok('非 https 的 URL 被拒绝（防 javascript: 注入）') : bad(`非法 URL 未被拒绝：${evil?.url}`);
  fs.writeFileSync(tmp, '{ 这不是合法 JSON', 'utf8');
  mod.resetCommunityCache();
  let threw = false;
  try { await mod.getOfficialWork(); } catch { threw = true; }
  threw ? bad('配置文件损坏时抛异常了——应该静默降级') : ok('配置文件损坏时静默降级（不抛异常）');
  fs.unlinkSync(tmp);
  delete process.env.SG_COMMUNITY_CONFIG;
  mod.resetCommunityCache();
}

// ── ③④ 接口与前端接线（静态审计 + 结构核对）──────────────────
step('③ /api/v1/verify 带上 official 块');
{
  const src = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'guide.js'), 'utf8');
  /official:\s*await getOfficialWork\(\)/.test(src)
    ? ok('核验接口响应里带 `official: await getOfficialWork()`')
    : bad('核验接口响应里没接上 official 块');
  /import\s*\{[^}]*getOfficialWork[^}]*\}\s*from\s*'\.\.\/community\.js'/.test(src)
    ? ok('guide.js 正确 import 了 getOfficialWork')
    : bad('guide.js 没有 import getOfficialWork');
}

step('④ 核验卡与打印收据都渲染这一块');
{
  const html = fs.readFileSync(path.join(ROOT, 'public', 'verify.html'), 'utf8');
  /function\s+officialBlock\s*\(/.test(html) ? ok('核验卡有 officialBlock() 渲染函数') : bad('核验卡缺 officialBlock()');
  /function\s+receiptOfficial\s*\(/.test(html) ? ok('打印收据有 receiptOfficial()') : bad('打印收据缺 receiptOfficial()');
  /\$\{officialBlock\(j\.official\)\}/.test(html) ? ok('核验卡模板调用了 officialBlock(j.official)') : bad('核验卡模板没调用 officialBlock');
  /\$\{receiptOfficial\(j\.official\)\}/.test(html) ? ok('收据模板调用了 receiptOfficial(j.official)') : bad('收据模板没调用 receiptOfficial');
  // 优雅降级：official 为空时整块不渲染，不能留空框
  /if\s*\(\s*!o\s*\|\|\s*!o\.url\s*\)\s*return\s*'';/.test(html)
    ? ok('未配置时返回空串（不留空框）')
    : bad('未配置时没有早返回——会留下空框');
  // 防注入：链接必须走 esc()
  /href="\$\{esc\(o\.url\)\}"/.test(html) ? ok('链接经 esc() 转义') : bad('链接未转义');
  /rel="noopener noreferrer"/.test(html) ? ok('外链带 noopener noreferrer') : bad('外链缺 noopener noreferrer');
}

step('⑤ 仓库配置与闸门提醒');
{
  const cfgPath = path.join(ROOT, 'config', 'community.json');
  const raw = fs.readFileSync(cfgPath, 'utf8');
  const cfg = JSON.parse(raw);
  Object.keys(cfg).every((k) => k.startsWith('_') || typeof cfg[k] === 'string')
    ? ok('config/community.json 结构合法')
    : bad('config/community.json 结构异常');
  if (cfg.officialWorkUrl) {
    /^https:\/\/aipay\.alipay\.com\/community\?view=work%2F\w+/.test(cfg.officialWorkUrl)
      ? ok(`官方作品页 URL 已填且形制正确：${cfg.officialWorkUrl}`)
      : bad(`官方作品页 URL 形制可疑：${cfg.officialWorkUrl}`);
  } else {
    warn('officialWorkUrl 还是空的——作品提交并审核通过后填上并重启，核验卡/收据才会带上官方作品页');
  }
  const gate = fs.readFileSync(path.join(ROOT, 'scripts', 'build', 'submission-readiness-check.mjs'), 'utf8');
  /官方作品详情页/.test(gate)
    ? ok('提交就绪闸门里有「官方作品页」提醒项')
    : bad('提交就绪闸门里没有官方作品页提醒项——会漏掉填 URL 这一步');
}

console.log(`\n${failed ? R : G}${failed ? `失败 ${failed} 项` : '官方作品页分享链路验收全部通过'}${N}（通过 ${passed} 项）`);
process.exit(failed ? 1 : 0);
