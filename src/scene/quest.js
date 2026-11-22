import crypto from 'node:crypto';
import { getScene } from './scenes.js';
import { namedNodes, planRoute, describePosition } from './index.js';

/**
 * 场景任务（研学 / 寻宝）模式。
 *
 * 这是「三维问路」真正的付费形态：
 *   查路线是一次问答（低价、难决策）；
 *   **一次任务是一个可交付的教育产品**——有线索链、有目标、有评分、有完成凭证，
 *   家长/研学机构为「一次任务」付费的意愿远高于为「一次查询」付费。
 *
 * 任务对象同时可以被打包成面向机构的批量服务（Agent 自动采购）。
 *
 * 与场景内核共用同一份拓扑：线索指向的点位、目标路径都来自真实地理数据，
 * 完成凭证里带几何哈希，可核验「这个任务确实发生在这个场景里」。
 */

const CLUE_TEMPLATES = [
  (from, to) => `先从${from.name}出发，沿主路向${describeSide(to, from)}方向行进`,
  (from, to) => `经过${from.name}后继续直行，直到你看到${to.name}的标识`,
  (from, to) => `在${from.name}附近留心地面标识，它会指向${to.name}`,
  (from, to) => `穿过${to.name}前的一处通道，那就是${from.name}的方位`,
];

/** 判断目标相对起点的方位 */
function describeSide(target, origin) {
  const dx = target.xy[0] - origin.xy[0];
  const dy = target.xy[1] - origin.xy[1];
  const ns = dy > 60 ? '北' : dy < -60 ? '南' : '';
  const ew = dx > 60 ? '东' : dx < -60 ? '西' : '';
  if (ns && ew) {
    // 组合方位用标准顺序：东北 / 东南 / 西南 / 西北
    const combos = { 北东: '东北', 南东: '东南', 南西: '西南', 北西: '西北' };
    return combos[`${ns}${ew}`] ?? `${ns}${ew}`;
  }
  return ns || ew || '中心';
}


/** 明显不是「校园地标」的名字：隔壁学校、商铺、乱码 */
const NON_LANDMARK = /中学|小学|幼儿园|学校|酒店|宾馆|超市|便利店|银行|分行|咖啡|奶茶|餐厅|快餐|电影|影城|充电站|药店|药房|通讯|家电|酒家|面馆|烧烤|科技|公司|门市部/;

/** 典型校园地标关键词 */
const LANDMARK_WORDS = /图书馆|楼|馆|中心|食堂|公寓|综合|实验|体育|会堂|医院|学院|校区|广场|球场|泳|运动|活动中心/;

/**
 * 地标可信度打分：
 *   - 名字里带「XX大学/学院」的，优先（说明是本机构的建筑）
 *   - 带典型地标关键词的，次之
 *   - 命中非地标词或名字过短的，剔除
 */
function landmarkScore(node, scene) {
  const name = String(node.name ?? '').trim();
  if (name.length < 3) return -1;
  // 道路名不是地标
  if (/[路街道巷弄大道]$/.test(name)) return -1;
  if (NON_LANDMARK.test(name)) return -1;

  let score = 1;
  const owner = /^(.{2,10}?)(大学|学院)/.exec(scene.name ?? '');
  if (owner && name.startsWith(owner[1])) score += 5;
  if (LANDMARK_WORDS.test(name)) score += 3;
  if (/号学生公寓|^\d+号/.test(name)) score -= 1;   // 几十栋公寓同质，参考价值低
  return score;
}

/**
 * 生成一次场景任务。
 *
 * @param {object} params
 * @param {string} params.sceneId
 * @param {string[]} params.checkpointNames 任务必经点（按顺序）
 * @param {string} params.title
 * @param {string} params.level  'easy' | 'normal' | 'hard'
 */
