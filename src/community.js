import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';

/**
 * 社区传播配置：支付宝 AI 付官网的「作品详情页」入口。
 *
 * 为什么需要这个模块（2026-11-24 核实官方细则后新增）：
 *   官方《活动细则》原文把「作品影响力 20%」定义为
 *   ——「参赛作品详情页在支付宝 AI 付官网的浏览、点赞、评论等互动量综合评定」。
 *   也就是说：**我们自己站的流量不计入影响力**，被统计的是官方作品页上的互动。
 *
 *   而我们的买家手上恰好有一件现成的、愿意晒的东西：**订单核验卡 / 交易收据**
 *   （脱敏交易号 + 证据哈希 + 可复算的距离）。买家把它发到朋友圈/群，
 *   就是一次真实的作品传播。⇒ 让核验卡与收据**带上官方作品页的链接和二维码**，
 *   每一次分享就同时带来「商业化分」（一次真人付费）与「影响力分」（一次官方页浏览）。
 *
 *   官方作品页 URL 在作品提交并审核通过后才有 → 配置里留空，
 *   提交当天填入并重启即生效；未配置时全部优雅降级（不渲染、不报错）。
 */

// ⚠️ 路径可用环境变量覆盖（SG_COMMUNITY_CONFIG）：
//    官方作品页 URL 在提交并审核通过后才有，那时才需要把配置指向真实文件；
//    而「这一块能不能正常渲染、没配置时会不会把核验卡搞挂」必须**当场**能验，
//    所以需要一个能在不改动仓库文件的前提下注入测试配置的口子
//    ——与 ALIPAY_PRODUCTION_CONFIG / ALIPAY_SERVICES_CONFIG 是同一套做法。
//    ⚠️ 必须在**运行时**读这个变量，不能提到模块顶层：
//    ESM 模块只求值一次，顶层常量会在第一次 import 时把路径定死，
//    之后再设 process.env 也不生效（验收脚本正是这个顺序）。
const DEFAULT_CONFIG_FILE = path.join(path.dirname(import.meta.dirname), 'config', 'community.json');

let cache = null;
let cachedPath = null;

/**
 * 读配置。文件不存在/解析失败/URL 为空都返回 null——
 * 这是一个「锦上添花」的传播口，绝不能因为它坏了就让核验卡 500。
 */
function loadConfig() {
  const file = process.env.SG_COMMUNITY_CONFIG
    ? path.resolve(process.env.SG_COMMUNITY_CONFIG)
    : DEFAULT_CONFIG_FILE;
  // 路径变了就重新读（测试脚本会中途换配置）
  if (cache !== null && cachedPath === file) return cache;
  cachedPath = file;
  let cfg = null;
  try {
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const url = typeof raw.officialWorkUrl === 'string' ? raw.officialWorkUrl.trim() : '';
      if (url && /^https:\/\//i.test(url)) {
        cfg = {
          url,
          title: raw.officialWorkTitle ?? '支付宝 AI 付黑客松参赛作品',
          cta: raw.officialWorkCta ?? '去官方作品页看演示',
          note: raw.officialWorkNote ?? '',
        };
      }
    }
  } catch {
    cfg = null;
  }
  cache = cfg;
  return cfg;
}

/** 仅用于测试/配置变更后的重新读取 */
export function resetCommunityCache() {
  cache = null;
}

/**
 * 官方作品页的展示块（URL + 标题 + CTA + 二维码 SVG）。
 * 未配置时返回 null —— 调用方据此「不渲染这一块」。
 *
 * ⚠️ 必须是 async：`QRCode.toString()` 返回 Promise（同步版本是 toString 的同步分支
 *    在 Node 下会走 Promise），早先写成同步导致 qrSvg 是 Promise 而非字符串。
 */
export async function getOfficialWork({ withQr = true } = {}) {
  const cfg = loadConfig();
  if (!cfg) return null;
  if (!withQr) return { ...cfg, qrSvg: null };
  try {
    // margin: 2 —— 二维码的静区（quiet zone）。默认 1 太窄：
    //   这张卡会被买家截图发到微信里，缩放/压缩后 1 模块的静区很容易扫不出来。
    //   静区不足是「看着是二维码、扫不出」的常见原因。
    const qrSvg = await QRCode.toString(cfg.url, { type: 'svg', margin: 2, width: 176 });
    return { ...cfg, qrSvg: typeof qrSvg === 'string' ? qrSvg : null };
  } catch {
    // 二维码生成失败不该拖垮整个核验卡
    return { ...cfg, qrSvg: null };
  }
}
