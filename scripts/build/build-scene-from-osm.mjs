#!/usr/bin/env node
/**
 * 从 OpenStreetMap 生成场景数据。
 *
 * 输出的 scene 对象与 src/scene/scenes.js 的数据契约完全一致，
 * 因此可以直接替换掉演示场景，把「示范园区」换成真实的校园/景区。
 *
 * 用法：
 *   node scripts/build/build-scene-from-osm.mjs --bbox 30.3130,120.1500,30.3230,120.1700 \
 *     --scene-id zjgsu-xiasha --scene-name "浙江工商大学下沙校区" \
 *     --out data/scenes/zjgsu-xiasha.json
 *
 * 数据来源：Overpass API（https://overpass-api.de/api/interpreter）
 * 抽取内容：
 *   - 可步行路网（highway=footway/path/pedestrian/living_street/service/road/track）
 *   - 有名字的建筑（building=* 且 name）
 *   - 设施（amenity / shop / tourism / leisure / emergency）
 *   - 出入口（entrance / barrier）
 * 节点图由 way 的公共端点缝合而成，边权为 way 的实际长度。
 */

import fs from 'node:fs';
import path from 'node:path';

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const WALKABLE_HIGHWAYS = new Set([
  'footway', 'path', 'pedestrian', 'living_street', 'service', 'road',
  'track', 'steps', 'cycleway', 'bridleway',
]);

const AMENITY_KEYS = ['amenity', 'shop', 'tourism', 'leisure', 'emergency', 'office', 'craft'];

/** 噪声 POI：与导览无关或密度过高 */
const NOISY_AMENITY = new Set([
  'bicycle_parking', 'bicycle_rental', 'parking_space', 'parking_entrance',
  'vending_machine', 'waste_basket', 'waste_disposal', 'bench', 'drinking_water',
  'bicycle_repair_station', 'atm', 'fuel', 'charging_station',
]);
const NOISY_NAME_PATTERN = /自行车租赁点|自行车停放点|垃圾箱|消火栓|路灯/;

/** 判断一个 POI 是否值得收录 */
function isUsefulPoi(tags) {
  if (!tags?.name) return false;
  if (tags.name === 'yes' || tags.name === 'true') return false;
  if (NOISY_NAME_PATTERN.test(tags.name)) return false;
  if (tags.amenity && NOISY_AMENITY.has(tags.amenity)) return false;
  const kind =
    tags.building || tags.amenity || tags.shop || tags.tourism ||
    tags.leisure || tags.emergency || tags.office || tags.craft;
  return Boolean(kind);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    // --scene-id → sceneId
    const key = token.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1; // 消费掉值，避免被当作下一个参数
    }
  }
  return args;
}

/** 计算经纬度两点间的近似距离（米），球面近似 */
function haversine(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** 构造 Overpass 查询语句 */
function buildQuery(bbox) {
  const [s, w, n, e] = bbox;
  const bboxStr = `${s},${w},${n},${e}`;

  return `
[out:json][timeout:180];
(
  way["highway"~"^(footway|path|pedestrian|living_street|service|road|track|steps)$"](${bboxStr});
  way["building"]["name"](${bboxStr});
  way["amenity"](${bboxStr});
  way["shop"](${bboxStr});
  way["tourism"](${bboxStr});
  way["leisure"](${bboxStr});
  way["emergency"](${bboxStr});
  way["office"](${bboxStr});
  node["amenity"](${bboxStr});
  node["shop"](${bboxStr});
  node["tourism"](${bboxStr});
  node["leisure"](${bboxStr});
  node["entrance"](${bboxStr});
);
out body geom;
`.trim();
}

async function fetchOverpass(query) {
  let lastError = null;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
            // Overpass 拒绝没有 User-Agent 的请求（406）
            'User-Agent': 'scene-guide-osm-builder/1.0 (PAYATHON 2026 demo project)',
            Accept: 'application/json',
          },
          body: new URLSearchParams({ data: query }).toString(),
          signal: AbortSignal.timeout(180000),
        });
        if (res.status === 429) {
          console.error(`  ${endpoint} 限流（429），${attempt * 8}s 后重试`);
          await sleep(attempt * 8000);
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      } catch (err) {
        lastError = err;
        console.error(`  Overpass ${endpoint} 失败：${err.message}`);
        await sleep(attempt * 5000);
      }
    }
  }
  throw lastError ?? new Error('所有 Overpass 端点均不可用');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 判断一个 way/节点是不是命名地标（值得作为 POI 收进场景） */
