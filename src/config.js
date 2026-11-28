import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');

const SANDBOX_FILE = path.join(ROOT, '.alipay-sandbox.json');
// ⚠️ 路径可用环境变量覆盖（ALIPAY_PRODUCTION_CONFIG / ALIPAY_SERVICES_CONFIG）：
//    生产模式无法在真实生产机上反复试错，而「生产分支的契约」必须能离线验证
//    ——scripts/prod/prod-pay-ux-check.mjs 就是用临时配置起一个本地生产实例跑契约检查。
const PRODUCTION_FILE = process.env.ALIPAY_PRODUCTION_CONFIG
  ? path.resolve(process.env.ALIPAY_PRODUCTION_CONFIG)
  : path.join(ROOT, 'config', 'production.json');
const SERVICES_FILE = process.env.ALIPAY_SERVICES_CONFIG
  ? path.resolve(process.env.ALIPAY_SERVICES_CONFIG)
  : path.join(ROOT, 'config', 'services.json');
// 生产 service_id 覆盖层（gitignore）：档位形状与价格留在被跟踪的 services.json，
// 真实 service_id 只存在于这里，避免污染公开仓库、也避免把沙箱收银弄坏。
//
// ⚠️ 路径必须**在调用时**解析，不能提到模块顶层：
//    ESM 模块只求值一次，顶层常量会在第一次 import 时把路径定死，
//    之后再设 ALIPAY_SERVICES_IDS_CONFIG 也不生效（验收脚本要靠它模拟「覆盖层缺失」）。
//    ——与 src/community.js 里同一个坑的修法一致。
function servicesIdsFile() {
  return process.env.ALIPAY_SERVICES_IDS_CONFIG
    ? path.resolve(process.env.ALIPAY_SERVICES_IDS_CONFIG)
    : path.join(ROOT, 'config', 'services.production.json');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return readJson(file);
  } catch (err) {
    throw new Error(`配置文件解析失败 ${file}: ${err.message}`);
  }
}

/**
 * 官方沙箱脚本 sandbox_config.sh 落盘结构：
 *   {
 *     appIds: [{ appId, alipayPublicKey, appPrivateKey | appPrivatePkcsKey, ... }],
 *     sandboxAccounts: { user: { userId, ... }, partner: { userId, ... } }
 *   }
 *
 * 关键约束（官方 integration/flow.md）：
 *   - Java 使用 appPrivateKey（PKCS#8）；其他语言（含 Node）使用 appPrivatePkcsKey（PKCS#1）
 *   - 服务端运行时直接读取该 JSON，禁止把密钥原文打印/复制进源码
 */
export function loadSandboxConfig() {
  const raw = readJsonIfExists(SANDBOX_FILE);
  if (!raw) return null;

  const entry = raw.appIds?.[0];
  if (!entry?.appId) {
    throw new Error('.alipay-sandbox.json 缺少 appIds[0].appId');
  }

  const privateKeyB64 = entry.appPrivatePkcsKey ?? entry.appPrivateKey;
  if (!privateKeyB64) {
    throw new Error('.alipay-sandbox.json 缺少 appPrivatePkcsKey（Node/Python/Go/PHP 使用 PKCS#1 字段）');
  }

  return {
    env: 'sandbox',
    appId: entry.appId,
    alipayPublicKey: entry.alipayPublicKey,
    privateKeyB64,
    // 沙箱买家 2088 账号，供本地沙箱收银测试使用
    buyerUserId: raw.sandboxAccounts?.user?.userId ?? null,
    gateway: 'https://openapi-sandbox.dl.alipaydev.com/gateway.do',
  };
}

/**
 * 生产配置不入库（config/production.json 已在 .gitignore 中）。
 * 生产 serviceId 来自支付宝服务市场注册结果，绝不能沿用 api_mock_service_id。
 */
export function loadProductionConfig() {
  const raw = readJsonIfExists(PRODUCTION_FILE);
  if (!raw) return null;
  if (raw.serviceId === 'api_mock_service_id') {
    throw new Error('生产配置 serviceId 仍是沙箱占位符 api_mock_service_id，拒绝启动');
  }
  return {
    env: 'production',
    appId: raw.appId,
    alipayPublicKey: raw.alipayPublicKey,
    privateKeyB64: raw.privateKey,
    buyerUserId: null,
    gateway: raw.gateway ?? 'https://openapi.alipay.com/gateway.do',
    // 官方预下单形态（amtPaymentLink）开关。默认关闭：
    // 官方未公开完整响应 JSON，先用 scripts/prod/precreate-check.mjs 实测确认字段名再打开。
    precreate: {
      enabled: raw.precreate?.enabled === true,
    },
  };
}

/**
 * 服务档位表。
 *
 * 🔴 平台硬约束（已由沙箱收银实测证实）：
 *   **服务市场注册的「服务单价」必须与实际扣费金额完全一致**，
 *   不一致时收银接口返回 `SERVICE_PRICE_MISMATCH：服务价格不匹配` 并拒绝下单。
 *
 * 推论：
 *   - 每一档位必须注册成**独立的服务**（各自一个 service_id），各自有自己的注册价；
 *   - 同一档位内金额恒定，不能按距离/token 动态变价（计量只记录、不参与扣费）；
 *   - 沙箱只有固定的 mock 服务（注册价 ¥0.01），因此**沙箱里所有档位都必须按 ¥0.01 收费**，
 *     否则收银会直接拒单。生产环境各档位用服务市场注册返回的真实 service_id 与真实价格。
 */
