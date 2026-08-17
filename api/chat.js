const requestWindow = new Map();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS = 25;

function allowedOrigin(req) {
  const origin = String(req.headers.origin || "");
  const ownOrigin = req.headers.host ? `https://${req.headers.host}` : "";
  const configuredOrigin = String(process.env.ALLOWED_ORIGIN || "");
  return !origin || origin === ownOrigin || origin === configuredOrigin;
}

function applyCors(req, res) {
  const origin = String(req.headers.origin || "");
  if (origin && allowedOrigin(req)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function rateAllowed(req) {
  const key = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "anonymous").split(",")[0].trim();
  const now = Date.now();
  const entry = requestWindow.get(key) || { startedAt: now, count: 0 };
  if (now - entry.startedAt >= WINDOW_MS) {
    entry.startedAt = now;
    entry.count = 0;
  }
  entry.count += 1;
  requestWindow.set(key, entry);
  return entry.count <= MAX_REQUESTS;
}

function urgentGuardrail(message) {
  const text = String(message || "").toLowerCase().replace(/\s+/g, "");
  if (/胸痛|胸口(?:疼|痛|发闷|闷)|心口(?:疼|痛)|胸闷|喘不上气|喘不过气|呼吸(?:困难|不畅|急促)|窒息|嘴唇发紫/.test(text)) {
    return { summary: "胸口疼或喘不上气属于急症信号，请立即拨打120。", immediate_actions: ["立即停止活动，坐下或半卧，不要独自走动", "让身边人通知机构并保持门口通畅", "马上拨打120，说明胸痛和呼吸困难"], place_route: "留在当前位置等待120；不要自行驾车去医院。", price: "120接警免费；救护车和就医费用按当地标准结算。", phone: "120", risk_level: "high", escalate: true, rationale: ["描述出现胸痛或呼吸困难", "需要专业医疗人员现场判断"], rule_id: "medical_cardiorespiratory", rule_label: "胸痛与呼吸急症", urgent: true };
  }
  if (/昏迷|意识不清|叫不醒|抽搐|口角歪|嘴歪|说话含糊|一侧(?:无力|麻木)|浑身动不了|全身动不了/.test(text) || (/头(?:很|特别|非常|突然)?晕|头昏|眩晕/.test(text) && /站不稳|站不起来|走不了|不能走|动不了|看不清|视物模糊|眼前发黑/.test(text))) {
    return { summary: "头晕且无法站立或视物不清属于高危信号，请立即拨打120。", immediate_actions: ["立即坐下或侧卧，不要再站立和走动", "记住症状开始时间，让身边人陪同", "马上拨打120，说明头晕、活动和视力变化"], place_route: "留在当前位置等待120；不要自行乘车或独自外出。", price: "120接警免费；救护车和就医费用按当地标准结算。", phone: "120", risk_level: "high", escalate: true, rationale: ["描述出现明显头晕或意识异常", "同时出现无法站立、活动或视物不清"], rule_id: "medical_neurological", rule_label: "神经系统急症", urgent: true };
  }
  if (/骨折|腿断|胳膊断|手臂断|脚断|骨头断|无法负重|不能负重|大量出血|出血不止|流血不止|严重摔伤|摔倒后(?:站不起来|剧烈疼|疼得厉害)|跌倒后(?:动不了|剧烈疼)|头部受伤|撞到头|开放性伤口/.test(text)) {
    return { summary: "疑似骨折或持续出血，请停止移动伤处并立即拨打120。", immediate_actions: ["不要自行复位或继续走动，保持伤处稳定", "用干净纱布轻压出血处，不触碰外露骨端", "立即拨打120，并通知机构责任人"], place_route: "留在安全位置等待急救人员；不要自行搬动伤者。", price: "120接警免费；救护车和就医费用按当地标准结算。", phone: "120", risk_level: "high", escalate: true, rationale: ["描述出现疑似骨折、严重外伤或持续出血", "不当移动可能加重损伤"], rule_id: "medical_trauma", rule_label: "外伤急症", urgent: true };
  }
  if (/不想活|活不下去|想死|自杀|轻生|伤害自己/.test(text)) {
    return { summary: "您现在的安全最重要，请立即联系身边人并拨打110。", immediate_actions: ["不要独处，马上叫工作人员或家属来到身边", "远离药物、刀具、阳台等危险位置", "立即拨打110；已经受伤同时拨打120"], place_route: "留在有人陪同的安全区域，不要独自离开。", price: "报警和紧急求助免费。", phone: "110", risk_level: "high", escalate: true, rationale: ["描述出现自伤或轻生表达", "需要立即由真人介入保护"], rule_id: "personal_self_harm", rule_label: "人身安全急症", urgent: true };
  }
  return null;
}

function normalizeResult(content) {
  let parsed;
  try { parsed = JSON.parse(String(content || "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); } catch { parsed = { summary: String(content || "") }; }
  if (!parsed || typeof parsed !== "object") parsed = { summary: String(parsed) };
  const risk = ["low", "medium", "high"].includes(String(parsed.risk_level).toLowerCase()) ? String(parsed.risk_level).toLowerCase() : "medium";
  return {
    summary: String(parsed.summary || "已完成本次情况分析。").slice(0, 180),
    immediate_actions: Array.isArray(parsed.immediate_actions) ? parsed.immediate_actions.slice(0, 3).map((item) => String(item).slice(0, 80)) : ["保持冷静，先确认本人当前是否安全。", "需要帮助时联系机构工作人员。"],
    place_route: String(parsed.place_route || "留在当前位置，等待工作人员联系。").slice(0, 140),
    price: String(parsed.price || "以现场公示或主管部门答复为准。").slice(0, 100),
    phone: String(parsed.phone || "12345").slice(0, 30),
    risk_level: risk,
    escalate: Boolean(parsed.escalate || risk === "high"),
    rationale: Array.isArray(parsed.rationale) ? parsed.rationale.slice(0, 3).map((item) => String(item).slice(0, 100)) : []
  };
}

function applyLocation(result, context) {
  if (!result || !context || (result.risk_level !== "high" && !result.urgent)) return result;
  const outside = String(context.location_scope || "inside") === "outside";
  const label = String(context.location_label || "机构内").slice(0, 120);
  const institution = String(context.institution || "旅居机构").slice(0, 100);
  const responsible = String(context.responsible || "机构责任人").slice(0, 80);
  const phone = String(result.phone || "").includes("110") ? "110" : "120";
  const actions = Array.isArray(result.immediate_actions) ? result.immediate_actions : [];
  result.immediate_actions = [actions[0] || "立即停止活动并保持安全姿势", actions[1] || "请身边人陪同", outside ? `立即拨打${phone}并打开定位，向接警人员说明${label}；同时通知${institution}责任人。` : `立即拨打${phone}，让${institution}值班人员到场并为急救人员引路。`].slice(0, 3);
  result.place_route = outside ? `当前在${label}，先拨打${phone}并报告具体位置；${institution}责任人${responsible}同步跟进。` : `当前在${label}，先拨打${phone}；让机构值班人员到场引导急救。`;
  result.location_scope = outside ? "outside" : "inside";
  result.location_label = label;
  return result;
}

module.exports = async (req, res) => {
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  if (!allowedOrigin(req)) return res.status(403).json({ error: "origin_not_allowed" });
  if (!rateAllowed(req)) return res.status(429).json({ error: "rate_limited", message: "请稍后再试。" });
  const payload = req.body && typeof req.body === "object" ? req.body : {};
  const message = String(payload.message || "").trim();
  if (!message || message.length > 4000) return res.status(400).json({ error: "invalid_message" });
  const context = payload.context && typeof payload.context === "object" ? payload.context : {};
  const urgent = urgentGuardrail(message);
  if (urgent) return res.status(200).json({ provider: "急症安全分流", model: "deterministic-guardrail-v1", result: applyLocation(urgent, context) });
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "deepseek_not_configured" });
  const history = Array.isArray(payload.history) ? payload.history.slice(-6).filter((item) => item && ["user", "assistant"].includes(item.role)).map((item) => ({ role: item.role, content: String(item.content || "").slice(0, 1200) })) : [];
  const system = "你是广西旅居养老场景中的适老AI服务助手。只提供风险筛查、办事指引和信息整理，不作医学诊断。回答必须简短、明确、可行动，适合老人阅读，不编造地址、价格或电话。健康紧急情况优先120；人身安全、走失或治安危险优先110；消费维权可建议12315；其他政务诉求可建议12345。若当前在机构外，急症必须先写拨打急救或报警电话并报告具体位置，同时通知机构责任人，不得只写联系机构工作人员。只输出JSON对象：summary、immediate_actions（最多3条）、place_route、price、phone、risk_level（low/medium/high）、escalate、rationale（最多3条）。";
  try {
    const response = await fetch(`${String(process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "")}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ model: process.env.DEEPSEEK_MODEL || "deepseek-chat", messages: [{ role: "system", content: system }, ...history, { role: "user", content: `老人必要背景：${JSON.stringify({ current_city: context.current_city || "", age: context.age || "", conditions: Array.isArray(context.conditions) ? context.conditions : [], allergy: context.allergy || "", location_scope: context.location_scope || "inside", location_label: context.location_label || "", responsible: context.responsible || "" })}\n老人本次主动描述：${message}` }], temperature: 0.2, max_tokens: 650, response_format: { type: "json_object" }, stream: false }) });
    if (!response.ok) return res.status(502).json({ error: "deepseek_unavailable" });
    const remote = await response.json();
    const result = applyLocation(normalizeResult(remote?.choices?.[0]?.message?.content), context);
    return res.status(200).json({ provider: "DeepSeek", model: process.env.DEEPSEEK_MODEL || "deepseek-chat", result });
  } catch {
    return res.status(502).json({ error: "deepseek_unavailable" });
  }
};
