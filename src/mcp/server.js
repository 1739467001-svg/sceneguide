/**
 * MCP（Model Context Protocol）服务端 —— 让 Agent 能「发现」这个服务。
 *
 * 为什么要做这个：
 *   Agent Pay 赛道的官方描述第一句就是「探索 Agent **发现服务**、发起支付与获得交付」。
 *   前面只做到了「发起支付」和「获得交付」，「发现」这一环是空的。
 *   而 Agent 发现一个服务的方式 today 就是 MCP 的 tools/list —— 
 *   所以这个端点不是锦上添花，它是把赛道描述补完整。
 *
 * 实现 JSON-RPC 2.0 over HTTP（Streamable HTTP 传输的请求/响应形态）：
 *   POST /mcp
 *     {"jsonrpc":"2.0","id":1,"method":"tools/list"}
 *     {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"scene_guide","arguments":{...}}}
 */

export const TOOL_NAME = 'scene_guide';

const TOOL_DEF = {
  name: TOOL_NAME,
  title: '三维问路 · 场景导览',
  description:
    '基于真实 OpenStreetMap 地理拓扑的三维场景导览。给定一个场景与自然语言问题，' +
    '返回经过拓扑计算验证的路线、途经点位、距离与步行时间，并附带可复算的几何证据哈希。' +
    '本工具为付费资源：首次调用会返回支付挑战（payment_required），需完成支付宝 A2M 智能收' +
    '（HTTP 402）支付后携带 payment_proof 再次调用即可获得结果。',
  inputSchema: {
    type: 'object',
    properties: {
      scene: {
        type: 'string',
        description: '场景 ID。先调用 scene_guide_scenes 或读取服务目录获取。',
        default: 'zjgsu-xiasha',
      },
      query: {
        type: 'string',
        description: '自然语言导览问题，例如「从图书馆到行政楼怎么走」。',
      },
      origin: {
        type: 'string',
        description: '起点名称（可选）。用于「去某地」这类只给了终点的问题。',
      },
      payment_proof: {
        type: 'string',
        description:
          '支付凭证（可选）。首次调用返回 payment_required 时，' +
          '用支付宝 alipay-bot 完成支付后，把得到的 Payment-Proof 原文传进来即可获取结果。',
      },
      mode: {
        type: 'string',
        description:
          "交付模式（可选）。'guide'（默认）返回导览答案；" +
          "'quest' 生成一次场景任务——线索链 + 打卡点 + 评分规则 + 可核验完成凭证，" +
          '适合研学/教育场景，属更高客单价的交付物。',
        enum: ['guide', 'quest'],
      },
      level: {
        type: 'string',
        description: "任务难度（仅 mode='quest' 时生效）：easy | normal | hard。",
        enum: ['easy', 'normal', 'hard'],
      },
    },
    required: [],
  },
  annotations: {
    title: '三维问路 · 场景导览',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    // 该工具会触发计费，声明出来让 Agent 宿主能提示用户
    paid: true,
  },
};

const SCENES_TOOL = {
  name: 'scene_guide_scenes',
  title: '场景目录',
  description:
    '列出本服务可导览的全部场景（校园、园区、景区等），含每个场景的地标数量与路网规模。' +
    'Agent 应先调用本工具确定 scene 参数，再调用 scene_guide。',
  inputSchema: { type: 'object', properties: {} },
  annotations: { readOnlyHint: true, idempotentHint: true, paid: false },
};

const SETTLEMENT_TOOL = {
  name: 'scene_guide_settlement',
  title: '用量结算单',
  description:
    '查询一笔已支付订单的用量结算单（Machine Pay「以可核验用量完成结算」）。' +
    '返回商家 RSA2 签名的规范用量语句 + 商家公钥 + openssl 离线核验步骤：' +
    '买方 Agent 可凭此**不信任商家、只验签**地核对本单实际用量，' +
    '对 statement 原文任何字段的篡改验签必红。免费、只读。',
  inputSchema: {
    type: 'object',
    properties: {
      out_trade_no: {
        type: 'string',
        description: '商户订单号（购买交付时 structuredContent.out_trade_no 原样返回的那个）。',
      },
    },
    required: ['out_trade_no'],
  },
  annotations: { readOnlyHint: true, idempotentHint: true, paid: false },
};

