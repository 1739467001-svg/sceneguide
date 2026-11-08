/**
 * 自建用量计量与计费层。
 *
 * 为什么必须自建：按量付费（A2M 智能收）**不提供自动 token 计量接口**，
 * 官方文档明确「计量由商家服务端自行完成」。平台只负责收钱，
 * 「这次调用到底消耗了多少」得自己算、自己记、自己能核验。
 *
 * 🔴 平台硬约束：**服务市场注册的「服务单价」必须与实际扣费金额一致，否则用户无法支付。**
 *    因此本层的做法是：
 *      - 每个档位有固定单价与固定额度（单次 / 次数包 / 时长包），扣费金额恒等于该档位单价；
 *      - 用量在三个维度上被独立计量与留痕（调用次数 / token 消耗 / 路径长度），
 *        用于看板、限额、成本核算与「可核验用量」这一评分项；
 *      - 用量不参与本次扣费计算，避免出现「注册价 ≠ 实际支付价」导致支付失败。
 */

import { normalizeAmount } from '../a2m/protocol.js';

/** 计量口径 */
export const METERS = {
  guide_call: { unit: 'call', label: '导览调用次数' },
  tokens: { unit: 'token', label: '模型 token 消耗' },
  distance_m: { unit: 'm', label: '规划路径总长度' },
  poi_count: { unit: 'poi', label: '返回点位数量' },
};

/**
 * 从一次导览结果里抽取用量。
 * token 消耗当前用字符数估算，接入真实模型后换成 usage 字段即可。
 */
export function measure(result) {
  const answerLength = String(result?.answer ?? '').length;
  const jsonLength = JSON.stringify(result ?? {}).length;
  const estimatedTokens = Math.ceil((answerLength + jsonLength) / 2); // 中文约 2 字符/token

  const route = result?.route;
  const quest = result?.quest;
  return [
    { meter: 'guide_call', quantity: 1, unit: 'call' },
    { meter: 'tokens', quantity: estimatedTokens, unit: 'token' },
    {
      meter: 'distance_m',
      quantity: route?.distance_m ?? quest?.total_distance_m ?? 0,
      unit: 'm',
    },
    {
      meter: 'poi_count',
      quantity:
        route?.points?.length ?? quest?.checkpoints?.length ?? result?.pois?.length ?? 0,
      unit: 'poi',
    },
    ...(quest ? [{ meter: 'clue_count', quantity: quest.clues?.length ?? 0, unit: 'clue' }] : []),
  ];
}

/** 把用量数组压成可直接展示的摘要 */
export function billingSummary(usageRows) {
  const out = {};
  for (const row of usageRows ?? []) {
    out[row.meter] = `${row.quantity}${unitSuffix(row.meter, row.unit)}`;
  }
  return out;
}

function unitSuffix(meter, unit) {
  return (
    { call: ' 次', token: ' token', m: ' 米', poi: ' 个' }[unit] ??
    ` ${unit}`
  );
}

/**
 * 计算本次扣费金额。
 * 固定单价制：金额来自档位定义，与注册的服务单价严格一致。
 */
export function priceFor(tier) {
  if (!tier?.unitPrice) throw new Error('档位缺少 unitPrice');
  const amount = normalizeAmount(tier.unitPrice);
  if (amount === null) throw new Error(`档位单价非法：${tier.unitPrice}`);
  return amount;
}

/** 用量汇总（看板用） */
export function summarize(usageRows) {
  const summary = {};
  for (const row of usageRows) {
    const key = row.meter ?? row[0];
    const quantity = Number(row.quantity ?? row[1] ?? 0);
    const unit = row.unit ?? METERS[key]?.unit ?? '';
    summary[key] = {
      label: METERS[key]?.label ?? key,
      unit,
      total: (summary[key]?.total ?? 0) + quantity,
    };
  }
  return summary;
}
