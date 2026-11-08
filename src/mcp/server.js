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

const TOOL_NAME = 'scene_guide';

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

const PROTOCOL_VERSION = '2025-06-18';

export function createMcpHandler({ listScenes, answerGuide, createQuest, measure, billingSummary, services }) {
  function serverInfo() {
    return {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'scene-guide', title: '三维问路 SceneGuide', version: '1.0.0' },
      instructions:
        '本服务按次计费（支付宝 A2M 智能收 / HTTP 402）。首次调用 scene_guide 会返回 ' +
        'payment_required 与一份 Payment-Needed 账单；请把该账单交给支付宝的 ' +
        'alipay-pay-for-402-service 技能引导用户完成付款，再把得到的 Payment-Proof ' +
        '作为 payment_proof 参数重新调用本工具。',
    };
  }

  async function toolsList() {
    return { tools: [SCENES_TOOL, TOOL_DEF] };
  }

  async function toolsCall(params) {
    const name = params?.name;
    const args = params?.arguments ?? {};

    if (name === SCENES_TOOL.name) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ scenes: listScenes() }, null, 2) }],
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

    // 未带凭证 → 返回支付挑战（这就是「发起支付」的前置）
    const isQuest = String(args.mode ?? 'guide') === 'quest';
    const tier = isQuest
      ? services.quest ?? { unitPrice: '9.90', label: '场景任务（研学）' }
      : services.single ?? { unitPrice: '0.50', label: '单次导览' };

    let preview;
    if (isQuest) {
      const q = createQuest({ sceneId, level: String(args.level ?? 'normal') });
      if (!q.ok) return { isError: true, content: [{ type: 'text', text: q.error }] };
      preview = { summary: q.quest.brief, title: q.quest.title };
    } else {
      const result = answerGuide({ sceneId, query, originHint: args.origin });
      if (!result.ok) {
        return { isError: true, content: [{ type: 'text', text: result.error }] };
      }
      preview = { summary: result.answer ?? null };
    }

    const outTradeNo = `SG_MCP_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
    return {
      content: [
        {
          type: 'text',
          text:
            '本工具为付费资源，需要先完成支付。\n' +
            `商品：${tier.label}\n金额：¥${tier.unitPrice}\n` +
            '请将下面的 Payment-Needed 账单交给支付宝 alipay-pay-for-402-service 技能，' +
            '由它引导用户完成付款；随后把得到的 Payment-Proof 作为 payment_proof 参数再次调用本工具。',
        },
      ],
      structuredContent: {
        status: 'payment_required',
        out_trade_no: outTradeNo,
        amount: String(tier.unitPrice),
        currency: 'CNY',
        goods_name: tier.label,
        resource_id: '/api/v1/guide',
        next: {
          skill: 'alipay-pay-for-402-service',
          action: '完成支付后，把 Payment-Proof 原文以 Base64URL 编码作为 payment_proof 传回',
        },
        preview_answer: preview.summary,
        preview_title: preview.title ?? null,
      },
      isError: false,
    };
  }

  /** JSON-RPC 分发 */
  return async function handleMcp(body) {
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
        return reply(await toolsCall(params));
      default:
        return fail(-32601, `未实现的方法：${method}`);
    }
  };
}