const PROTOCOL_VERSION = '2025-06-18';

export function createMcpHandler({ listScenes, answerGuide, createQuest, measure, billingSummary, services }) {
  function serverInfo() {
    return {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'scene-guide', title: '三维问路 SceneGuide', version: '1.0.0' },
      instructions:
        '本服务按次计费（支付宝 A2M 智能收 / HTTP 402）。首次调用 scene_guide 会返回 ' +
        'payment_required 与一份 Payment-Needed 账单头（payment_needed_header，Base64URL 原文）；' +
        '请把该账单头**原样**交给支付宝的 alipay-pay-for-402-service 技能引导用户完成付款，' +
        '再把得到的 Payment-Proof 作为 payment_proof 参数重新调用本工具。' +
        '交付完成后可调用免费的 scene_guide_settlement（参数 out_trade_no）取回本单的 ' +
        'RSA2 签名用量结算单，离线验签核对本单实际用量。',
    };
  }

  async function toolsList() {
    return { tools: [SCENES_TOOL, TOOL_DEF, SETTLEMENT_TOOL] };
  }

  async function toolsCall(params, ctx = {}) {
    const name = params?.name;
    const args = params?.arguments ?? {};

    if (name === SCENES_TOOL.name) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ scenes: listScenes() }, null, 2) }],
      };
    }

    // 用量结算单核对：免费只读，买方 Agent 用来「不信任商家、只验签」地核对本单用量。
    // 与付费资源工具不同，这里不需要支付凭证——结算单本来就是给第三方看的。
    if (name === SETTLEMENT_TOOL.name) {
      const outTradeNo = String(args.out_trade_no ?? '').trim();
      if (!outTradeNo) {
        return { isError: true, content: [{ type: 'text', text: '参数 out_trade_no 不能为空' }] };
      }
      const selfBase =
        process.env.SELF_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`;
      let settleRes;
      try {
        settleRes = await fetch(
          `${selfBase}/api/v1/settlement/${encodeURIComponent(outTradeNo)}`,
          { signal: AbortSignal.timeout(15000) },
        );
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `无法连接结算单端点：${err.message}` }],
        };
      }
      const body = await settleRes.json().catch(() => ({}));
      if (!settleRes.ok) {
        return {
          isError: true,
          content: [{
            type: 'text',
            text: `结算单不可用（HTTP ${settleRes.status}）：${body.message ?? body.code ?? ''}`
              + '——只有已支付订单出具结算单；若你刚完成支付，等交付完成后再查。',
          }],
        };
      }
      return {
        content: [
          {
            type: 'text',
            text:
              `订单 ${outTradeNo} 的用量结算单（${body.sign_type} 签名）。\n`
              + '核验方法：保存 seller_public_key 为 PEM，signature 用 base64 -d 还原为二进制，'
              + "然后 printf '%s' '<statement>' | openssl dgst -sha256 -verify seller.pub -signature sig.bin\n"
              + '对 statement 原文任何字段的篡改，验签必然失败——用量数字因此可信。',
          },
          { type: 'text', text: JSON.stringify(body, null, 2) },
        ],
        structuredContent: {
          out_trade_no: body.out_trade_no,
          settlement: body.settlement,
          statement: body.statement,
          signature: body.signature,
          sign_type: body.sign_type,
          seller_public_key: body.seller_public_key,
          how_to_verify: body.how_to_verify,
        },
      };
    }

    if (name !== TOOL_NAME) {
      return {
        isError: true,
        content: [{ type: 'text', text: `未知工具：${name}` }],
      };
    }

    const sceneId = String(args.scene ?? 'zjgsu-xiasha');
    const query = String(args.query ?? '');
    // 任务模式不需要 query（自动挑打卡点）；导览模式必须有问题
    if (String(args.mode ?? 'guide') !== 'quest' && !query.trim()) {
      return { isError: true, content: [{ type: 'text', text: '参数 query 不能为空' }] };
    }

    // 已带凭证 → 走验付交付
    if (args.payment_proof) {
      const proof = String(args.payment_proof);
      // 凭证以 Base64URL(Payment-Proof JSON) 形式传入
      let payload;
      try {
        payload = JSON.parse(Buffer.from(proof, 'base64url').toString('utf8'));
      } catch {
        return {
          isError: true,
          content: [{ type: 'text', text: 'payment_proof 格式无法解析（应为 Base64URL 编码的 JSON）' }],
        };
      }
      const proofHeader = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
      const mode = String(args.mode ?? 'guide');
      const level = String(args.level ?? 'normal');
      const res = await fetch(
        `${process.env.SELF_BASE_URL ?? 'http://127.0.0.1:' + (process.env.PORT ?? 3000)}` +
          `/api/v1/guide?scene=${encodeURIComponent(sceneId)}&query=${encodeURIComponent(query)}` +
          `&mode=${encodeURIComponent(mode)}&level=${encodeURIComponent(level)}`,
        { headers: { 'Payment-Proof': proofHeader } },
      );
      const body = await res.json().catch(() => ({}));
      if (res.status !== 200) {
        return {
          isError: true,
          content: [{ type: 'text', text: `验付未通过（HTTP ${res.status}）：${JSON.stringify(body)}` }],
        };
      }
      const content = body.content ?? body;
      const usage = measure(content);
      return {
        content: [
          { type: 'text', text: content.answer ?? JSON.stringify(content) },
          { type: 'text', text: JSON.stringify(content, null, 2) },
        ],
        structuredContent: { ...content, billing: billingSummary(usage) },
      };
    }

    // 未带凭证 → 发起一次**真实的** 402 支付挑战（内部回环付费资源路由）
    //
    // 🔴 为什么必须回环而不是自己拼账单：早期版本只在文本里让 Agent「去支付」，
    //    既没有可支付的 Payment-Needed 账单头，订单也没落库。买方技能
    //    （alipay-pay-for-402-service）拿不到账单头就无法引导用户付款；
    //    即便用户以别的方式付了，回头带的 Payment-Proof 也查不到本地订单
    //    （ORDER_NOT_FOUND）——整条 Agent 链路是断的（实测复现）。
    //    回环真实路由后：订单落库、签名账单头、验付履约全部与 HTTP 路径一致。
    const isQuest = String(args.mode ?? 'guide') === 'quest';
    const tierName = isQuest ? 'quest' : 'single';
    const tier = services[tierName] ?? services.single ?? { unitPrice: '0.50', label: '单次导览' };
    const mode = String(args.mode ?? 'guide');
    const level = String(args.level ?? 'normal');

    // 免费预告：先本地算一次答案摘要（同时把明显无解的问题在收费前挡掉）
    let preview;
    if (isQuest) {
      const q = createQuest({ sceneId, level });
      if (!q.ok) return { isError: true, content: [{ type: 'text', text: q.error }] };
      preview = { summary: q.quest.brief, title: q.quest.title };
    } else {
      const result = answerGuide({ sceneId, query, originHint: args.origin });
      if (!result.ok) {
        return { isError: true, content: [{ type: 'text', text: result.error }] };
      }
      preview = { summary: result.answer ?? null };
    }

    const selfBase =
      process.env.SELF_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`;
    const resourceUrl =
      `${selfBase}/api/v1/guide?scene=${encodeURIComponent(sceneId)}` +
      `&query=${encodeURIComponent(query)}&mode=${encodeURIComponent(mode)}` +
      `&level=${encodeURIComponent(level)}` +
      (isQuest ? '' : `&tier=${encodeURIComponent(tierName)}`);

    let internalRes;
    try {
      internalRes = await fetch(resourceUrl, {
        // 回环必须带上访客身份：否则订单归因与权益额度会落到「另一个人」身上
        headers: ctx.visitorId ? { Cookie: `sg_vid=${ctx.visitorId}` } : {},
        signal: AbortSignal.timeout(20000),
      });
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: `无法连接付费资源端点：${err.message}` }],
      };
    }

    // 已购额度 → 直接交付（不重复收费：买包用户的后续调用走余额扣减）
    if (internalRes.status === 200) {
      const body = await internalRes.json().catch(() => ({}));
      const content = body.content ?? body;
      const usage = measure(content);
      return {
        content: [
          { type: 'text', text: content.answer ?? JSON.stringify(content) },
          { type: 'text', text: JSON.stringify(content, null, 2) },
        ],
        structuredContent: { ...content, billing: billingSummary(usage) },
      };
    }

    if (internalRes.status !== 402) {
      const body = await internalRes.json().catch(() => ({}));
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `服务端未返回支付挑战（HTTP ${internalRes.status}）：${JSON.stringify(body)}`,
          },
        ],
      };
    }

    const paymentNeededHeader = internalRes.headers.get('payment-needed');
    const challenge = await internalRes.json().catch(() => ({}));
    if (!paymentNeededHeader) {
      return {
        isError: true,
        content: [{ type: 'text', text: '402 响应缺少 Payment-Needed 头' }],
      };
    }

    // 解码一份可读账单供 Agent 与人直接查看；原文仍以 Base64URL 透传，不得改动
    let decoded = null;
    try {
      decoded = JSON.parse(Buffer.from(paymentNeededHeader, 'base64url').toString('utf8'));
    } catch {
      /* 解码失败不影响主流程：原文仍然有效 */
    }

    return {
      content: [
        {
          type: 'text',
          text:
            '本工具为付费资源，需要先完成支付。\n' +
            `商品：${challenge.goods_name ?? tier.label}\n` +
            `金额：¥${challenge.amount ?? tier.unitPrice}\n` +
            `商户订单号：${challenge.out_trade_no ?? '—'}\n` +
            '请把下面 structuredContent.payment_needed_header（Base64URL 原文）**原样**交给\n' +
            '支付宝 alipay-pay-for-402-service 技能，由它引导用户完成付款；\n' +
            '随后把得到的 Payment-Proof 以 Base64URL 编码作为 payment_proof 参数再次调用本工具。',
        },
      ],
      structuredContent: {
        status: 'payment_required',
        out_trade_no: challenge.out_trade_no,
        amount: challenge.amount ?? String(tier.unitPrice),
        currency: challenge.currency ?? 'CNY',
        goods_name: challenge.goods_name ?? tier.label,
        resource_id: '/api/v1/guide',
        // Base64URL 原文：买方技能只认这个，不得解码、不得改动
        payment_needed_header: paymentNeededHeader,
        // 解码后的可读账单（仅供展示，不参与任何签名或透传）
        payment_needed: decoded,
        next: {
          skill: 'alipay-pay-for-402-service',
          action:
            '把 payment_needed_header 原样交给买方技能引导用户付款；完成后把得到的 ' +
            'Payment-Proof 以 Base64URL 编码作为 payment_proof 参数再次调用本工具',
        },
        preview_answer: preview.summary,
        preview_title: preview.title ?? null,
      },
      isError: false,
    };
  }

  /** JSON-RPC 分发 */
  return async function handleMcp(body, ctx = {}) {
    const { id = null, method, params = {} } = body ?? {};

    const reply = (result) => ({ jsonrpc: '2.0', id, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

    switch (method) {
      case 'initialize':
        return reply(serverInfo());
      case 'notifications/initialized':
        return null; // 通知无需响应
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply(await toolsList());
      case 'tools/call':
        return reply(await toolsCall(params, ctx));
      default:
        return fail(-32601, `未实现的方法：${method}`);
    }
  };
}
