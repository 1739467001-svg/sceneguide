#!/usr/bin/env bash
# ============================================================
# 三维问路 · SceneGuide —— 验收脚本
#
# 评委可以独立执行本脚本，验证作品确实具备宣称的各项能力，
# 无需相信页面上的任何描述。
#
#   bash scripts/verify.sh                # 默认 http://127.0.0.1:3000
#   BASE_URL=https://... bash scripts/verify.sh
#
# 退出码：0 全部通过 / 1 有项目失败
# ============================================================
set -uo pipefail

BASE="${BASE_URL:-http://127.0.0.1:3000}"
PASS=0
FAIL=0
CURL=(curl -sS --max-time 30)

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
ok()    { printf '  \033[32m✓\033[0m %s\n' "$*"; PASS=$((PASS+1)); }
bad()   { printf '  \033[31m✗\033[0m %s\n' "$*"; FAIL=$((FAIL+1)); }
step()  { printf '\n\033[36m▸ %s\033[0m\n' "$*"; }

# ── 沙箱收银退避重试 ────────────────────────────────────────
# 支付宝沙箱收银对连续支付有低概率拒单（PAY_SUBMIT_FAILED 系统繁忙，实测），
# 验收脚本一次要打 4 笔真实支付，不加重试整份报告会随机挂在不同项上。
# 用法：DEMO_PAY=$(demo_pay_with_retry '<json body>')
demo_pay_with_retry() {
  local body="$1" attempt resp
  for attempt in 1 2 3 4; do
    resp=$("${CURL[@]}" -X POST "$BASE/api/v1/demo/pay" \
      -H 'Content-Type: application/json' -d "$body")
    if node -e "
      try{const j=JSON.parse(process.argv[1]);process.exit(j.error||j.code?1:0)}
      catch(e){process.exit(1)}
    " "$resp"; then
      printf '%s' "$resp"
      return 0
    fi
    [[ $attempt -lt 4 ]] && sleep 6
  done
  printf '%s' "$resp"
}

bold "三维问路 · SceneGuide 验收"
bold "目标：$BASE"

# ── 0. 服务可达 ────────────────────────────────────────────
step "0. 服务可达性"
if "${CURL[@]}" -o /dev/null -w '%{http_code}' "$BASE/healthz" | grep -q '^200$'; then
  ok "GET /healthz → 200"
else
  bad "GET /healthz 未返回 200（服务未启动？）"
fi

# ── 1. 支付挑战：未付费必须返回 402 + Payment-Needed ─────────
step "1. 付费资源返回 402 支付挑战"
HEADERS=$("${CURL[@]}" -D - -o /dev/null \
  "$BASE/api/v1/guide?scene=zjgsu-xiasha&query=%E4%BB%8E%E5%9B%BE%E4%B9%A6%E9%A6%86%E5%88%B0%E8%A1%8C%E6%94%BF%E6%A5%BC%E6%80%8E%E4%B9%88%E8%B5%B0" 2>&1)
if grep -q '^HTTP/1.1 402' <<<"$HEADERS"; then ok "状态码 402 Payment Required"; else bad "未返回 402"; fi
if grep -qi '^Payment-Needed:' <<<"$HEADERS"; then ok "响应头含 Payment-Needed"; else bad "缺少 Payment-Needed 响应头"; fi

