/**
 * 三维场景渲染（Three.js）
 *
 * 场景数据来自 OpenStreetMap：
 *   - 建筑轮廓 → 拉伸为体块（层数/高度优先取 OSM tags，缺失时按占地估算）
 *   - 路网     → 贴地线带
 *   - 命名地标 → 光柱信标
 *   - 路线     → 沿路径的发光管
 *
 * 坐标系：OSM 局部平面坐标为 (x 东, y 北) 米制，转 three.js 时 y 轴向上、-z 朝北。
 */

import * as THREE from './vendor/three.module.js';
import { OrbitControls } from './vendor/OrbitControls.js';

/**
 * 建筑高度夸张系数。
 * 真实尺度下：校区 1.9km 宽、楼高 10–40m，从远处看几乎不可见。
 * 城市可视化普遍用 1.5–3 倍夸张让体块读得出来 —— 这里取 2.2，
 * 界面上明确标注「高度已夸张 ×3.0」，不做无声处理。
 */
const HEIGHT_SCALE = 3.0;

const COLORS = {
  building: 0x4d84e0,
  buildingTall: 0x7fb2ff,
  facility: 0x18a882,
  road: 0x3d5a8c,
  route: 0x22d3a6,
  origin: 0x4d8dff,
  target: 0xffb020,
  ground: 0x080c17,
  fog: 0x070b16,
};