function isNamedPoi(tags) {
  return isUsefulPoi(tags);
}

/**
 * 按名称在 OSM 中定位一个场所，返回其中心点与外接 bbox。
 * 用于避免手写 bbox 时找错区域（杭州几个「浙江工商大学」条目分属不同校区）。
 */
async function searchPlace(name, radiusM = 1200) {
  const query = `
[out:json][timeout:90];
(
  nwr["name"~"${name}"];
);
out center tags;
`.trim();

  const raw = await fetchOverpass(query);
  const candidates = (raw?.elements ?? []).filter((el) => {
    const n = el.tags?.name ?? '';
    return n.includes(name) || name.includes(n);
  });
  if (candidates.length === 0) throw new Error(`OSM 中未找到名称包含「${name}」的要素`);

  // 优先取 relation（完整建筑群），其次 area/way，最后 node
  const rank = { relation: 0, way: 1, node: 2 };
  candidates.sort((a, b) => (rank[a.type] ?? 3) - (rank[b.type] ?? 3));

  const center = candidates[0].center ?? { lat: candidates[0].lat, lon: candidates[0].lon };
  const dLat = radiusM / 110540;
  const dLon = radiusM / (111320 * Math.cos((center.lat * Math.PI) / 180));

  console.log(`▸ 定位命中：${candidates[0].tags?.name} (${candidates[0].type})`);
  console.log(`▸ 候选要素 ${candidates.length} 个，取最优匹配`);

  return {
    center: [center.lon, center.lat],
    bbox: [center.lon - dLon, center.lat - dLat, center.lon + dLon, center.lat + dLat],
    candidates: candidates.slice(0, 8).map((c) => `${c.type}: ${c.tags?.name ?? '?'}`),
  };
}

/** 判断是不是可作为步行边的高架路网 */
function isWalkableWay(tags) {
  if (!tags?.highway) return false;
  if (!WALKABLE_HIGHWAYS.has(tags.highway)) return false;
  if (tags.access === 'private' || tags.access === 'no') return false;
  if (tags.highway === 'service' && tags.service && !['parking_aisle', 'driveway'].includes(tags.service)) {
    // service 道路大多是停车场内部，不作为主要通路
  }
  return true;
}