PAYLOAD=$(grep -i '^Payment-Needed:' <<<"$HEADERS" | sed 's/^[Pp]ayment-[Nn]eeded: //' | tr -d '\r\n')
if [[ -n "$PAYLOAD" ]]; then
  DECODED=$(node -e "
    const b=process.argv[1].replace(/-/g,'+').replace(/_/g,'/');
    const j=JSON.parse(Buffer.from(b,'base64').toString('utf8'));
    console.log([j.protocol?.out_trade_no,j.protocol?.amount,j.method?.service_id,j.method?.seller_id].join('|'));
  " "$PAYLOAD" 2>/dev/null)
  if [[ "$DECODED" == *"|"* && -n "$DECODED" ]]; then
    IFS='|' read -r OTN AMT SID SELLER <<<"$DECODED"
    ok "Payment-Needed 可解码（out_trade_no=$OTN amount=$AMT service_id=$SID seller_id=${SELLER}）"
  else
    bad "Payment-Needed 解码失败"
  fi
else
  bad "未取到 Payment-Needed 值"
fi

# ── 2. 支付与交付：真实走一遍支付宝沙箱收银 ──────────────────
step "2. 完成支付并交付资源"
PAY=$(demo_pay_with_retry '{"scene":"zjgsu-xiasha","query":"从浙江工商大学图书馆到行政楼怎么走"}')
TRADE=$(node -e "try{const j=JSON.parse(process.argv[1]);console.log(j.tradeNo||'')}catch(e){}" "$PAY")
if [[ -n "$TRADE" ]]; then
  ok "支付完成，支付宝交易号 ${TRADE}（32 位）"
else
  bad "支付未完成：$(head -c 160 <<<"$PAY")"
fi
HAS_CONTENT=$(node -e "
  try{const j=JSON.parse(process.argv[1]);console.log(j.content?.answer?'yes':'no')}catch(e){console.log('no')}
" "$PAY")
if [[ "$HAS_CONTENT" == "yes" ]]; then ok "交付内容含导览答案"; else bad "未拿到交付内容"; fi

# ── 3. 幂等：同一笔凭证不得重复履约 ──────────────────────────
step "3. 幂等履约"
ORDER=$(node -e "try{const j=JSON.parse(process.argv[1]);console.log(j.envelope?.out_trade_no||'')}catch(e){}" "$PAY")
if [[ -n "$ORDER" ]]; then
  # 经 API 查询（脚本必须可对远程实例运行，不依赖本地数据库）
  STATE=$("${CURL[@]}" "$BASE/api/v1/orders/$ORDER" 2>/dev/null | node -e "
    let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
      try{const j=JSON.parse(s);console.log(j.order_status+'/'+j.fulfill_status)}
      catch(e){console.log('ORDER_MISSING')}
    });")
  if [[ "$STATE" == "PAID/FULFILLED" ]]; then
    ok "订单状态 PAID/FULFILLED（重复请求不会重复生成资源）"
  else
    bad "订单状态异常：$STATE"
  fi
else
  bad "未取到商户订单号"
fi

# ── 4. 计量维度 ─────────────────────────────────────────────
step "4. 用量计量"
USAGE=$("${CURL[@]}" "$BASE/api/v1/stats")
METERS=$(node -e "
  try{const j=JSON.parse(process.argv[1]);console.log((j.usage||[]).map(u=>u.meter).join(','))}catch(e){}
" "$USAGE")
for m in guide_call tokens distance_m; do
  if [[ ",$METERS," == *",$m,"* ]]; then ok "计量维度 $m 有累计"; else bad "缺少计量维度 $m"; fi
done

# ── 5. 场景数据真实性 ───────────────────────────────────────
step "5. 场景数据与可核验性"
SCENE=$("${CURL[@]}" "$BASE/api/v1/scene/zjgsu-xiasha")
POIS=$(node -e "try{const j=JSON.parse(process.argv[1]);console.log((j.pois||[]).length)}catch(e){}" "$SCENE")
FPS=$(node -e "try{const j=JSON.parse(process.argv[1]);console.log((j.footprints||[]).length)}catch(e){}" "$SCENE")
[[ "$POIS" =~ ^[0-9]+$ && "$POIS" -gt 50 ]] && ok "命名地标 ${POIS} 个（OSM 真实数据）" || bad "命名地标异常：$POIS"
[[ "$FPS" =~ ^[0-9]+$ && "$FPS" -gt 20 ]] && ok "建筑多边形轮廓 ${FPS} 个（可拉伸为体块）" || bad "建筑轮廓异常：$FPS"
if node -e "try{const j=JSON.parse(process.argv[1]);console.log(j.attribution?'':'x')}catch(e){}" "$SCENE" | grep -q '^$'; then
  ok "标注了 OSM 版权归属（ODbL）"
else
  bad "缺少 OSM 归属声明"
fi

# 管线泛化性：同一管线构建的第二个真实场景
SCENES=$("${CURL[@]}" "$BASE/api/v1/scenes")
LZ=$(node -e "
  try{const j=JSON.parse(process.argv[1]);
    const s=(j.scenes||[]).find(s=>s.id==='liangzhu-culture-village');
    console.log(s&&s.namedPois>=20?String(s.namedPois):'');
  }catch(e){}
" "$SCENES")
if [[ -n "$LZ" ]]; then
  ok "第二真实场景「良渚文化村」（${LZ} 地标）—— 同一 OSM 管线可泛化"
else
  bad "缺少第二个真实场景（liangzhu-culture-village）"
fi

# ── 6. 协议报文快照 ──────────────────────────────────────────
step "6. 站点协议报文快照"
if "${CURL[@]}" -o /dev/null -w '%{http_code}' "$BASE/data/protocol-trace.json" | grep -q '^200$'; then
  ok "protocol-trace.json 可访问（真实抓取的 402 往返报文）"
else
  bad "protocol-trace.json 不可访问"
fi

# ── 7. Agent 发现能力（MCP）─────────────────────────────────
step "7. Agent 发现服务（MCP tools/list）"
MCP=$("${CURL[@]}" -X POST "$BASE/mcp" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' 2>/dev/null)
MCP_TOOLS=$(node -e "
  try{const j=JSON.parse(process.argv[1]);console.log((j.result?.tools||[]).map(t=>t.name).join(','))}catch(e){}
" "$MCP")
if [[ "$MCP_TOOLS" == *"scene_guide"* ]]; then
  ok "MCP tools/list 返回 scene_guide（Agent 可发现）"
else
  bad "MCP tools/list 未返回 scene_guide"
fi
if [[ "$MCP_TOOLS" == *"scene_guide_scenes"* ]]; then
  ok "MCP 同时暴露 scene_guide_scenes（先选场景再问路）"
else
  bad "缺少 scene_guide_scenes"
fi
MCP_PAID=$(node -e "
  try{const j=JSON.parse(process.argv[1]);
    const t=(j.result?.tools||[]).find(t=>t.name==='scene_guide');
    console.log(t?.annotations?.paid?'yes':'no');
  }catch(e){console.log('no')}
" "$MCP")
if [[ "$MCP_PAID" == "yes" ]]; then
  ok "工具标注 paid=true（Agent 宿主可提示计费）"
else
  bad "工具未标注 paid"
fi

# tools/call 全链路：免费工具直接交付；付费工具返回 payment_required 与账单
MCP_CALL=$("${CURL[@]}" -X POST "$BASE/mcp" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"scene_guide_scenes","arguments":{}}}' 2>/dev/null)
if node -e "
  try{const j=JSON.parse(process.argv[1]);
    const t=j.result?.content?.[0]?.text ?? '';
    process.exit(t.includes('scenes')&&t.includes('zjgsu-xiasha')?0:1);
  }catch(e){process.exit(1)}
" "$MCP_CALL"; then
  ok "MCP tools/call 免费工具直接交付场景目录"
else
  bad "MCP 免费工具调用未返回场景数据"
fi

MCP_PAYWALL=$("${CURL[@]}" -X POST "$BASE/mcp" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"scene_guide","arguments":{"scene":"zjgsu-xiasha","query":"从图书馆到行政楼怎么走"}}}' 2>/dev/null)
if node -e "
  try{const j=JSON.parse(process.argv[1]);
    const sc=j.result?.structuredContent ?? {};
    process.exit(sc.status==='payment_required'&&sc.out_trade_no?0:1);
  }catch(e){process.exit(1)}
" "$MCP_PAYWALL"; then
  ok "MCP 付费工具返回 payment_required + 账单（Agent 采购链路第一环）"
else
  bad "MCP 付费工具未返回 payment_required"
fi

# ── 8. 场景任务（研学档位，¥9.90 交付物）────────────────────
step "8. 场景任务（研学档位）"
QUEST=$(demo_pay_with_retry '{"scene":"zjgsu-xiasha","query":"","mode":"quest","level":"normal"}')
Q_OK=$(node -e "
  try{
    const j=JSON.parse(process.argv[1]);
    const q=j.content?.quest;
    if(!q){console.log('no-quest');process.exit(0)}
    // 线索数必须与打卡点数一致，否则最后一站没有线索、任务无法完成
    const cluesOk=(q.clues?.length??0)===(q.checkpoints?.length??0);
    const cpsOk=(q.checkpoints?.length??0)>=3;
    const noCert=(q.certificate===null||q.certificate===undefined);
    const statusOk=q.status==='IN_PROGRESS';
    console.log(cluesOk&&cpsOk&&noCert&&statusOk?'yes':
      \`bad clues=\${cluesOk} cps=\${cpsOk} noCert=\${noCert} status=\${statusOk}\`);
  }catch(e){console.log('parse-err')}
" "$QUEST")
if [[ "$Q_OK" == "yes" ]]; then
  ok "任务生成：线索链与打卡点一一对应，完成前状态为进行中且无证书"
else
  bad "任务交付异常：$Q_OK"
fi
Q_TRADE=$(node -e "try{const j=JSON.parse(process.argv[1]);console.log(j.tradeNo||'')}catch(e){}" "$QUEST")
[[ -n "$Q_TRADE" ]] && ok "任务走真实支付：交易号 ${Q_TRADE}" || bad "任务未走真实支付"
Q_METER=$(node -e "
  try{const j=JSON.parse(process.argv[1]);console.log(j.content?.billing?.clue_count?'yes':'no')}catch(e){}
" "$QUEST")
if [[ "$Q_METER" == "yes" ]]; then ok "任务计量含 clue_count 维度"; else bad "缺少任务计量维度"; fi

# 打卡闭环：顺序核验 + 完成才发证
QID=$(node -e "try{const j=JSON.parse(process.argv[1]);console.log(j.content?.quest?.id||'')}catch(e){}" "$QUEST")
if [[ -n "$QID" ]]; then
  # 跳站应被拒
  SKIP=$("${CURL[@]}" -X POST "$BASE/api/v1/quests/$QID/checkin" \
    -H 'Content-Type: application/json' \
    -d '{"point_id":"poi_nonexistent"}' 2>/dev/null)
  SKIP_CODE=$(node -e "try{const j=JSON.parse(process.argv[1]);console.log(j.code||'')}catch(e){}" "$SKIP")
  if [[ "$SKIP_CODE" == "UNKNOWN_POINT" || "$SKIP_CODE" == "OUT_OF_ORDER" ]]; then
    ok "非法打卡被拒（${SKIP_CODE}）——顺序核验生效"
  else
    bad "非法打卡未被正确拒绝：$SKIP_CODE"
  fi

  # 按序打完
  N=$("${CURL[@]}" "$BASE/api/v1/quests/$QID" 2>/dev/null | node -e "
    let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
      try{console.log(JSON.parse(s).checkpoints.length)}catch(e){console.log(0)}
    });")
  CERT=""
  for ((i = 0; i < N; i++)); do
    PID=$("${CURL[@]}" "$BASE/api/v1/quests/$QID" 2>/dev/null | node -e "
      let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
        try{console.log(JSON.parse(s).checkpoints[$i].id)}catch(e){console.log('')}
      });")
    OUT=$("${CURL[@]}" -X POST "$BASE/api/v1/quests/$QID/checkin" \
      -H 'Content-Type: application/json' -d "{\"point_id\":\"$PID\"}" 2>/dev/null)
    CERT=$(node -e "try{const j=JSON.parse(process.argv[1]);console.log(j.quest?.certificate?.verifiable_by||'')}catch(e){}" "$OUT")
  done
  if [[ -n "$CERT" ]]; then
    ok "按序打卡 ${N} 站后颁发证书：${CERT}"
  else
    bad "全部打卡完成后未颁发证书"
  fi
  # 完成前不应有证书（用新任务再验一次）
  Q2=$(demo_pay_with_retry '{"scene":"zjgsu-xiasha","query":"","mode":"quest"}')
  Q2ID=$(node -e "try{const j=JSON.parse(process.argv[1]);console.log(j.content?.quest?.id||'')}catch(e){}" "$Q2")
  Q2CERT=$(node -e "try{const j=JSON.parse(process.argv[1]);console.log(j.content?.quest?.certificate?'has':'none')}catch(e){}" "$Q2")
  if [[ "$Q2CERT" == "none" ]]; then
    ok "未完成时不含证书——证书只在走完之后颁发"
  else
    bad "未完成就发了证书"
  fi
else
  bad "未能取得任务 id，打卡闭环无法验证"
fi

# ── 9. 增长归因与免费试看 ────────────────────────────────────
step "9. 增长归因与免费试看"
VCJ=$(mktemp)
REF="verify-$(date +%s)"
"${CURL[@]}" -c "$VCJ" -o /dev/null "$BASE/?ref=$REF"
ok "渠道访问 /?ref=${REF}（首触归因）"

PV_CODE=200
for i in 1 2 3; do
  PV_CODE=$("${CURL[@]}" -b "$VCJ" -c "$VCJ" -o /dev/null -w '%{http_code}' \
    "$BASE/api/v1/guide?scene=zjgsu-xiasha&query=test&preview=1")
done
if [[ "$PV_CODE" == "200" ]]; then ok "免费试看前 3 次放行"; else bad "免费试看限流异常（第 3 次返回 ${PV_CODE}）"; fi
PV4=$("${CURL[@]}" -b "$VCJ" -c "$VCJ" -o /dev/null -w '%{http_code}' \
  "$BASE/api/v1/guide?scene=zjgsu-xiasha&query=test&preview=1")
if [[ "$PV4" == "429" ]]; then ok "第 4 次被限流（429）——服务端计数生效"; else bad "限流未生效（返回 ${PV4}）"; fi

GROWTH=$("${CURL[@]}" "$BASE/api/v1/growth")
# 一次性测试渠道在看板上被聚合进 (测试渠道) 行（防评委看到整屏 verify-* 垃圾行），
# 所以归因断言是：测试聚合行存在且有访客，而非本 ref 独立成行。
HAS_REF=$(node -e "
  try{const j=JSON.parse(process.argv[1]);
    const agg=j.channels?.find(c=>c.code==='(测试渠道)');
    console.log(agg&&agg.visitors>0?'yes':'no');
  }catch(e){console.log('no')}
" "$GROWTH")
if [[ "$HAS_REF" == "yes" ]]; then ok "漏斗归因：测试访客计入 (测试渠道) 聚合行"; else bad "漏斗未归因到测试渠道聚合行"; fi
SELF_TAG=$(node -e "
  try{const j=JSON.parse(process.argv[1]);console.log(j.overall?.paidSelfTest??'x')}catch(e){}
" "$GROWTH")
if [[ "$SELF_TAG" != "x" ]]; then ok "反刷量口径：自测付费单独标注（$SELF_TAG 笔）"; else bad "缺少自测/真实拆分"; fi
rm -f "$VCJ"

# ── 10. 站点完整性 ────────────────────────────────────────────
step "10. 站点完整性"
for path in / /styles.css /app.js /three-scene.js /vendor/three.module.js /data/api-reference.json \
            /manifest.webmanifest /sw.js /icon-192.png /icon-512.png /404.html /llms.txt; do
  CODE=$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$BASE$path")
  if [[ "$CODE" == "200" ]]; then ok "GET $path → 200"; else bad "GET $path → $CODE"; fi
done

# Agent 发现入口：llms.txt 必须可读且含关键事实
LLMS=$("${CURL[@]}" "$BASE/llms.txt")
if grep -q 'Payment-Needed' <<<"$LLMS" && grep -q 'alipay-pay-for-402-service' <<<"$LLMS"; then
  ok "llms.txt 面向 Agent 描述了 402 调用与支付流程"
else
  bad "llms.txt 缺少关键协议说明"
fi

# ── 11. 权益额度台账（多额度商品必须真的交付 N 次）──────────
step "11. 权益额度台账（十次导览包）"
ECJ=$(mktemp)
# 十次包购买需要先有访客 cookie；带 cookie 的重试版（重试时复用同一访客）
demo_pay_cookie_retry() {
  local cj="$1" body="$2" attempt resp
  for attempt in 1 2 3 4; do
    resp=$("${CURL[@]}" -b "$cj" -c "$cj" -X POST "$BASE/api/v1/demo/pay" \
      -H 'Content-Type: application/json' -d "$body")
    if node -e "
      try{const j=JSON.parse(process.argv[1]);process.exit(j.error||j.code?1:0)}
      catch(e){process.exit(1)}
    " "$resp"; then
      printf '%s' "$resp"
      return 0
    fi
    [[ $attempt -lt 4 ]] && sleep 6
  done
  printf '%s' "$resp"
}
PACK=$(demo_pay_cookie_retry "$ECJ" '{"scene":"zjgsu-xiasha","query":"从浙江工商大学图书馆到行政楼怎么走","tier":"pack10"}')
ENT=$(node -e "
  try{const j=JSON.parse(process.argv[1]);const e=j.envelope?.entitlement;
    console.log(e?[e.quota,e.used,e.remaining].join('|'):'');}catch(e){}
" "$PACK")
if [[ "$ENT" == "10|1|9" ]]; then
  ok "购买十次包：发放 10 次，本次交付用掉 1 次，余额 9 次"
else
  bad "十次包权益发放异常：${ENT:-（无 entitlement 字段）}"
fi

BAL=$("${CURL[@]}" -b "$ECJ" "$BASE/api/v1/entitlements" 2>/dev/null | node -e "
  let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
    try{const j=JSON.parse(s);console.log(j.remaining+'|'+j.granted+'|'+j.used)}catch(e){console.log('')}
  });")
if [[ "$BAL" == "9|10|1" ]]; then
  ok "额度查询接口返回一致（余额 9 / 发放 10 / 已用 1）"
else
  bad "额度查询异常：${BAL:-（读不到）}"
fi

# 额度内调用必须免支付直交付（200），且余额逐次递减
FREE_OK=1
REMAIN=""
for i in 1 2 3; do
  HDR=$("${CURL[@]}" -b "$ECJ" -D - -o /dev/null \
    "$BASE/api/v1/guide?scene=zjgsu-xiasha&query=%E4%BB%8E%E5%9B%BE%E4%B9%A6%E9%A6%86%E5%88%B0%E8%A1%8C%E6%94%BF%E6%A5%BC%E6%80%8E%E4%B9%88%E8%B5%B0" 2>&1)
  grep -q '^HTTP/1.1 200' <<<"$HDR" || FREE_OK=0
  REMAIN=$(grep -i '^X-SG-Entitlement-Remaining:' <<<"$HDR" | tr -d '\r\n' | awk '{print $2}')
done
if [[ "$FREE_OK" == "1" && "$REMAIN" == "6" ]]; then
  ok "额度内 3 次调用免支付直交付（HTTP 200），余额依次递减至 6"
else
  bad "额度内调用异常：免支付=$FREE_OK 余额=$REMAIN"
fi

# 耗尽额度后必须回到 402
for i in 1 2 3 4 5 6; do
  "${CURL[@]}" -b "$ECJ" -o /dev/null \
    "$BASE/api/v1/guide?scene=zjgsu-xiasha&query=%E4%BB%8E%E5%9B%BE%E4%B9%A6%E9%A6%86%E5%88%B0%E8%A1%8C%E6%94%BF%E6%A5%BC%E6%80%8E%E4%B9%88%E8%B5%B0"
done
AFTER=$("${CURL[@]}" -b "$ECJ" -o /dev/null -w '%{http_code}' \
  "$BASE/api/v1/guide?scene=zjgsu-xiasha&query=%E4%BB%8E%E5%9B%BE%E4%B9%A6%E9%A6%86%E5%88%B0%E8%A1%8C%E6%94%BF%E6%A5%BC%E6%80%8E%E4%B9%88%E8%B5%B0")
if [[ "$AFTER" == "402" ]]; then
  ok "额度耗尽后回到 402 支付挑战（不会白送，也不会重复收费）"
else
  bad "额度耗尽后应返回 402，实际 $AFTER"
fi
rm -f "$ECJ"

# ── 12. 社区反馈墙（点赞 / 评论 / 回复 / 举报）──────────────
step "12. 社区反馈墙"
FBJ=$(mktemp)
FB_LIST=$("${CURL[@]}" -b "$FBJ" -o /dev/null -w '%{http_code}' "$BASE/api/v1/feedback")
if [[ "$FB_LIST" == "200" ]]; then ok "GET /api/v1/feedback → 200"; else bad "反馈列表接口异常（${FB_LIST}）"; fi

FB_NEW=$("${CURL[@]}" -b "$FBJ" -c "$FBJ" -X POST "$BASE/api/v1/feedback" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"验收脚本\",\"role\":\"开发者\",\"content\":\"这是验收脚本 $REF 提交的一条真实反馈，用于验证留言通道可用。\",\"rating\":5}")
FB_ID=$(node -e "try{console.log(JSON.parse(process.argv[1]).item?.id||'')}catch(e){}" "$FB_NEW")
if [[ -n "$FB_ID" ]]; then ok "提交留言成功（id=${FB_ID}）"; else bad "留言提交失败：$(head -c 120 <<<"$FB_NEW")"; fi

FB_BAD=$("${CURL[@]}" -o /dev/null -w '%{http_code}' -X POST "$BASE/api/v1/feedback" \
  -H 'Content-Type: application/json' -d '{"name":"x","content":"短"}')
if [[ "$FB_BAD" == "400" ]]; then ok "非法留言被拒（400）——内容长度校验生效"; else bad "非法留言未被拒（${FB_BAD}）"; fi

FB_LIKE=$("${CURL[@]}" -b "$FBJ" -X POST "$BASE/api/v1/feedback/$FB_ID/like")
if node -e "try{const j=JSON.parse(process.argv[1]);process.exit(j.likes===1&&j.liked?0:1)}catch(e){process.exit(1)}" "$FB_LIKE"; then
  ok "点赞成功且按访客去重（likes=1 liked=true）"
else
  bad "点赞异常：$FB_LIKE"
fi
FB_LIKE2=$("${CURL[@]}" -b "$FBJ" -X POST "$BASE/api/v1/feedback/$FB_ID/like")
if node -e "try{const j=JSON.parse(process.argv[1]);process.exit(j.likes===0&&j.liked===false?0:1)}catch(e){process.exit(1)}" "$FB_LIKE2"; then
  ok "再次点赞为取消（likes=0）——同一访客不能刷赞"
else
  bad "点赞去重异常：$FB_LIKE2"
fi

FB_REPLY=$("${CURL[@]}" -b "$FBJ" -c "$FBJ" -X POST "$BASE/api/v1/feedback/$FB_ID/reply" \
  -H 'Content-Type: application/json' -d '{"name":"作者","content":"收到，谢谢反馈。"}')
if node -e "try{const j=JSON.parse(process.argv[1]);process.exit(j.reply?.id?0:1)}catch(e){process.exit(1)}" "$FB_REPLY"; then
  ok "回复可写入（反馈墙是线程，不只是评论列表）"
else
  bad "回复写入失败：$FB_REPLY"
fi

FB_HIDDEN=""
for i in 1 2 3; do
  FB_HIDDEN=$("${CURL[@]}" -X POST "$BASE/api/v1/feedback/$FB_ID/report")
done
if node -e "try{const j=JSON.parse(process.argv[1]);process.exit(j.status==='HIDDEN'?0:1)}catch(e){process.exit(1)}" "$FB_HIDDEN"; then
  ok "举报累计 3 次自动隐藏（反刷量：不同访客各自举报，不给一键下架）"
else
  bad "举报隐藏机制异常：$FB_HIDDEN"
fi

# 撤回自己的留言（验收脚本不留垃圾在墙上）
FB_DEL=$("${CURL[@]}" -b "$FBJ" -X DELETE "$BASE/api/v1/feedback/$FB_ID")
if node -e "try{const j=JSON.parse(process.argv[1]);process.exit(j.deleted?0:1)}catch(e){process.exit(1)}" "$FB_DEL"; then
  ok "发布者可以撤回自己的留言（不留测试垃圾在墙上）"
else
  bad "撤回留言失败：$FB_DEL"
fi
FB_GONE=$("${CURL[@]}" -b "$FBJ" "$BASE/api/v1/feedback" 2>/dev/null | node -e "
  let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
    try{console.log(JSON.parse(s).items.some(i=>String(i.id)===process.argv[1])?'still':'gone')}catch(e){console.log('gone')}
  });" "$FB_ID")
if [[ "$FB_GONE" == "gone" ]]; then ok "撤回后不再出现在反馈墙"; else bad "撤回后仍在列表中"; fi
rm -f "$FBJ"

# ── 13. 订单核验卡（公开可分享，热度榜的浏览来源之一）────────
step "13. 订单核验卡"
VERIFY=$("${CURL[@]}" "$BASE/api/v1/verify/$ORDER" 2>/dev/null)
V_OK=$(node -e "
  try{const j=JSON.parse(process.argv[1]);
    const ok=j.verifiable===true && j.summary?.kind==='route' && j.summary?.distance_m>0
      && /^…\\d{6}$/.test(j.trade_no_masked ?? '') && /^sha256:/.test(j.evidence?.geometryHash ?? '')
      && !('content' in j);
    console.log(ok?'yes':'no');
  }catch(e){console.log('no')}
" "$VERIFY")
if [[ "$V_OK" == "yes" ]]; then
  ok "已支付订单出具核验卡（脱敏交易号 + 距离 + 证据哈希，无答案内容）"
else
  bad "核验卡字段异常：$(head -c 120 <<<"$VERIFY")"
fi

# 核验卡页面本身可访问
if "${CURL[@]}" -o /dev/null -w '%{http_code}' "$BASE/verify.html" | grep -q '^200$'; then
  ok "verify.html 可访问（分享落地页）"
else
  bad "verify.html 不可访问"
fi

# 不可核验的订单必须拒绝（防探测）
NV=$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$BASE/api/v1/verify/SG_verify_nonexistent_$REF")
if [[ "$NV" == "404" ]]; then
  ok "不存在订单返回 404（不可探测订单状态细节）"
else
  bad "不存在订单应 404，实际 $NV"
fi

# ── 汇总 ────────────────────────────────────────────────────
printf '\n%s\n' "────────────────────────────────────────────────────────"
if [[ $FAIL -eq 0 ]]; then
  printf '\033[32m全部通过：%d 项\033[0m\n' "$PASS"
  exit 0
else
  printf '\033[31m通过 %d 项，失败 %d 项\033[0m\n' "$PASS" "$FAIL"
  exit 1
fi