export function createScene3D(canvas, data, opts = {}) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // ACES 会把深蓝场景的中间调压得很死，这里改用线性映射 + 提高曝光，
  // 让建筑体块的蓝色与描边都读得出来
  renderer.toneMapping = THREE.LinearToneMapping;
  renderer.toneMappingExposure = 1.35;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(COLORS.fog);
  // 🔴 雾密度必须随取景跨度缩放：0.00042 是按下沙（span≈340m、相机≈310m）调的，
  //    换到 span 1600 的稀疏场景时相机拉到 ~1470m，远处建筑会被雾整体吞掉
  //    （实测：良渚三维除质心附近外全部隐入雾中）。比例保持「340m 视距下的雾感」不变。
  const FOG_DENSITY_AT_340 = 0.00042;
  const sceneFog = new THREE.FogExp2(COLORS.fog, FOG_DENSITY_AT_340);
  scene.fog = sceneFog;

  const camera = new THREE.PerspectiveCamera(46, 1, 1, 6000);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.minDistance = 40;
  controls.maxDistance = 1800;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.minPolarAngle = 0.08;

  // ── 场景范围 ─────────────────────────────────────────────
  const nodes = data.graph?.nodes ?? [];
  const xs = nodes.map((n) => n[0]);
  const ys = nodes.map((n) => n[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const toWorld = (x, y, h = 0) => new THREE.Vector3(x - cx, h, -(y - cy));

  // ── 取景中心（命名地标密集区，优于整个校园包围盒）────────────
  const poiPts = (data.pois ?? []).map((p) => toWorld(p.xy[0], p.xy[1], 0));
  // 建筑足迹中心点并入取景集合：良渚这类 POI 与建筑群分布错位的场景，
  // 只看 POI 会把主体建筑切出画面（实测：画面只剩质心附近一小团）
  const bldPts = (data.footprints ?? [])
    .filter((f) => f.ring?.length >= 3 && !/[路街道巷弄]$/.test(f.name ?? ''))
    .map((f) => {
      const xs = f.ring.map((r) => r[0]);
      const ys = f.ring.map((r) => r[1]);
      return toWorld((Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2, 0);
    });
  const framePts = [...poiPts, ...bldPts];
  const focus = new THREE.Vector3(0, 0, 0);
  let focusSpan = Math.max(spanX, spanY);
  if (framePts.length) {
    const fx = framePts.map((p) => p.x);
    const fz = framePts.map((p) => p.z);
    focus.set((Math.min(...fx) + Math.max(...fx)) / 2, 0, (Math.min(...fz) + Math.max(...fz)) / 2);
    // 🔴 相机跨度必须随场景密度自适应：340m 上限是为「下沙 134 地标挤在一起」调的，
    //    良渚这类「36 地标散布 4km」的场景会被切成只剩质心附近一小团（实测画面几乎全空）。
    //    稀疏场景放宽到联合分布的实际范围（上限 1600m，再远建筑就小到没有信息量）。
    const frameSpan = Math.max(
      Math.max(...fx) - Math.min(...fx),
      Math.max(...fz) - Math.min(...fz),
    );
    focusSpan = Math.max(
      180,
      Math.min(frameSpan, poiPts.length >= 40 ? 340 : 2200),
    );
    // 雾密度随视距反向缩放（见上方 FOG_DENSITY_AT_340 注释）
    sceneFog.density = FOG_DENSITY_AT_340 * (340 / focusSpan);
  }

  // ── 地面 ─────────────────────────────────────────────────
  const groundSize = Math.max(spanX, spanY) * 1.5 + 200;
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(groundSize, groundSize),
    new THREE.MeshStandardMaterial({ color: 0x0a1020, roughness: 0.98, metalness: 0.0 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const grid = new THREE.GridHelper(groundSize, Math.round(groundSize / 100), 0x16213c, 0x0f1729);
  grid.position.y = 0.12;
  grid.material.transparent = true;
  grid.material.opacity = 0.22;
  scene.add(grid);

  // ── 建筑体块 ─────────────────────────────────────────────
  const buildingGroup = new THREE.Group();
  const edgeGroup = new THREE.Group();
  let tallest = 0;

  for (const f of data.footprints ?? []) {
    if (!f.ring || f.ring.length < 3) continue;
    // 道路类误标为 building 的要素不建体块
    if (/[路街道巷弄]$/.test(f.name ?? '')) continue;

    const shape = new THREE.Shape();
    const pts = f.ring.map(([x, y]) => new THREE.Vector2(x - cx, -(y - cy)));

    // three.js 的 Shape 要求**逆时针**缠绕。
    // OSM 的建筑环在经纬度里通常是顺时针的，再叠一次 y 取反后方向会反过来，
    // 拉伸出来的体块法线朝内 → 被背面剔除 → 只剩描边线、看不到实体。
    // 这里统一成逆时针。
    let area = 0;
    for (let i = 0; i < pts.length; i += 1) {
      const j = (i + 1) % pts.length;
      area += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
    }
    if (area < 0) pts.reverse();

    shape.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i += 1) shape.lineTo(pts[i].x, pts[i].y);
    shape.closePath();

    const height = Math.max(4, Math.min(f.heightM ?? 14, 120)) * HEIGHT_SCALE;
    tallest = Math.max(tallest, height);

    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: height,
      bevelEnabled: false,
      curveSegments: 1,
    });
    geo.rotateX(-Math.PI / 2);

    const t = Math.min(1, height / 80);
    const color = new THREE.Color(COLORS.building).lerp(new THREE.Color(COLORS.buildingTall), t);
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({
        color,
        roughness: 0.58,
        metalness: 0.1,
        flatShading: true,
        // DoubleSide：OSM 建筑环的缠绕方向不保证一致，正反面都画最稳
        side: THREE.DoubleSide,
        emissive: new THREE.Color(color).multiplyScalar(0.55),
      }),
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.name = f.name;
    buildingGroup.add(mesh);

    // 描边：建筑体块的轮廓线是「专业渲染感」的关键
    const edge = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo, 24),
      new THREE.LineBasicMaterial({
        color: new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.55),
        transparent: true,
        opacity: 0.4,
      }),
    );
    edge.position.copy(mesh.position);
    edgeGroup.add(edge);
  }
  scene.add(buildingGroup, edgeGroup);

  // ── 路网 ─────────────────────────────────────────────────
  const edgeList = data.graph?.edges ?? [];
  const roadPos = new Float32Array(edgeList.length * 6);
  let k = 0;
  for (const [a, b] of edgeList) {
    const p = nodes[a];
    const q = nodes[b];
    if (!p || !q) continue;
    const A = toWorld(p[0], p[1], 0.3);
    const B = toWorld(q[0], q[1], 0.3);
    roadPos[k++] = A.x; roadPos[k++] = A.y; roadPos[k++] = A.z;
    roadPos[k++] = B.x; roadPos[k++] = B.y; roadPos[k++] = B.z;
  }
  const roadGeo = new THREE.BufferGeometry();
  roadGeo.setAttribute('position', new THREE.BufferAttribute(roadPos, 3));
  scene.add(
    new THREE.LineSegments(
      roadGeo,
      new THREE.LineBasicMaterial({ color: COLORS.road, transparent: true, opacity: 0.85 }),
    ),
  );

  // ── 地标信标 ─────────────────────────────────────────────
  const beaconGroup = new THREE.Group();
  const beaconById = new Map();
  for (const p of data.pois ?? []) {
    const h = p.type === 'building' ? 26 : 17;
    const color = p.type === 'building' ? COLORS.origin : COLORS.facility;
    const g = new THREE.Group();
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.9, 0.9, h, 6),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55 }),
    );
    pole.position.y = h / 2;
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(2.6, 10, 8),
      new THREE.MeshBasicMaterial({ color }),
    );
    head.position.y = h;
    g.add(pole, head);
    const w = toWorld(p.xy[0], p.xy[1], 0);
    g.position.copy(w);
    g.userData.name = p.name;
    beaconGroup.add(g);
    beaconById.set(p.id, { group: g, head, pole, base: h });
  }
  scene.add(beaconGroup);

  // ── 路线 ─────────────────────────────────────────────────
  const routeGroup = new THREE.Group();
  scene.add(routeGroup);
  const pulses = [];

  function clearRoute() {
    for (const child of [...routeGroup.children]) {
      routeGroup.remove(child);
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    }
    pulses.length = 0;
  }

  function setRoute(polyline, meta = {}) {
    clearRoute();
    if (!polyline || polyline.length < 2) return;

    const pts = polyline.map((p) => toWorld(p[0], p[1], 7));
    const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.25);

    const tube = new THREE.Mesh(
      new THREE.TubeGeometry(curve, Math.min(220, pts.length * 12), 2.0, 8, false),
      new THREE.MeshBasicMaterial({ color: COLORS.route }),
    );
    routeGroup.add(tube);

    const glow = new THREE.Mesh(
      new THREE.TubeGeometry(curve, Math.min(220, pts.length * 12), 5.2, 8, false),
      new THREE.MeshBasicMaterial({ color: COLORS.route, transparent: true, opacity: 0.16, depthWrite: false }),
    );
    routeGroup.add(glow);

    // 起终点
    const start = new THREE.Mesh(
      new THREE.SphereGeometry(3.4, 14, 10),
      new THREE.MeshBasicMaterial({ color: COLORS.origin }),
    );
    start.position.copy(pts[0]);
    const end = new THREE.Mesh(
      new THREE.SphereGeometry(3.4, 14, 10),
      new THREE.MeshBasicMaterial({ color: COLORS.target }),
    );
    end.position.copy(pts[pts.length - 1]);
    routeGroup.add(start, end);

    // 沿路线流动的光点
    for (let i = 0; i < 3; i += 1) {
      const pulse = new THREE.Mesh(
        new THREE.SphereGeometry(2.0, 10, 8),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 }),
      );
      routeGroup.add(pulse);
      pulses.push({ mesh: pulse, curve, offset: i / 3 });
    }

    // 聚焦到路线。
    // 关键：取景必须收敛到「街区尺度」。一条 1.2km 的路线若按全长取景，
    // 相机会退到 1.2km 外，42m 的建筑只剩 30 像素，体块就糊成线框了。
    // 这里按路线中段取景，并把观察半径钳在 90–320m。
    const box = new THREE.Box3().setFromPoints(pts);
    const center = box.getCenter(new THREE.Vector3());
    const mid = pts[Math.floor(pts.length / 2)];
    const radius = Math.max(
      90,
      Math.min(320, box.getSize(new THREE.Vector3()).length() / 2),
    );
    controls.target.set(mid.x, 6, mid.z);
    const dir = new THREE.Vector3(0.55, 0.62, 0.85).normalize();
    camera.position.copy(
      new THREE.Vector3(mid.x, 6, mid.z).add(dir.multiplyScalar(radius * 1.55)),
    );
    controls.update();
  }

  /** 高亮一组地标（查询命中的起点/终点） */
  function highlight(ids = []) {
    for (const [id, b] of beaconById) {
      const on = ids.includes(id);
      b.head.material.color.setHex(on ? 0xffd166 : b.pole.material.color.getHex());
      b.head.scale.setScalar(on ? 1.7 : 1);
      b.pole.material.opacity = on ? 0.95 : 0.5;
    }
  }

  // ── 灯光 ─────────────────────────────────────────────────
  scene.add(new THREE.HemisphereLight(0x6d92cc, 0x141c30, 2.4));
  scene.add(new THREE.AmbientLight(0xdce8ff, 0.75));
  // 世界原点已平移到校区中心（见 toWorld），灯光位置必须用世界坐标
  const sun = new THREE.DirectionalLight(0xe8f0ff, 2.2);
  sun.position.set(focus.x + focusSpan * 0.55, focusSpan * 1.25, focus.z + focusSpan * 0.5);
  sun.target.position.copy(focus);
  scene.add(sun.target);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 10;
  sun.shadow.camera.far = Math.max(2000, focusSpan * 4.5);
  const sc = sun.shadow.camera;
  sc.left = -focusSpan * 1.6;
  sc.right = focusSpan * 1.6;
  sc.top = focusSpan * 1.6;
  sc.bottom = -focusSpan * 1.6;
  sun.shadow.bias = -0.0009;
  scene.add(sun);

  // ── 初始视角 ─────────────────────────────────────────────
  // 取景不按整个校园（1.9km）来 —— 那太远，体块全糊成小点。
  // 改为按「命名地标密集区」取景，保持人眼可读的空间尺度。
  const initDist = focusSpan * 0.92;
  camera.position.set(focus.x + initDist * 0.48, initDist * 0.72, focus.z + initDist * 0.58);
  controls.target.copy(focus);
  controls.update();

  // ── 渲染循环（不可见时暂停）─────────────────────────────
  let raf = 0;
  let visible = true;
  let t = 0;

  function frame() {
    raf = requestAnimationFrame(frame);
    if (!visible) return;
    t += 0.006;
    for (const p of pulses) {
      const u = (t * 0.16 + p.offset) % 1;
      p.mesh.position.copy(p.curve.getPointAt(u));
      p.mesh.material.opacity = 0.85 * Math.sin(u * Math.PI);
    }
    controls.update();
    renderer.render(scene, camera);
  }

  const io = new IntersectionObserver(
    (entries) => { visible = entries[0]?.isIntersecting ?? true; },
    { threshold: 0.02 },
  );
  io.observe(canvas);

  function resize() {
    const r = canvas.getBoundingClientRect();
    const w = Math.max(1, r.width);
    const h = Math.max(1, r.height);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();
  window.addEventListener('resize', resize);
  frame();

  // 调试句柄（便于在浏览器控制台检查场景状态）
  window.__scene3d = { scene, camera, renderer, buildingGroup, edgeGroup, beaconGroup };

  return {
    setRoute,
    highlight,
    resize,
    resetView() {
      camera.position.set(focus.x + initDist * 0.48, initDist * 0.72, focus.z + initDist * 0.58);
      controls.target.copy(focus);
      controls.update();
    },
    focusSpan,
    dispose() {
      cancelAnimationFrame(raf);
      io.disconnect();
      window.removeEventListener('resize', resize);
      controls.dispose();
      renderer.dispose();
    },
  };
}
