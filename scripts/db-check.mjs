#!/usr/bin/env node
/**
 * 数据库体检工具
 *
 *   node scripts/db-check.mjs
 *
 * 做什么：对 orders.db 与 analytics.db 跑 quick_check / integrity_check，
 * 并列出各表行数。退出码 0 = 两个库都健康，1 = 有库损坏（可直接进 CI/监控）。
 *
 * 为什么单独一个脚本：2026-11-21 本地库损坏过一次，现象是「支付未完成」这种
 * 毫无线索的报错。损坏越早发现越好——这个脚本就是日常体检入口。
 * 恢复步骤见 src/orders/repository.js 启动体检打印的说明。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

const TARGETS = [
  { name: 'orders.db', file: process.env.ORDER_DB ?? path.join(ROOT, 'data/orders.db') },
  { name: 'analytics.db', file: process.env.ANALYTICS_DB ?? path.join(ROOT, 'data/analytics.db') },
];

let bad = 0;

for (const target of TARGETS) {
  console.log(`\n▸ ${target.name}（${target.file}）`);
  let db;
  try {
    db = new Database(target.file, { readonly: true });
  } catch (err) {
    console.log(`  ${RED}✗ 打不开：${err.message}${RESET}`);
    bad += 1;
    continue;
  }
  try {
    const quick = db.pragma('quick_check', { simple: true });
    if (quick === 'ok') {
      console.log(`  ${GREEN}✓ quick_check: ok${RESET}`);
    } else {
      console.log(`  ${RED}✗ quick_check: ${quick}${RESET}`);
      bad += 1;
    }
    // 行数概览（顺带验证每张表都读得出来）
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((r) => r.name);
    for (const t of tables) {
      try {
        const n = db.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get().c;
        console.log(`    ${t}: ${n} 行`);
      } catch (err) {
        console.log(`    ${RED}${t}: 读失败（${err.message}）${RESET}`);
        bad += 1;
      }
    }
    const wal = db.pragma('journal_mode', { simple: true });
    console.log(`    journal_mode: ${wal}`);
  } finally {
    db.close();
  }
}

console.log('\n────────────────────────────────────────────────────────');
if (bad === 0) {
  console.log(`${GREEN}数据库体检通过${RESET}`);
  process.exit(0);
}
console.log(`${RED}发现 ${bad} 处异常${RESET}`);
console.log('恢复步骤：');
console.log('  1. 停服务');
console.log('  2. cp data/<库文件> data/<库文件>.corrupt-$(date +%F)');
console.log('  3. sqlite3 data/<库文件> ".recover" > /tmp/recover.sql');
console.log('  4. sqlite3 data/<库文件>.new < /tmp/recover.sql');
console.log('  5. sqlite3 data/<库文件>.new "PRAGMA integrity_check;"  → ok 后换入并重启');
process.exit(1);
