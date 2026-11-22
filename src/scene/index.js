/**
 * 场景导览内核。
 *
 * 输入：场景 + 自然语言问题
 * 输出：结构化导览结果（JSON）+ 一段可直接呈现给用户的说明
 *
 * 与通用 LLM 问答的本质差别：**路径与点位来自真实地理拓扑**，
 * 路线长度、途经点、证据哈希都可核验，模型只能做「解释」不能编造「位置」。
 */

import crypto from 'node:crypto';
import { getScene } from './scenes.js';

/** 步行速度（米/分钟），用于 ETA 估算 */
const WALK_SPEED_M_PER_MIN = 72;

/**
 * 取地名的「核心词」。
 * OSM 里的名字常带两类修饰，用户口头只会说核心部分：
 *   括注     「逸夫楼（环境科学与工程学院）」 → 「逸夫楼」
 *   编号前缀 「21号学生公寓」                 → 「学生公寓」
 */
export function coreName(name) {
  return String(name ?? '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/^[0-9０-９]+\s*[号栋幢座楼#]/, '')
    .replace(/[·・\-—_]/g, '')
    .trim();
}

/**
 * 生成一个地名的所有可匹配变体。
 * OSM 的名字常常是「浙江工商大学文体中心场馆（亚运手球比赛馆）」，
 * 而用户只会说「文体中心」，所以要把机构前缀也剥掉。
 */
export function nameVariants(name) {
  const raw = String(name ?? '').trim();
  if (!raw) return [];

  const variants = new Set();
  variants.add(raw);

  const noParen = coreName(raw);
  variants.add(noParen);

  // 剥掉机构前缀：「浙江工商大学…」→「文体中心场馆」
  const stripped = noParen.replace(
    /^[\u4e00-\u9fa5]{2,10}?(大学|学院|学校|中学|小学|校区|大)/,
    '',
  );
  if (stripped && stripped !== noParen) variants.add(stripped);

  // 剥掉通用后缀（逐个剥，不做贪婪匹配，避免把名字从中间切断）
  for (const suffix of ['场馆', '大楼', '广场', '园区', '生活区', '中心']) {
    for (const v of [...variants]) {
      if (!v.endsWith(suffix)) continue;
      const shorter = v.slice(0, -suffix.length);
      if (shorter.length >= 2) variants.add(shorter);
    }
  }

  return [...variants].filter((v) => v.length >= 2);
}

/**
 * 从问题里识别地点实体。
 *
 * 打分用**覆盖率**而不是绝对长度：
 *   「广发文体中心」被问成「文体中心」 → 覆盖率 4/6
 *   「浙江工商大学文体中心场馆」被问成「文体中心」 → 覆盖率 4/12
 * 前者更贴近用户口中那个名字，应当排在前面。
 */
export function findEntities(scene, text) {
  const haystack = String(text ?? '').toLowerCase();
  const query = haystack.trim();
  const scored = [];

  for (const node of scene.nodes) {
    const candidates = [node.name, ...(node.aliases ?? [])].filter(Boolean);
    let best = null;

    for (const candidate of candidates) {
      for (const variant of nameVariants(candidate)) {
        const v = variant.toLowerCase();
        if (!v) continue;

        let score = null;
        if (v === query) {
          score = 200;                                   // 完全一致
        } else if (haystack.includes(v)) {
          score = 100 + (v.length / Math.max(v.length, query.length)) * 40;
        } else if (v.length >= 3 && query.length >= 2 && v.includes(query)) {
          score = 40 + (query.length / v.length) * 60;   // 名称包含查询词，按覆盖率
        }

        if (score !== null && (!best || score > best.score)) {
          best = { node, score, matched: candidate };
        }
      }
    }

    if (best) scored.push(best);
  }

  return scored.sort((a, b) => b.score - a.score);
}

/** 意图识别 */
export function detectIntent(query, entities, scene) {
  const q = String(query ?? '').toLowerCase();
  const routeWords = ['怎么走', '怎么去', '路线', '路怎么', '带路', '导航', '路径', '多远', 'walk', 'route'];
  const isRoute = routeWords.some((w) => q.includes(w));
  if (isRoute && scene && parseEndpoints(scene, query)) return 'route';
  if (isRoute && entities.length >= 2) return 'route';
  if (isRoute && entities.length === 1) return 'route_to_origin';
  if (entities.length >= 1) return 'poi';
  return 'overview';
}

/** Dijkstra 最短路 */
export function planRoute(scene, fromId, toId) {
  if (fromId === toId) {
    const node = scene.nodes.find((n) => n.id === fromId);
    return {
      found: true,
      points: [node],
      steps: [],
      distanceM: 0,
      etaMin: 0,
    };
  }

  const adjacency = new Map();
  for (const edge of scene.edges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    if (!adjacency.has(edge.to)) adjacency.set(edge.to, []);
    adjacency.get(edge.from).push({ to: edge.to, cost: edge.cost_m, kind: edge.kind });
    adjacency.get(edge.to).push({ to: edge.from, cost: edge.cost_m, kind: edge.kind });
  }

  const dist = new Map();
  const prev = new Map();
  const visited = new Set();
  for (const node of scene.nodes) dist.set(node.id, Infinity);
  dist.set(fromId, 0);

  // 节点数量在数百级，线性取最小即可，无需引入堆
  while (visited.size < scene.nodes.length) {
    let current = null;
    let best = Infinity;
    for (const [id, d] of dist) {
      if (!visited.has(id) && d < best) {
        best = d;
        current = id;
      }
    }
    if (current === null) break;
    if (current === toId) break;
    visited.add(current);

    for (const edge of adjacency.get(current) ?? []) {
      if (visited.has(edge.to)) continue;
      const candidate = best + edge.cost;
      if (candidate < dist.get(edge.to)) {
        dist.set(edge.to, candidate);
        prev.set(edge.to, { from: current, kind: edge.kind });
      }
    }
  }

  if (!Number.isFinite(dist.get(toId))) return { found: false };

  const chain = [];
  let cursor = toId;
  while (cursor !== fromId) {
    const step = prev.get(cursor);
    if (!step) return { found: false };
    chain.unshift({ to: cursor, from: step.from, kind: step.kind });
    cursor = step.from;
  }

  // 🔴 起点必须进 points：chain 只记录「跳到的节点」，不含起点本身。
  //    缺起点会连带四个可见缺陷（2026-11-21 实测复现）：
  //    ① 3D/2D 折线不从起点出发，第一段路不画；
  //    ② 前端把 polyline[0] 当起点标记，圆点画到第一个中间节点上；
  //    ③ 「途经」文案漏掉第一个中间地标；
  //    ④ 证据哈希不覆盖起点节点。
  const startNode = scene.nodes.find((n) => n.id === fromId);
  const points = [
    ...(startNode ? [startNode] : []),
    ...chain.map((s) => scene.nodes.find((n) => n.id === s.to)),
  ];
  const distanceM = dist.get(toId);
  return {
    found: true,
    points,
    steps: chain,
    distanceM,
    etaMin: Number((distanceM / WALK_SPEED_M_PER_MIN).toFixed(1)),
  };
}

/** 几何与拓扑的证据哈希：用来证明「这不是模型编的」 */
export function computeEvidence(scene, route) {
  const material = JSON.stringify({
    scene: scene.id,
    nodes: route.points.map((p) => [p.id, p.name, p.xy]),
    edges: route.steps.map((s) => [s.from, s.to, s.kind]),
  });
  return {
    source: 'scene-graph',
    sceneId: scene.id,
    nodeCount: scene.nodes.length,
    edgeCount: scene.edges.length,
    geometryHash: `sha256:${crypto.createHash('sha256').update(material).digest('hex').slice(0, 32)}`,
  };
}

/**
 * 从「从 A 到 B 怎么走」这类句式里解析起点与终点。
 * 不能靠「哪个名字更具体」来判断方向——必须按它们在句子里出现的顺序。
 */
export function parseEndpoints(scene, query) {
  const q = String(query ?? '');
  const patterns = [
    /从(.{1,24}?)(?:到|去|前往|走向)(.{1,24}?)(?:[?？]|$|怎么走|怎么去|如何走|有多远|多远|走路|步行|怎么到达|怎么抵达)/,
    /(.{1,24}?)(?:到|去|前往)(.{1,24}?)(?:[?？]|$|怎么走|怎么去|如何走|有多远|多远|走路|步行)/,
  ];

  for (const pattern of patterns) {
    const m = q.match(pattern);
    if (!m) continue;
    const from = findEntities(scene, m[1])[0];
    const to = findEntities(scene, m[2])[0];
    if (from && to && from.node.id !== to.node.id) return { from, to };
  }
  return null;
}

/** 场景里「有名字的」节点（排除路网中间节点） */
export function namedNodes(scene) {
  return scene.nodes.filter((n) => n.name && n.name !== n.id);
}

/** 同名地标去重（OSM 里「食堂」这种裸名常常有好几个） */
function dedupeByName(entities) {
  const seen = new Set();
  const out = [];
  for (const e of entities) {
    if (seen.has(e.node.name)) continue;
    seen.add(e.node.name);
    out.push(e);
  }
  return out;
}

/**
 * 主入口：回答一次导览请求。
 * 返回值同时包含「给 Agent 的结构化结果」与「给人看的文本」。
 */
export function answerGuide({ sceneId, query, originHint }) {
  const scene = getScene(sceneId);
  if (!scene) {
    return { ok: false, error: 'SCENE_NOT_FOUND', message: `未知场景：${sceneId}` };
  }

  // 🔴 起点参数与问题文本必须**分开**匹配：早期版本把两者拼成一段文本，
  //    终点在场景里匹配不到时会「借用」起点的匹配结果，
  //    退化成 起点→起点 的 0 米路线（实测：良渚问「到玉鸟集」→「从博物院到博物院 0 米」）。
  //    拆开后：问题实体只从 query 来；originHint 单独解析成起点候补。
  const entities = findEntities(scene, query ?? '');
  const originEntity = originHint ? (findEntities(scene, originHint)[0] ?? null) : null;
  const intent = detectIntent(query, entities, scene);

  const base = {
    scene: { id: scene.id, name: scene.name, description: scene.description },
    query,
    intent,
    candidates: [...entities, ...(originEntity ? [originEntity] : [])]
      .slice(0, 5)
      .map((e) => ({
        id: e.node.id,
        name: e.node.name,
        type: e.node.type,
        matched: e.matched,
      })),
  };

  if (intent === 'overview' || entities.length === 0) {
    const named = namedNodes(scene);
    const listed = named.slice(0, 10).map((n) => n.name);
    // 🔴 没有匹配到任何地标时，必须先说「没找到」，再给目录。
    //    旧行为直接甩一份 134 个地标的目录（还混着商店酒店），
    //    用户问「怎么去体育馆」得到的是一份购物清单——既没回答问题也没说没找到（实测复现）。
    //    只有确实是「随便看看」的问法（有什么/哪些/目录）才直接给目录。
    const browsing = /有什|哪|些|目录|介绍|列表|分布|多大|多少/.test(query);
    const miss = entities.length === 0 && !browsing && query.trim()
      ? `没有在${scene.name}里找到与「${query.trim().slice(0, 20)}」匹配的地标。`
      : '';
    const text =
      miss +
      `${scene.name}收录了 ${named.length} 个可导航地标` +
      `${listed.length ? `，例如${listed.join('、')}等` : ''}。告诉我起点和终点，我来规划路线。`;
    return { ok: true, ...base, answer: text, route: null, pois: [] };
  }

  if (intent === 'poi') {
    // 同名/同类地标可能有多个（多个食堂、多栋公寓），全部列出比只报一个有用。
    // 🔴 曾经按 name 去重——三个食堂被折成一个，与注释意图相反（实测复现）；
    //    改为按 node.id 去重，同名节点靠方位区分后全部列出。
    const hits = [...new Map(entities.map((e) => [e.node.id, e])).values()].slice(0, 6);
    const hit = hits[0];

    if (hits.length > 1) {
      const list = hits
        .map((h) => `${h.node.name}（${describePosition(scene, h.node)}）`)
        .join('、');
      const text =
        `${scene.name}内匹配到 ${hits.length} 个「${hit.matched}」类地标：${list}。` +
        `加上起点（例如「从图书馆到${hit.node.name}」）我可以给出路线。`;
      return {
        ok: true,
        ...base,
        answer: text,
        route: null,
        pois: hits.map((h) => poiOf(h.node)),
      };
    }

    const text = `${hit.node.name}位于${scene.name}${describePosition(scene, hit.node)}，类型为${typeLabel(hit.node.type)}。`;
    return {
      ok: true,
      ...base,
      answer: text,
      route: null,
      pois: [poiOf(hit.node)],
    };
  }

  // route / route_to_origin：先按句式解析起终点，解析不了再退回「候选顺序」
  const endpoints = parseEndpoints(scene, query);
  let toEntity = endpoints?.to ?? entities[0];
  // 起点优先级：句式解析 > origin 参数 > 问题文本里的第二个实体。
  // （originEntity 已在上面按 originHint 解析好）
  let fromEntity = endpoints?.from ?? originEntity ?? null;

  // 🔴 退回「第二个实体」之前，必须先判断用户是不是**只提了一类地方**。
  //    OSM 里同一类地标常有几十个节点（37 栋学生公寓、3 个食堂），
  //    此时 entities[1] 只是同类地标的另一份拷贝，拿它当起点会生成
  //    「从41号学生公寓到38号学生公寓，84 米」这种荒谬路线（实测复现）。
  //    判定：所有匹配名共享一个 ≥2 字且出现在问题里的公共词（如「学生公寓」）。
  if (!fromEntity) {
    const shared = sharedTerm(entities.map((e) => e.node.name), query);
    const singleConcept = Boolean(shared) && entities.length > 1;
    if (!singleConcept) {
      // 🔴 没有「从…到…」句式时，方向必须按地标在问题里的**出现顺序**定：
      //    用户先说「图书馆」就该以它为起点。旧实现按匹配得分排序，
      //    并列时退化成节点表顺序，会把方向倒过来（实测：「图书馆 教学楼 怎么走」
      //    → 「从教学楼到图书馆」）。
      const ordered = [...entities].sort(
        (a, b) => query.indexOf(a.matched) - query.indexOf(b.matched),
      );
      const from = ordered[0];
      const to = ordered[ordered.length - 1];
      if (from && to && from.node.id !== to.node.id) {
        fromEntity = from;
        toEntity = to;
      } else {
        fromEntity = entities.find((e) => e.node.id !== toEntity.node.id) ?? null;
      }
    }
  }

  if (!fromEntity) {
    // 只提到一个地标（或提到的多个是同一类地方）：说清情况，回问起点，
    // 而不是编一条「A 到 A」或同类互穿的路线。
    const shared = sharedTerm(entities.map((e) => e.node.name), query);
    const sameKind = Boolean(shared) && entities.length > 1;
    const what = sameKind
      ? `场景内有 ${entities.length} 个「${shared}」`
      : `已定位到${toEntity.node.name}`;
    const text = `${what}。告诉我你要去哪一个、从哪里出发（或在参数里带上 origin），我就能规划路线。`;
    return {
      ok: true,
      ...base,
      answer: text,
      route: null,
      pois: entities.slice(0, 6).map((e) => poiOf(e.node)),
    };
  }

  /**
   * 同名地标歧义处理。
   * OSM 里可能有多个同名建筑（三个「行政楼」）。如果只取第一个，
   * 很可能选到一个在路网里孤立的副本，路线就退化成直距估算。
   * 这里在候选集合里优先挑**能走通真实步道**的组合——
   * 这不是取巧，是「问路」本来就该给能走通的那个。
   */
  let resolved = { from: fromEntity, to: toEntity };
  if (!planRoute(scene, fromEntity.node.id, toEntity.node.id).found) {
    // 只在**同名候选**之间替换：用户问「行政楼」就只考虑各个「行政楼」，
    // 不能偷偷换成别的地标。跨名称配对虽然也能走通，但违背用户意图。
    const sameAs = (e, target) => e.node.name === target.node.name;
    const fromPool = entities.filter((e) => sameAs(e, fromEntity));
    const toPool = entities.filter((e) => sameAs(e, toEntity));

    let bestPair = null;
    for (const a of fromPool.length ? fromPool : [fromEntity]) {
      for (const b of toPool.length ? toPool : [toEntity]) {
        if (a.node.id === b.node.id) continue;
        const r = planRoute(scene, a.node.id, b.node.id);
        if (r.found && (!bestPair || r.distanceM < bestPair.distance)) {
          bestPair = { from: a, to: b, distance: r.distanceM };
        }
      }
    }
    if (bestPair) resolved = { from: bestPair.from, to: bestPair.to };
  }
  const fromFinal = resolved.from;
  const toFinal = resolved.to;

  // 🔴 同点守卫：起终点解析到同一个节点时，不输出「0 米路线」这种自欺欺人的答案。
  //    两种情况的话术必须分开（旧文案在 originHint 与目的地相同时，
  //    一边说「没找到图书馆」一边列出「图书馆」，自相矛盾——实测复现）。
  if (fromFinal.node.id === toFinal.node.id) {
    const byHint = originEntity && originEntity.node.id === toFinal.node.id;
    const named = namedNodes(scene);
    const listed = named.slice(0, 10).map((n) => n.name);
    const text = byHint
      ? `你给的起点和目的地都是「${toFinal.node.name}」——你已在该地点。换一个目的地，或告诉我真正的起点。`
      : `没有在${scene.name}里找到「${toFinal.matched}」这个目的地` +
        `（当前收录 ${named.length} 个可导航地标${listed.length ? `，例如${listed.join('、')}` : ''}）。` +
        `换一个目的地，或告诉我起点，我来重新规划。`;
    return { ok: true, ...base, answer: text, route: null, pois: [poiOf(fromFinal.node)] };
  }

  const route = planRoute(scene, fromFinal.node.id, toFinal.node.id);
  if (!route.found) {
    // OSM 路网在部分园区是碎片化的（步道被切成互不相连的几段）。
    // 这时不做「假装有路径」，而是退化为**明确标注的直距估算**：
    // 方位与直线距离来自真实坐标，可核验；步行时间标注为估算。
    const estimate = directEstimate(scene, fromFinal.node, toFinal.node);
    const text =
      `从${fromFinal.node.name}到${toFinal.node.name}，方位在${estimate.direction}，` +
      `直线距离约 ${estimate.distanceM} 米，步行约 ${estimate.etaMin} 分钟` +
      `（估算值，基于真实坐标的直线距离，未包含实际步行路径）。`;

    return {
      ok: true,
      ...base,
      answer: text,
      route: {
        type: 'direct-estimate',
        from: poiOf(fromFinal.node),
        to: poiOf(toFinal.node),
        points: [poiOf(fromFinal.node), poiOf(toFinal.node)],
        steps: [],
        distance_m: estimate.distanceM,
        eta_min: estimate.etaMin,
        bearing: estimate.bearing,
        direction: estimate.direction,
        measured: false,
        note: '该区域 OSM 步道数据不连通，此为基于真实坐标的直线距离估算',
      },
      pois: [poiOf(toFinal.node)],
      evidence: computeEvidence(scene, { points: [fromFinal.node, toFinal.node], steps: [] }),
    };
  }

  // 只把有名字的点位写进文字描述，内部路网节点不展示
  const namedPoints = route.points.filter((p) => p.name && p.name !== p.id);
  const via = namedPoints.slice(1, -1).map((p) => p.name).join('、');
  const text =
    `从${fromFinal.node.name}出发，` +
    (via ? `途经${via}，` : '沿园区步道直达，') +
    `到达${toFinal.node.name}，全程约 ${route.distanceM} 米，步行约 ${route.etaMin} 分钟。`;

  return {
    ok: true,
    ...base,
    answer: text,
    route: {
      type: 'walkway',
      measured: true,
      from: poiOf(fromFinal.node),
      to: poiOf(toFinal.node),
      // points 只给有名字的点位；完整折线由 polyline 承载（用于三维渲染）
      points: namedPoints.map(poiOf),
      polyline: route.points.map((p) => p.xy),
      steps: route.steps.map((s) => ({
        from: s.from,
        to: s.to,
        kind: s.kind,
        cost_m: scene.edges.find(
          (e) =>
            (e.from === s.from && e.to === s.to) || (e.from === s.to && e.to === s.from),
        )?.cost_m ?? null,
      })),
      distance_m: route.distanceM,
      eta_min: route.etaMin,
    },
    pois: [poiOf(toFinal.node)],
    evidence: computeEvidence(scene, route),
  };
}

/** 真实坐标下的直距估算 + 方位角 */
function directEstimate(scene, from, to) {
  const [x1, y1] = from.xy;
  const [x2, y2] = to.xy;
  const distanceM = Math.round(Math.hypot(x2 - x1, y2 - y1));
  const bearing = (Math.atan2(x2 - x1, y2 - y1) * 180) / Math.PI;
  return {
    distanceM,
    etaMin: Number((distanceM / WALK_SPEED_M_PER_MIN).toFixed(1)),
    bearing: Number(((bearing + 360) % 360).toFixed(1)),
    direction: bearingLabel(bearing),
  };
}

/** 方位角 → 中文方位 */
function bearingLabel(bearing) {
  const labels = ['正北', '东北', '正东', '东南', '正南', '西南', '正西', '西北'];
  const idx = Math.round(((bearing + 360) % 360) / 45) % 8;
  return labels[idx];
}

function poiOf(node) {
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    type_label: typeLabel(node.type),
    floor: node.floor ?? null,
    xy: node.xy,
    lonlat: node.lonlat,
  };
}