async function main() {
  const args = parseArgs(process.argv);
  const sceneId = String(args.sceneId ?? 'osm-scene');
  const sceneName = String(args.sceneName ?? sceneId);
  const outFile = String(args.out ?? `data/scenes/${sceneId}.json`);

  let bbox; // [south, west, north, east]
  if (args.search) {
    const radius = Number(args.radius ?? 1200);
    console.log(`▸ 按名称定位：${args.search}（半径 ${radius}m）`);
    const found = await searchPlace(String(args.search), radius);
    for (const c of found.candidates) console.log(`    · ${c}`);
    bbox = found.bbox;
  } else {
    bbox = String(args.bbox ?? '30.3126,120.3837,30.3126,120.3837').split(',').map(Number);
  }

  console.log(`▸ 场景    : ${sceneName} (${sceneId})`);
  console.log(`▸ bbox   : ${bbox.join(', ')}`);
  console.log(`▸ 拉取 OSM 数据…`);

  const raw = await fetchOverpass(buildQuery(bbox));
  const elements = raw?.elements ?? [];
  console.log(`▸ 拿到 ${elements.length} 个 OSM 元素`);

  // ── 1. 建立可步行图 ─────────────────────────────────────
  //
  // OSM 的 way 端点坐标不保证能对上：同一条路在不同 way 里可能是各自独立的节点，
  // 坐标还差几米。只按「坐标完全相同」缝合会让路网碎成一堆互不连通的孤岛。
  // 这里改用并查集：把相距 STITCH_RADIUS_M 以内的端点并成一个图节点。
  const STITCH_RADIUS_M = 12;

  const rawPoints = []; // {lon, lat}
  const rawEdges = []; // {a: pointIndex, b: pointIndex, kind}

  for (const el of elements) {
    if (el.type !== 'way' || !el.geometry) continue;
    if (!isWalkableWay(el.tags)) continue;
    const geom = el.geometry;
    if (geom.length < 2) continue;

    // Overpass 的 `out body geom` 返回的是 way 的**完整几何**，
    // 哪怕它只是擦过 bbox 的一个角。所以必须自己按 bbox 裁剪，
    // 否则一条长路会把整个场景的包围盒撑到几公里外。
    // bbox 顺序是 [south, west, north, east]
    const inBox = (lon, lat) =>
      lon >= bbox[1] && lon <= bbox[3] && lat >= bbox[0] && lat <= bbox[2];

    let prev = -1;
    for (const pt of geom) {
      if (!inBox(pt.lon, pt.lat)) {
        prev = -1; // 出了 bbox 就断开，不能跨边界连边
        continue;
      }
      const idx = rawPoints.length;
      rawPoints.push({ lon: pt.lon, lat: pt.lat });
      if (prev >= 0) rawEdges.push({ a: prev, b: idx, kind: el.tags.highway });
      prev = idx;
    }
  }

  // 并查集 + 网格分桶，把邻近端点合并
  const parent = rawPoints.map((_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (x, y) => {
    const rx = find(x);
    const ry = find(y);
    if (rx !== ry) parent[ry] = rx;
  };

  const graphMidLat = rawPoints.length
    ? rawPoints.reduce((s, p) => s + p.lat, 0) / rawPoints.length
    : 30;
  const mPerDegLon = 111320 * Math.cos((graphMidLat * Math.PI) / 180);
  const mPerDegLat = 110540;
  const cellDegLat = STITCH_RADIUS_M / mPerDegLat;
  const cellDegLon = STITCH_RADIUS_M / mPerDegLon;

  const grid = new Map();
  const cellKey = (lon, lat) => `${Math.floor(lon / cellDegLon)}:${Math.floor(lat / cellDegLat)}`;
  for (let i = 0; i < rawPoints.length; i += 1) {
    const p = rawPoints[i];
    const cx = Math.floor(p.lon / cellDegLon);
    const cy = Math.floor(p.lat / cellDegLat);
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        const bucket = grid.get(`${cx + dx}:${cy + dy}`);
        if (!bucket) continue;
        for (const j of bucket) {
          const q = rawPoints[j];
          const d = haversine([p.lon, p.lat], [q.lon, q.lat]);
          if (d <= STITCH_RADIUS_M) union(i, j);
        }
      }
    }
    const key = `${cx}:${cy}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(i);
  }

  // 为每个连通分量生成一个图节点，位置取分量内点的平均
  const groupId = new Map();
  const groupPos = new Map();
  for (let i = 0; i < rawPoints.length; i += 1) {
    const root = find(i);
    if (!groupId.has(root)) {
      groupId.set(root, `w_${groupId.size}`);
      groupPos.set(root, { lon: 0, lat: 0, n: 0 });
    }
    const acc = groupPos.get(root);
    acc.lon += rawPoints[i].lon;
    acc.lat += rawPoints[i].lat;
    acc.n += 1;
  }
  for (const [root, acc] of groupPos) {
    acc.lon /= acc.n;
    acc.lat /= acc.n;
  }

  const graphNodes = new Map();
  for (const [root, id] of groupId) {
    const acc = groupPos.get(root);
    graphNodes.set(id, { id, lonlat: [acc.lon, acc.lat] });
  }

  const edges = [];
  const edgeSeen = new Set();
  for (const re of rawEdges) {
    const idA = groupId.get(find(re.a));
    const idB = groupId.get(find(re.b));
    if (!idA || !idB || idA === idB) continue;

    const dedupeKey = [idA, idB].sort().join('|');
    if (edgeSeen.has(dedupeKey)) continue;
    edgeSeen.add(dedupeKey);

    const cost = Math.round(
      haversine(graphNodes.get(idA).lonlat, graphNodes.get(idB).lonlat),
    );
    if (cost <= 0) continue;
    edges.push({ from: idA, to: idB, cost_m: cost, kind: re.kind });
  }

  // ── 2. 把命名地标吸附到最近的路网节点 ─────────────────────
  const poiList = [];
  const footprints = []; // 带轮廓的建筑，用于三维体块
  for (const el of elements) {
    if (!isNamedPoi(el.tags)) continue;
    let lonlat = null;
    let ring = null;
    if (el.type === 'node') lonlat = [el.lon, el.lat];
    else if (el.geometry?.length) {
      const mid = el.geometry[Math.floor(el.geometry.length / 2)];
      lonlat = [mid.lon, mid.lat];
      // 建筑是多边形，保留完整轮廓供三维体块拉伸
      if (el.geometry.length >= 3 && el.tags.building) {
        ring = el.geometry.map((g) => [g.lon, g.lat]);
      }
    }
    if (!lonlat) continue;

    let nearest = null;
    let nearestDist = Infinity;
    for (const node of graphNodes.values()) {
      const d = haversine(lonlat, node.lonlat);
      if (d < nearestDist) {
        nearestDist = d;
        nearest = node;
      }
    }
    if (!nearest) continue;

    const type =
      el.tags.entrance ? 'gate'
      : el.tags.building ? 'building'
      : el.tags.amenity === 'parking' ? 'facility'
      : 'facility';

    const nodeId = `poi_${el.type}_${el.id}`;
    if (!graphNodes.has(nodeId)) {
      graphNodes.set(nodeId, { id: nodeId, lonlat, poi: true });
      // 离路网太远的建筑（如独立的大型楼体）保留为孤立点：
      // 它仍然是可被问答的命名地标，走不到的部分由内核用直距估算并明确标注。
      if (nearestDist <= 250) {
        edges.push({ from: nearest.id, to: nodeId, cost_m: Math.round(nearestDist), kind: 'path' });
      }
    }

    if (ring) {
      const levels = Number(el.tags['building:levels'] ?? 0) || 0;
      const heightTag = Number(el.tags.height ?? 0) || 0;
      footprints.push({
        id: nodeId,
        name: el.tags.name,
        ring,
        levels: levels || null,
        heightM: heightTag || null,
        kind: el.tags.building,
      });
    }

    poiList.push({
      id: nodeId,
      nearest: nearest.id, // 所属的路网节点，用于连通性统计
      name: el.tags.name,
      type,
      aliases: [],
      floor: null,
      xy: [0, 0],            // 由下面的局部坐标换算填充
      lonlat,
      source: el.tags['source'] ?? 'openstreetmap',
      osmType: el.type,
      osmId: el.id,
    });
  }

  // ── 3. 连通性分析（用于验证缝合是否奏效）────────────────────
  const compOf = new Map();
  let compCount = 0;
  const adjacency = new Map();
  for (const e of edges) {
    if (!adjacency.has(e.from)) adjacency.set(e.from, []);
    if (!adjacency.has(e.to)) adjacency.set(e.to, []);
    adjacency.get(e.from).push(e.to);
    adjacency.get(e.to).push(e.from);
  }
  for (const node of graphNodes.keys()) {
    if (compOf.has(node)) continue;
    const comp = compCount++;
    const stack = [node];
    compOf.set(node, comp);
    while (stack.length) {
      const cur = stack.pop();
      for (const next of adjacency.get(cur) ?? []) {
        if (compOf.has(next)) continue;
        compOf.set(next, comp);
        stack.push(next);
      }
    }
  }
  const compSizes = new Map();
  for (const c of compOf.values()) compSizes.set(c, (compSizes.get(c) ?? 0) + 1);
  const largestComp = Math.max(0, ...compSizes.values());

  // 命名地标按名字去重后，统计同分量内的点对数 —— 即「可走实测步道」的点对
  const namedByName = new Map();
  for (const p of poiList) {
    if (!namedByName.has(p.name)) namedByName.set(p.name, []);
    namedByName.get(p.name).push(p);
  }
  const uniqueNamed = [...namedByName.values()].map((arr) => arr[0]);
  const perComp = new Map();
  for (const n of uniqueNamed) {
    const c = compOf.get(n.nearest);
    if (c === undefined) continue;
    perComp.set(c, (perComp.get(c) ?? 0) + 1);
  }
  let reachablePairs = 0;
  for (const c of perComp.values()) reachablePairs += (c * (c - 1)) / 2;
  const isolatedLandmarks = uniqueNamed
    .filter((n) => {
      const c = compOf.get(n.nearest);
      return c === undefined || (perComp.get(c) ?? 0) < 2;
    })
    .map((n) => n.name);

  console.log(`▸ 连通分量 : ${compSizes.size} 个，最大分量 ${largestComp} 个节点`);
  console.log(`▸ 连通率   : ${((largestComp / Math.max(1, graphNodes.size)) * 100).toFixed(1)}%`);
  console.log(`▸ 可走实测步道的地标点对 : ${reachablePairs} 对（孤立 ${isolatedLandmarks.length} 个）`);

  // ── 4. 转成以米为单位的局部平面坐标 ───────────────────────
  const lons = [...graphNodes.values()].map((n) => n.lonlat[0]);
  const lats = [...graphNodes.values()].map((n) => n.lonlat[1]);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);

  const toLocal = (lonlat) => [
    Math.round((lonlat[0] - minLon) * mPerDegLon),
    Math.round((lonlat[1] - minLat) * mPerDegLat),
  ];

  const nodes = [...graphNodes.values()].map((n) => ({
    id: n.id,
    name: poiList.find((p) => p.id === n.id)?.name ?? n.id,
    type: poiList.find((p) => p.id === n.id)?.type ?? 'path',
    aliases: [],
    floor: null,
    xy: toLocal(n.lonlat),
    lonlat: n.lonlat,
  }));

  // 建筑轮廓转局部平面坐标（米）
  for (const f of footprints) {
    f.ring = f.ring.map(([lon, lat]) => [
      Math.round((lon - minLon) * mPerDegLon),
      Math.round((lat - minLat) * mPerDegLat),
    ]);
    // 面积（鞋带公式）用于在没有 levels / height 时估算层数
    const ring = f.ring;
    let area = 0;
    for (let i = 0; i < ring.length; i += 1) {
      const j = (i + 1) % ring.length;
      area += ring[i][0] * ring[j][1] - ring[j][0] * ring[i][1];
    }
    f.footprintM2 = Math.round(Math.abs(area) / 2);
    if (!f.heightM) {
      const levels = f.levels || Math.max(1, Math.min(12, Math.round(f.footprintM2 / 900) + 1));
      f.levels = levels;
      f.heightM = Math.round(levels * 3.4);
    }
  }

  const namedNodes = nodes.filter((n) => !n.id.startsWith('w_'));
  const namedEdges = edges
    .filter((e) => namedNodes.some((n) => n.id === e.from) || namedNodes.some((n) => n.id === e.to))
    .concat(
      // 保留纯路网边用于路径计算
      [],
    );

  const scene = {
    id: sceneId,
    name: sceneName,
    description: `基于 OpenStreetMap 生成的真实场景（${namedNodes.length} 个命名点位 / ${edges.length} 条路网边）`,
    bbox: [minLon, minLat, maxLon, maxLat],
    generatedAt: new Date().toISOString(),
    source: 'openstreetmap',
    attribution: '© OpenStreetMap contributors (ODbL)',
    nodes,
    edges,
    footprints,
    namedEdgeCount: namedEdges.length,
    connectivity: {
      components: compSizes.size,
      largestComponentNodes: largestComp,
      uniqueLandmarks: uniqueNamed.length,
      reachablePairs,
      isolatedLandmarks,
    },
  };

  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(scene, null, 2));

  console.log(`▸ 命名点位 : ${namedNodes.length}`);
  console.log(`▸ 建筑轮廓 : ${footprints.length}`);
  console.log(`▸ 可走实测步道的地标点对 : ${reachablePairs} 对（孤立 ${isolatedLandmarks.length} 个）`);
  console.log(`▸ 路网节点 : ${nodes.length}`);
  console.log(`▸ 可行边   : ${edges.length}`);
  console.log(`▸ 输出     : ${outFile}`);
  console.log(`▸ 版权声明 : ${scene.attribution}`);
}

main().catch((err) => {
  console.error(`✗ 失败：${err.message}`);
  process.exit(1);
});