export function createQuest({ sceneId, checkpointNames = [], title, level = 'normal' }) {
  const scene = getScene(sceneId);
  if (!scene) return { ok: false, error: 'SCENE_NOT_FOUND' };

  const named = namedNodes(scene);

  // 🔴 解析用户点名的打卡点，两个必须先修的问题（2026-11-21 实测复现，
  //    都发生在**已付费**的任务上）：
  //    1) 空串：`''.includes` 恒真，而 `checkpoints=图书馆,` 的尾随逗号极常见——
  //       空串会静默命中「第一个地标」，生成一个用户从未点名的打卡点；
  //    2) 重复：同一个 node 出现两次时，仓储层对重复 point_id 直接返回
  //       ALREADY_CHECKED_IN，而打卡又必须按序——用户第二次打到同一节点时
  //       任务**永久卡死**，且已付费、无退还路径。
  //    因此：丢空串、按 node.id 去重、把没识别的名字显式报出来。
  const requested = checkpointNames.map((n) => String(n ?? '').trim()).filter(Boolean);
  const byId = new Map();
  const unresolved = [];
  for (const name of requested) {
    const node = named.find((n) => n.name === name || n.name.includes(name));
    if (node) byId.set(node.id, node);
    else unresolved.push(name);
  }
  const checkpoints = [...byId.values()];

  // 用户明确点了名却凑不齐 2 个：显式报错，不要静默混入自动挑的点
  // （旧行为把用户点的一个点和自动挑的混在一起，语义混乱）。
  if (requested.length > 0 && checkpoints.length < 2) {
    return {
      ok: false,
      error:
        `至少需要 2 个可识别的打卡点（收到 ${requested.length} 个，识别 ${checkpoints.length} 个` +
        `${unresolved.length ? `；未识别：${unresolved.join('、')}` : ''}）`,
      unresolved,
    };
  }

  if (checkpoints.length < 2) {
    // 没指定就自动挑三个站点：
    //   1) 先按「地标可信度」打分剔除隔壁学校/商铺/乱码名；
    //   2) 再在空间上取分散的三点（西 → 东 → 离连线最远）。
    const scored = named
      .filter((n) => n.type === 'building' || n.type === 'facility')
      .map((n) => ({ node: n, score: landmarkScore(n, scene) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);

    // OSM 里同名要素可能有多个 way（同一个场馆被拆成多段），先按名称去重
    const deduped = [];
    const seenNames = new Set();
    for (const x of scored) {
      if (seenNames.has(x.node.name)) continue;
      seenNames.add(x.node.name);
      deduped.push(x.node);
    }

    // 🔴 任务必须「走得完」：打卡点优先取**最大连通分量**内的地标，
    //    这样段段都有实测步道（measured=true），而不是一段段直线虚线。
    //    OSM 路网是碎的（下沙校区 38 个分量），不挑分量的话
    //    空间上铺得开的三点很可能彼此不连通。
    const adjacency = new Map();
    for (const e of scene.edges) {
      if (!adjacency.has(e.from)) adjacency.set(e.from, []);
      if (!adjacency.has(e.to)) adjacency.set(e.to, []);
      adjacency.get(e.from).push(e.to);
      adjacency.get(e.to).push(e.from);
    }
    const compOf = new Map();
    const compNodeCount = new Map();
    let compId = 0;
    for (const node of scene.nodes) {
      if (compOf.has(node.id)) continue;
      let size = 0;
      const stack = [node.id];
      compOf.set(node.id, compId);
      while (stack.length) {
        const cur = stack.pop();
        size += 1;
        for (const next of adjacency.get(cur) ?? []) {
          if (!compOf.has(next)) {
            compOf.set(next, compId);
            stack.push(next);
          }
        }
      }
      compNodeCount.set(compId, size);
      compId += 1;
    }

    // 取「命名地标最多」的分量——不是节点最多的分量：
    // 节点最多的往往是一大片纯路网，地标反而稀少
    const perCompLandmarks = new Map();
    for (const n of deduped) {
      const c = compOf.get(n.id);
      if (c === undefined) continue;
      perCompLandmarks.set(c, (perCompLandmarks.get(c) ?? 0) + 1);
    }
    let bestComp = -1;
    let bestCount = 0;
    for (const [c, count] of perCompLandmarks) {
      if (count > bestCount) {
        bestCount = count;
        bestComp = c;
      }
    }

    // 优先级：本机构署名 ∩ 最佳分量 → 最佳分量 → 全部
    const owner = /^([\u4e00-\u9fa5]{2,8}?)(大学|学院)/.exec(scene.name ?? '')?.[1] ?? '';
    const inBest = (n) => compOf.get(n.id) === bestComp;
    const ownLandmarks = owner ? deduped.filter((n) => n.name.startsWith(owner) && inBest(n)) : [];
    const walkable = deduped.filter(inBest);
    const usable = ownLandmarks.length >= 3 ? ownLandmarks : walkable.length >= 3 ? walkable : deduped;
    if (usable.length < 3) return { ok: false, error: 'NOT_ENOUGH_CHECKPOINTS' };

    const byX = [...usable].sort((a, b) => a.xy[0] - b.xy[0]);
    const start = byX[0];
    const end = byX[byX.length - 1];

    const distToLine = (p) => {
      const ax = start.xy[0], ay = start.xy[1];
      const bx = end.xy[0], by = end.xy[1];
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      if (len2 === 0) return 0;
      const t = Math.max(0, Math.min(1, ((p.xy[0] - ax) * dx + (p.xy[1] - ay) * dy) / len2));
      const px = ax + t * dx, py = ay + t * dy;
      return Math.hypot(p.xy[0] - px, p.xy[1] - py);
    };

    const mid = usable
      .filter((n) => n.id !== start.id && n.id !== end.id)
      .sort((a, b) => distToLine(b) - distToLine(a))[0];

    checkpoints.push(start, mid ?? end, end);
  }

  // 兜底：不管走哪条分支，打卡点在生成任务前必须是**互不相同**的节点。
  // 重复节点 = 任务永远无法完成（仓储层按 point_id 主键拒绝重复打卡）。
  const uniqueCheckpoints = [...new Map(checkpoints.map((c) => [c.id, c])).values()];
  if (uniqueCheckpoints.length < 2) {
    return { ok: false, error: 'NOT_ENOUGH_CHECKPOINTS' };
  }
  checkpoints.length = 0;
  checkpoints.push(...uniqueCheckpoints);

  const legs = [];
  let totalDistance = 0;
  for (let i = 0; i < checkpoints.length - 1; i += 1) {
    const from = checkpoints[i];
    const to = checkpoints[i + 1];
    const route = planRoute(scene, from.id, to.id);
    const distance = route.found ? route.distanceM : straightDistance(from, to);
    totalDistance += distance;
    legs.push({
      from: poi(from),
      to: poi(to),
      distance_m: distance,
      measured: route.found,
      points: route.found ? route.points.map(poi) : [poi(from), poi(to)],
    });
  }

  // 🔴 线索必须**按打卡点**生成，而不是按路段：
  //    N 个打卡点只有 N-1 段路，若线索也按路段生成，最后一站就没有线索、
  //    用户永远打不到最后一张卡，任务无法完成。
  // 🔴 线索必须回答「怎么从上一站来到第 i 站」，而不是「从第 i 站出发去哪」。
  //    旧实现用 legs[i]（从第 i 站出发的路段）配「第 i+1 站」的 hint：
  //    首站没有任何「如何找到它」的线索，最后一条线索退化成通用填充文本，
  //    「线索链」这个核心卖点名不副实（实测复现）。
  //    第 1 站的线索描述起点方位（用户在场景里先要找到它）。
  const clues = checkpoints.map((cp, i) => {
    if (i === 0) {
      return {
        index: 1,
        text: `起点是「${cp.name}」${describePosition(scene, cp)}。从这里出发，按线索逐站前进。`,
        hint: `第 1 站（起点）：${cp.name}`,
      };
    }
    const leg = legs[i - 1]; // 从第 i-1 站到第 i 站的那段路
    const template = CLUE_TEMPLATES[(i - 1) % CLUE_TEMPLATES.length];
    // 难度决定线索粒度：easy 给方位+距离，normal 给路线提示，hard 只给相对方位
    const detail =
      level === 'easy'
        ? `（约 ${Math.round(leg.distance_m)} 米，朝${describeSide(leg.to, leg.from)}）`
        : level === 'hard'
          ? ''
          : '';
    return {
      index: i + 1,
      text: template(leg.from, leg.to) + detail,
      hint: `第 ${i + 1} 站：${cp.name}`,
    };
  });

  const material = JSON.stringify({
    scene: scene.id,
    checkpoints: checkpoints.map((c) => [c.id, c.xy]),
    level,
  });

  return {
    ok: true,
    quest: {
      id: `Q_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`,
      title: title ?? `${scene.name}寻访任务 · ${checkpoints.map((c) => c.name).join(' → ')}`,
      level,
      scene: { id: scene.id, name: scene.name },
      brief: `在${scene.name}内依次完成 ${checkpoints.length} 个站点，${level === 'easy' ? '每站都有明确提示' : level === 'hard' ? '线索需要自己推理' : '根据线索判断下一站'}。`,
      clues,
      legs,
      checkpoints: checkpoints.map(poi),
      total_distance_m: totalDistance,
      estimated_minutes: Math.round((totalDistance / 72) * 1.4), // 含找路与停留
      scoring: {
        base: 100,
        bonuses: [
          { key: 'all_checkpoints', label: '完成全部站点', points: 30 },
          { key: 'under_time', label: `在 ${Math.round((totalDistance / 72) * 1.4)} 分钟内完成`, points: 20 },
        ],
      },
      certificate: null, // 证书在**全部打卡完成后**才颁发（见 issueCertificate）
      fingerprint: `sha256:${crypto.createHash('sha256').update(material).digest('hex').slice(0, 32)}`,
    },
  };
}

/**
 * 颁发完成证书。
 *
 * 🔴 关键：**证书在全部打卡完成后才生成**，哈希覆盖的是「实际打卡记录」
 *    （任务 id + 各站顺序 + 打卡时刻 + 总里程 + 得分），而不是预生成的任务模板。
 *    这样证书才真的证明了「这个人走完了这条路线」，
 *    任何人拿同样的打卡记录都能复算出同一个哈希。
 */
export function issueCertificate(quest, checkins, score) {
  const material = JSON.stringify({
    questId: quest.id,
    sceneId: quest.sceneId,
    checkpoints: quest.checkpoints.map((c) => [c.id, c.name]),
    checkins: checkins.map((c) => [c.point_id, c.seq, c.checked_at]),
    totalDistanceM: quest.totalDistanceM,
    score,
  });
  return {
    issuer: '三维问路 · SceneGuide',
    questId: quest.id,
    questTitle: quest.title,
    scene: quest.sceneId,
    score,
    totalDistanceM: quest.totalDistanceM,
    checkpoints: checkins.length,
    completedAt: checkins.length ? checkins[checkins.length - 1].checked_at : null,
    verifiable_by: `sha256:${crypto.createHash('sha256').update(material).digest('hex').slice(0, 32)}`,
    verify_hint:
      '哈希覆盖「任务 id + 各站顺序 + 打卡时刻 + 总里程 + 得分」，' +
      '凭打卡记录可复算验证。',
  };
}

function poi(node) {
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    xy: node.xy,
    lonlat: node.lonlat,
  };
}

function straightDistance(a, b) {
  return Math.round(Math.hypot(b.xy[0] - a.xy[0], b.xy[1] - a.xy[1]));
}