export function loadServices({ env = 'sandbox' } = {}) {
  const raw = readJsonIfExists(SERVICES_FILE);
  const tiers = raw?.tiers ?? {
    single: { serviceId: 'api_mock_service_id', unitPrice: '0.01', quota: 1, label: '单次导览' },
  };

  // 🔴 生产 service_id 覆盖层（2026-11-24 新增）
  //
  // 为什么不能把真实 service_id 直接写进 config/services.json：
  //   那份文件是**被 git 跟踪**的（公开仓库里要能看到四档位结构与价格），
  //   而且**沙箱与生产读的是同一份**——一旦写进真实 service_id，
  //   沙箱收银就会拿生产服务 id 去下单，直接被拒（沙箱只认 api_mock_service_id），
  //   **本地验收与线上沙箱演示会同时被打挂**。
  //
  // 所以：档位形状与价格留在被跟踪的文件里（公开、可复算），
  // 真实 service_id 放进 .gitignore 的 config/services.production.json 覆盖层，
  // 仅在 production 环境合并进来。
  const overlay = env === 'production' ? readJsonIfExists(servicesIdsFile()) : null;
  const overlayTiers = overlay?.tiers ?? overlay ?? {};

  const out = {};
  for (const [name, tier] of Object.entries(tiers)) {
    const ov = overlayTiers[name] ?? {};
    const merged = {
      ...tier,
      ...(ov.serviceId ? { serviceId: ov.serviceId } : {}),
      ...(ov.unitPrice ? { unitPrice: ov.unitPrice } : {}),
    };
    const productionPrice = String(merged.unitPrice);
    let unitPrice = productionPrice;

    if (env === 'sandbox') {
      // 沙箱 mock 服务的注册价固定 ¥0.01，其他价格一律被收银拒绝
      if (unitPrice !== SANDBOX_UNIT_PRICE) {
        console.warn(
          `[services] 沙箱环境把档位 ${name} 的单价从 ${unitPrice} 调整为 ${SANDBOX_UNIT_PRICE}` +
          '（沙箱 mock 服务注册价固定，生产环境才使用真实价格）',
        );
      }
      unitPrice = SANDBOX_UNIT_PRICE;
    }

    if (!/^\d+(\.\d{1,2})?$/.test(unitPrice)) {
      throw new Error(`档位 ${name} 的 unitPrice 非法：${unitPrice}`);
    }
    if (Number(unitPrice) < 0.01 || Number(unitPrice) > 50) {
      throw new Error(`档位 ${name} 单价必须在 0.01–50 元之间`);
    }

    // 🔴 生产环境必须校验 serviceId 是真家伙（2026-11-21 实测的防护断裂）：
    //    旧实现在 loadProductionConfig 里检查 production.json 顶层的 serviceId
    //    字段——但那是个**死字段**，支付实际用的是 services.json 里
    //    tiers[].serviceId（三个档位都是 api_mock_service_id），生产环境对它零校验。
    //    后果：ALIPAY_ENV=production 能正常启动，然后每一笔支付挑战都带着 mock
    //    serviceId 去收银 → SERVICE_PRICE_MISMATCH 拒单（且沙箱 ¥0.01 归一化
    //    只改价不改 id，mock 注册价恰是 0.01，与生产价必然错配）。
    if (env === 'production' && String(merged.serviceId ?? '').trim() === 'api_mock_service_id') {
      throw new Error(
        `生产环境拒绝启动：档位 ${name} 的 serviceId 仍是沙箱占位符 api_mock_service_id。` +
        '请先在支付宝服务市场注册真实服务，把真实 service_id 写进 config/services.production.json。',
      );
    }
    if (env === 'production' && !String(merged.serviceId ?? '').trim()) {
      throw new Error(`生产环境拒绝启动：档位 ${name} 缺少 serviceId。`);
    }

    out[name] = { ...merged, unitPrice, productionPrice };
  }
  return out;
}

/** 沙箱 mock 服务的注册价（固定） */
export const SANDBOX_UNIT_PRICE = '0.01';

export function resolveConfig() {
  const env = process.env.ALIPAY_ENV ?? 'sandbox';
  if (env === 'production') {
    const prod = loadProductionConfig();
    if (!prod) throw new Error('ALIPAY_ENV=production 但缺少 config/production.json');
    return prod;
  }
  const sandbox = loadSandboxConfig();
  if (!sandbox) {
    throw new Error(
      '未找到 .alipay-sandbox.json。请先运行官方沙箱脚本生成匿名沙箱配置（见 README「沙箱初始化」）。',
    );
  }
  return sandbox;
}

export function resolveSellerId() {
  const fromEnv = process.env.ALIPAY_SELLER_ID;
  if (fromEnv) return fromEnv;

  const prod = readJsonIfExists(PRODUCTION_FILE);
  const sandbox = readJsonIfExists(SANDBOX_FILE);

  // 沙箱配置的 appIds[0].pid 就是 2088 格式的商户号
  const sellerId =
    prod?.sellerId ??
    prod?.seller_id ??
    sandbox?.sellerId ??
    sandbox?.seller_id ??
    sandbox?.appIds?.[0]?.pid;

  if (!sellerId) {
    throw new Error('缺少 sellerId（2088 格式）。请配置环境变量 ALIPAY_SELLER_ID 或写入配置文件。');
  }
  return String(sellerId);
}
