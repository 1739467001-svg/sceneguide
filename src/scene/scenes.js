/**
 * 场景数据。
 *
 * 数据契约（与 OSM 产物一一对应）：
 *   node = { id, name, type, aliases[], floor, xy:[x,y](米), lonlat:[lon,lat] }
 *   edge = { from, to, cost_m, kind: 'road'|'path'|'indoor' }
 *
 * ⚠️ 这里的示范园区是 **演示级几何数据**（坐标为示意值），
 *    目的是让 402 付费链路与导览内核可以立刻端到端跑通。
 *    正式场景请用 `scripts/build-scene-from-osm.mjs` 从 OpenStreetMap
 *    拉取真实几何（商大元境已有的 OSM 重建管线可直接复用），
 *    生成同构的 scene 对象后替换此处。
 */

import fs from 'node:fs';
import path from 'node:path';

export const DEMO_SCENE = {
  id: 'demo-park',
  name: '示范园区',
  description: '用于验证 Agent 可采购的导览服务的演示场景',
  bbox: [120.1500, 30.2600, 120.1700, 30.2750],
  nodes: [
    { id: 'gate_s', name: '南门', type: 'gate', aliases: ['正门', '南入口'], xy: [0, 0], lonlat: [120.1500, 30.2600] },
    { id: 'gate_n', name: '北门', type: 'gate', aliases: ['北入口'], xy: [400, 0], lonlat: [120.1600, 30.2600] },
    { id: 'plaza', name: '中心广场', type: 'plaza', aliases: ['广场'], xy: [200, 220], lonlat: [120.1550, 30.2640] },
    { id: 'lib', name: '图书馆', type: 'building', aliases: ['图书楼', 'library'], xy: [120, 300], lonlat: [120.1530, 30.2662] },
    { id: 'teach', name: '教学楼', type: 'building', aliases: ['教楼', 'teaching'], xy: [300, 330], lonlat: [120.1580, 30.2670] },
    { id: 'lab', name: '实验楼', type: 'building', aliases: ['实验楼A', 'lab'], xy: [340, 190], lonlat: [120.1590, 30.2636] },
    { id: 'canteen', name: '第一食堂', type: 'facility', aliases: ['食堂', '餐厅'], xy: [90, 120], lonlat: [120.1522, 30.2625] },
    { id: 'cafe', name: '咖啡角', type: 'facility', aliases: ['咖啡馆', 'cafe'], xy: [240, 170], lonlat: [120.1562, 30.2632] },
    { id: 'gym', name: '体育馆', type: 'facility', aliases: ['体育场馆', 'gym'], xy: [430, 250], lonlat: [120.1612, 30.2650] },
    { id: 'dorm', name: '学生公寓', type: 'building', aliases: ['宿舍', '公寓'], xy: [380, 90], lonlat: [120.1597, 30.2612] },
    { id: 'parking', name: '地下停车场', type: 'facility', aliases: ['停车场', 'parking'], xy: [60, 60], lonlat: [120.1515, 30.2611] },
    { id: 'medical', name: '校医院', type: 'facility', aliases: ['医务室', 'clinic'], xy: [150, 60], lonlat: [120.1540, 30.2610] },
  ],
  edges: [
    { from: 'gate_s', to: 'plaza', cost_m: 260, kind: 'road' },
    { from: 'gate_s', to: 'canteen', cost_m: 150, kind: 'road' },
    { from: 'gate_s', to: 'parking', cost_m: 80, kind: 'road' },
    { from: 'gate_n', to: 'teach', cost_m: 350, kind: 'road' },
    { from: 'gate_n', to: 'gym', cost_m: 260, kind: 'road' },
    { from: 'plaza', to: 'lib', cost_m: 130, kind: 'road' },
    { from: 'plaza', to: 'teach', cost_m: 160, kind: 'road' },
    { from: 'plaza', to: 'lab', cost_m: 150, kind: 'path' },
    { from: 'plaza', to: 'cafe', cost_m: 60, kind: 'path' },
    { from: 'plaza', to: 'canteen', cost_m: 160, kind: 'path' },
    { from: 'plaza', to: 'medical', cost_m: 180, kind: 'path' },
    { from: 'lib', to: 'teach', cost_m: 185, kind: 'road' },
    { from: 'teach', to: 'lab', cost_m: 145, kind: 'path' },
    { from: 'teach', to: 'gym', cost_m: 180, kind: 'path' },
    { from: 'lab', to: 'dorm', cost_m: 130, kind: 'path' },
    { from: 'dorm', to: 'gate_n', cost_m: 120, kind: 'road' },
    { from: 'canteen', to: 'medical', cost_m: 100, kind: 'path' },
    { from: 'medical', to: 'dorm', cost_m: 235, kind: 'path' },
    { from: 'cafe', to: 'lab', cost_m: 105, kind: 'path' },
  ],
};

export const SCENES = new Map([[DEMO_SCENE.id, DEMO_SCENE]]);

/**
 * 加载磁盘上的真实场景（由 scripts/build-scene-from-osm.mjs 生成）。
 * 这样「演示场景」与「真实 OSM 场景」走完全相同的内核与付费链路，
 * 只是数据来源不同。
 */
function loadScenesFromDisk() {
  const dir = path.resolve(process.cwd(), 'data', 'scenes');
  if (!fs.existsSync(dir)) return;

  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const scene = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      if (!scene?.id || !Array.isArray(scene.nodes) || !Array.isArray(scene.edges)) continue;
      SCENES.set(scene.id, scene);
    } catch (err) {
      console.error(`[scenes] 跳过无法解析的场景文件 ${file}: ${err.message}`);
    }
  }
}

loadScenesFromDisk();

export function getScene(sceneId) {
  return SCENES.get(sceneId) ?? null;
}

export function listScenes() {
  return [...SCENES.values()].map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    source: s.source ?? 'builtin',
    nodes: s.nodes.length,
    edges: s.edges.length,
    namedPois: s.nodes.filter((n) => !n.id.startsWith('w_')).length,
    connectivity: s.connectivity ?? null,
  }));
}