function typeLabel(type) {
  return (
    {
      gate: '出入口',
      plaza: '开放空间',
      building: '建筑',
      facility: '设施',
    }[type] ?? type
  );
}

/**
 * 一组地名是否共享同一个「出现在问题里」的公共词。
 *
 * 用途：判断用户是不是只提了一类地方。OSM 里同一类地标常有几十个节点
 * （37 栋学生公寓、3 个食堂），若把它们当中两个配成起终点，就会得到
 * 「从41号学生公寓到38号学生公寓」这种荒谬路线（实测复现）。
 *
 * @returns {string|null} 公共词（≥2 字且在 query 中出现），否则 null
 */
function sharedTerm(names, query) {
  if (names.length < 2) return null;
  const shortest = names.reduce((a, b) => (a.length <= b.length ? a : b));
  for (let len = shortest.length; len >= 2; len -= 1) {
    for (let start = 0; start + len <= shortest.length; start += 1) {
      const term = shortest.slice(start, start + len);
      if (!query.includes(term)) continue;
      if (names.every((n) => n.includes(term))) return term;
    }
  }
  return null;
}

/** 节点相对场景中心的方位（用于「X 位于场景的东北侧」这类描述）。
 *  导出给 quest.js 复用，避免两处各写一份、写法不一致。 */
export function describePosition(scene, node) {
  const xs = scene.nodes.map((n) => n.xy[0]);
  const ys = scene.nodes.map((n) => n.xy[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const dx = node.xy[0] - cx;
  const dy = node.xy[1] - cy;
  const vertical = dy > 40 ? '北' : dy < -40 ? '南' : '';
  const horizontal = dx > 40 ? '东' : dx < -40 ? '西' : '';
  // 组合方位必须用标准语序：东北/东南/西南/西北。
  // 🔴 曾经直接拼 `${vertical}${horizontal}`，dy<0 且 dx<0 时输出「南西侧」（实测复现）。
  if (vertical && horizontal) {
    const combos = { 北东: '东北', 南东: '东南', 南西: '西南', 北西: '西北' };
    return `的${combos[`${vertical}${horizontal}`] ?? `${vertical}${horizontal}`}侧`;
  }
  return `的${vertical || horizontal || '中部'}侧`;
}
