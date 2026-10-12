(function () {
  "use strict";

  const STORAGE_KEY = "guiyang-v1-data";
  const SESSION_KEY = "guiyang-v1-session";
  const TOKEN_KEY = "guiyang-v2-token";
  const AI_HISTORY_KEY = "guiyang-v2-ai-history";
  const AUTO_SPEAK_KEY = "guiyang-v1-auto-speak";
  const READ_NOTICES_KEY = "guiyang-v2-read-notices";
  const LOCAL_BACKEND_ENABLED = ["127.0.0.1", "localhost"].includes(window.location.hostname) && window.location.protocol.startsWith("http");
  const VERCEL_AI_ENABLED = window.location.hostname.endsWith(".vercel.app");
  const AI_BACKEND_ENABLED = LOCAL_BACKEND_ENABLED || VERCEL_AI_ENABLED;
  let backendSaveQueue = Promise.resolve();
  let stateSyncTimer = null;
  let speechTimer = null;
  let pendingSpeechText = "";
  let pendingSpeechButton = null;
  let currentUtterance = null;
  function autoSpeakEnabled() {
    try { return localStorage.getItem(AUTO_SPEAK_KEY) !== "off"; } catch (error) { return true; }
  }
  function chineseSpeechVoice() {
    if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) return null;
    try { return window.speechSynthesis.getVoices().find((voice) => /^zh(?:-|_)/i.test(voice.lang) || /^zh$/i.test(voice.lang)) || null; }
    catch (error) { return null; }
  }
  // 正在朗读的那个气泡按钮显示“停止”，其余恢复“听一遍”
  function markSpeaking(button) {
    document.querySelectorAll('[data-action="ai-speak"].speaking').forEach((item) => {
      item.classList.remove("speaking");
      item.setAttribute("aria-pressed", "false");
      const label = item.querySelector("span");
      if (label) label.textContent = "听一遍";
    });
    if (!button) return;
    button.classList.add("speaking");
    button.setAttribute("aria-pressed", "true");
    const label = button.querySelector("span");
    if (label) label.textContent = "停止";
  }
  function cancelElderSpeech() {
    if (speechTimer) window.clearTimeout(speechTimer);
    speechTimer = null;
    pendingSpeechText = "";
    pendingSpeechButton = null;
    currentUtterance = null;
    try { window.speechSynthesis?.cancel(); } catch (error) { /* Speech API is optional. */ }
    markSpeaking(null);
    if (document.getElementById("va-xg")?.dataset.state === "speaking") setXgState("idle");
  }
  // 视频画面上的字幕和小桂头像状态；对话框没打开时什么也不做
  function setCaption(who, text) {
    const box = document.getElementById("va-caption");
    if (!box || !text) return;
    box.dataset.who = who === "您" ? "user" : "xg";
    box.innerHTML = `<em>${escapeHtml(who)}</em><p>${escapeHtml(text)}</p>`;
  }
  function setXgState(mode) {
    const tile = document.getElementById("va-xg");
    if (!tile) return;
    tile.dataset.state = mode;
    const label = tile.querySelector("small");
    if (label) label.textContent = { listening: "在听您说", thinking: "正在查", speaking: "正在说" }[mode] || "小桂";
    // 没开画面时，画面中间的小桂头像下面也写出现在的状态
    const title = document.querySelector("#ai-video-placeholder strong");
    const placeholder = document.getElementById("ai-video-placeholder");
    if (title && placeholder) title.textContent = { listening: "小桂在听您说", thinking: "小桂正在帮您查", speaking: "小桂正在说" }[mode] || placeholder.dataset.title || "小桂";
  }
  function spokenText(text) {
    return String(text || "")
      .replace(/(?:EV|MV|CL|SOS|WA|CK)-[A-Z0-9-]+/gi, "")
      .replace(/\d{3,4}-\d*\*{2,}\d*/g, "机构值班电话")
      .replace(/\d{3}\*{2,}\d{2,4}/g, "登记的联系电话")
      .replace(/\d{2,}\*{2,}\d*/g, "机构值班电话")
      .replace(/([。；！？，])\s*。+/g, "$1")
      .replace(/\b(?:12315|12345|120|110|\d{7,11})\b/g, (digits) => digits.split("").map((digit) => ({ "0": "零", "1": "幺", "2": "二", "3": "三", "4": "四", "5": "五", "6": "六", "7": "七", "8": "八", "9": "九" })[digit]).join(""));
  }
  // 按句朗读：每句开始念时，把这句显示成视频画面上的字幕
  function speakForElder(text, force = false, button = null) {
    if (state.role !== "elder" || (!force && !autoSpeakEnabled())) return false;
    const voice = chineseSpeechVoice();
    if (!voice) { pendingSpeechText = text; pendingSpeechButton = button; return false; }
    const sentences = String(text || "").split(/(?<=[。！？；!?])/).map((item) => item.trim()).filter((item) => /[一-龥A-Za-z0-9]/.test(item));  // 只有标点的片段不念、不上字幕
    if (!sentences.length) return false;
    cancelElderSpeech();
    try {
      const batch = {};
      currentUtterance = batch;  // 被打断的上一批也会触发结束事件，只认当前这一批
      sentences.forEach((sentence, index) => {
        const utterance = new SpeechSynthesisUtterance(spokenText(sentence));
        utterance.lang = "zh-CN";
        utterance.voice = voice;
        utterance.rate = 0.85;
        utterance.onstart = () => { if (currentUtterance === batch) { setCaption("小桂", sentence); setXgState("speaking"); } };
        if (index === sentences.length - 1) utterance.onend = utterance.onerror = () => { if (currentUtterance === batch) { currentUtterance = null; markSpeaking(null); setXgState("idle"); } };
        window.speechSynthesis.speak(utterance);
      });
      markSpeaking(button && button.isConnected ? button : null);
      return true;
    } catch (error) { return false; }
  }
  function speechToggleLabel(compact = false) {
    const on = autoSpeakEnabled();
    return compact ? `${icon(on ? "volume-2" : "volume-x")}<span>朗读${on ? "开" : "关"}</span>` : `${icon(on ? "volume-2" : "volume-x")}自动朗读：${on ? "开" : "关"}`;
  }
  function syncSpeakButtons() {
    const available = Boolean(chineseSpeechVoice());
    document.querySelectorAll('[data-action="ai-speak"], [data-action="speech-toggle"]').forEach((button) => { button.hidden = !available; });
  }
  function refreshSpeechControls() {
    syncSpeakButtons();
    if (pendingSpeechText && chineseSpeechVoice() && autoSpeakEnabled()) {
      const pending = pendingSpeechText;
      const button = pendingSpeechButton;
      pendingSpeechText = "";
      pendingSpeechButton = null;
      speakForElder(pending, false, button);
    }
  }
  if (window.speechSynthesis?.addEventListener) window.speechSynthesis.addEventListener("voiceschanged", refreshSpeechControls);
  function authHeaders(json = false) {
    return { ...(json ? { "Content-Type": "application/json" } : {}), ...(sessionStorage.getItem(TOKEN_KEY) ? { Authorization: `Bearer ${sessionStorage.getItem(TOKEN_KEY)}` } : {}) };
  }

  // 平台应急响应闭环（安心应答）：真人接单 + 自动回拨 + 分级升级 + 全程留痕
  const SOS_CONFIG = Object.freeze({
    claimSlaSeconds: 30,        // L1：机构值班人员接单时限
    callbackRingSeconds: 25,    // 自动回拨响铃超过该时长视为未接通
    regulatorEscalateSeconds: 75, // L2 超时后升级监管端应急联动
    maxCallbackAttempts: 2,     // 自动回拨最多尝试次数
    launchCountdownSeconds: 5   // 一键呼救防误触缓冲
  });
  const SOS_ACTIVE_STATUSES = new Set(["waiting", "claimed"]);
  const MOVEMENT_MONITOR_INTERVAL_MS = 15000;

  const roleMeta = {
    elder: {
      label: "老人端",
      eyebrow: "我的旅居服务",
      userType: "旅居老人",
      search: false,
      nav: [
        { id: "dashboard", label: "首页", icon: "house" },
        { id: "profile", label: "我的档案", icon: "contact-round" },
        { id: "check", label: "今日打卡", icon: "heart-pulse" },
        { id: "requests", label: "求助进度", icon: "messages-square", count: 1 }
      ]
    },
    provider: {
      label: "服务机构端",
      eyebrow: "北海银龄康养中心",
      userType: "机构工作人员",
      search: true,
      nav: [
        { id: "dashboard", label: "机构工作台", icon: "layout-dashboard" },
        { id: "care", label: "AI 主动预警", icon: "heart-pulse" },
        { id: "residents", label: "服务老人", icon: "users-round" },
        { id: "services", label: "动态台账", icon: "route" },
        { id: "devices", label: "安全设备", icon: "shield-alert" },
        { id: "alerts", label: "预警处置", icon: "siren", count: 3 }
      ]
    },
    regulator: {
      label: "主管部门监管端",
      eyebrow: "自治区旅居养老监管",
      userType: "主管部门",
      search: true,
      nav: [
        { id: "dashboard", label: "监管总览", icon: "layout-dashboard" },
        { id: "radar", label: "类案雷达", icon: "radar" },
        { id: "advisor", label: "AI 监管参谋", icon: "bot" },
        { id: "insight", label: "态势研判", icon: "chart-no-axes-combined" },
        { id: "care", label: "AI 主动预警", icon: "heart-pulse" },
        { id: "monitoring", label: "人群监测", icon: "map-pinned" },
        { id: "movements", label: "动向监管", icon: "route" },
        { id: "institutions", label: "机构监管", icon: "building-2" },
        { id: "events", label: "事件中心", icon: "radio-tower", count: 4 }
      ]
    }
  };

  const pageTitles = {
    elder: {
      dashboard: "我的首页",
      profile: "我的档案",
      check: "今日打卡",
      requests: "求助进度"
    },
    provider: {
      dashboard: "机构工作台",
      care: "AI 主动预警",
      residents: "服务老人档案",
      services: "旅居动态台账",
      devices: "安全防护设备",
      alerts: "预警处置"
    },
    regulator: {
      dashboard: "监管总览",
      radar: "类案雷达",
      advisor: "AI 监管参谋",
      insight: "运行态势研判",
      care: "AI 主动预警",
      monitoring: "人群动态监测",
      movements: "旅居动向监管",
      institutions: "机构服务质量",
      events: "风险与事件中心"
    }
  };

  const state = {
    selectedRole: "elder",
    role: null,
    page: "dashboard",
    data: loadData(),
    residentQuery: "",
    residentRisk: "all",
    eventLevel: "all",
    eventStatus: "all",
    movementStatus: "all",
    movementConfirm: "all",
    routeAssessment: null,
    institutionQuery: "",
    deviceScene: "all",
    insight: null,
    insightError: "",
    insightLoading: false,
    activeStream: null,
    voiceRecorder: null,
    voiceStream: null,
    speechRecognition: null,
    aiHistory: [],
    lastAiResult: null,
    lastSafetyDecision: null,
    aiProvider: "",
    lastSpokenWeatherId: "",
    sosTicker: null,
    sos: {
      revision: -1,
      syncTimer: null,
      titleTimer: null,
      channel: null,
      audio: null,
      polling: false,
      pending: new Set(),
      muted: false,
      alerted: new Set()
    },
    sosLaunchTimer: null,
    movementMonitorTimer: null,
    backend: {
      enabled: LOCAL_BACKEND_ENABLED,
      connected: false,
      lastSync: "尚未连接",
      summary: null,
      revision: -1
    }
  };

  const loginView = document.getElementById("login-view");
  const appView = document.getElementById("app-view");
  const loginForm = document.getElementById("login-form");
  const loginAccount = document.getElementById("login-account");
  const loginPassword = document.getElementById("login-password");
  const loginError = document.getElementById("login-error");
  const demoAccountText = document.getElementById("demo-account-text");
  const mainContent = document.getElementById("main-content");
  const sideNav = document.getElementById("side-nav");
  const mobileNav = document.getElementById("mobile-nav");
  const sidebar = document.getElementById("sidebar");
  const sidebarScrim = document.getElementById("sidebar-scrim");
  const modalRoot = document.getElementById("modal-root");
  const toastRoot = document.getElementById("toast-root");

  function renderLoginStats() {
    const sample = window.GY_DATA;
    const closed = sample.events.filter((item) => item.status === "已办结").length;
    const values = {
      "login-resident-count": sample.residents.length,
      "login-institution-count": sample.institutions.length,
      "login-alert-count": sample.events.length - closed
    };
    for (const [id, value] of Object.entries(values)) document.getElementById(id).textContent = String(value);
  }

  function cloneSeed() {
    return anchorSeed(JSON.parse(JSON.stringify(window.GY_DATA)));
  }

  function loadData() {
    if (LOCAL_BACKEND_ENABLED && !sessionStorage.getItem(TOKEN_KEY)) return cloneSeed();
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (!saved) return cloneSeed();
      const parsed = JSON.parse(saved);
      if (parsed.version !== window.GY_DATA.version) return cloneSeed();
      return parsed;
    } catch (error) {
      return cloneSeed();
    }
  }

  function saveData(action = "更新业务数据", entityType = "state", entityId = "", options = {}) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.data));
    if (!state.backend.enabled) return Promise.resolve(false);
    const account = state.role && state.data.accounts[state.role] ? state.data.accounts[state.role] : null;
    const requestBody = {
      state: state.data,
      reset: Boolean(options.reset),
      audit: {
        actor_role: state.role || "system",
        actor_name: account ? account.name : "系统",
        action,
        entity_type: entityType,
        entity_id: entityId,
        detail: { role: state.role || "system" }
      }
    };
    backendSaveQueue = backendSaveQueue.catch(() => false).then(async () => {
      const response = await fetch("/api/state", {
        method: "POST",
        headers: authHeaders(true),
        body: JSON.stringify(requestBody)
      });
      if (!response.ok) throw Object.assign(new Error(`database_write_failed_${response.status}`), { status: response.status });
      const payload = await response.json();
      state.backend.connected = true;
      state.backend.lastSync = "刚刚";
      state.backend.summary = payload.database || state.backend.summary;
      // 不直接采用新修订号：随后拉取一次服务器合并后的状态（服务器写入的时间、归属和校验结果以服务器为准）
      window.setTimeout(pollBusinessState, 400);
      return true;
    }).catch((error) => {
      if (error && error.status >= 400 && error.status < 500 && error.status !== 401) {
        // 服务器在线但没有接受这次修改（越权、缺少必填说明等）：不当作“数据库离线”，页面恢复为服务器上的记录，不显示一份没保存的数据
        state.backend.connected = true;
        state.backend.lastSync = "上次修改未保存";
        state.backend.revision = -1;
        showToast("这次修改没有保存", "服务器没有接受这次修改，页面已恢复为服务器上的记录。", "warning");
        window.setTimeout(pollBusinessState, 300);
        console.warn("服务器没有接受这次写入。", error);
        return false;
      }
      state.backend.connected = false;
      state.backend.lastSync = "数据库暂时离线";
      console.warn("SQLite同步失败，已保留浏览器副本。", error);
      return false;
    });
    return backendSaveQueue;
  }

  async function syncFromBackend() {
    if (!state.backend.enabled) return false;
    try {
      await backendSaveQueue.catch(() => false);
      const response = await fetch("/api/state", { cache: "no-store", headers: authHeaders() });
      if (!response.ok) throw new Error("database_read_failed");
      const payload = await response.json();
      if (!payload.data || typeof payload.data !== "object") throw new Error("invalid_database_state");
      state.data = payload.data;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.data));
      state.backend.connected = true;
      state.backend.lastSync = "刚刚";
      state.backend.summary = payload.database || null;
      state.backend.revision = payload.revision ?? -1;
      return true;
    } catch (error) {
      state.backend.connected = false;
      state.backend.lastSync = "使用浏览器后备数据";
      return false;
    }
  }

  async function refreshCurrentData() {
    if (state.backend.enabled && !state.role) return;
    const loaded = await syncFromBackend();
    if (!loaded) state.data = loadData();
    renderShell();
    showToast(loaded ? "数据库已刷新" : "已载入后备数据", loaded ? "当前业务台账已从SQLite重新载入。" : "数据库暂不可用，当前使用浏览器副本。", loaded ? "success" : "warning");
  }

  async function pollBusinessState() {
    if (!state.backend.enabled || !state.role || modalRoot.innerHTML || document.activeElement?.closest("form")) return;
    try {
      await backendSaveQueue;
      const response = await fetch(`/api/state?since=${state.backend.revision}`, { cache: "no-store", headers: authHeaders() });
      if (!response.ok) return;
      const payload = await response.json();
      if (!payload.changed || !payload.data) return;
      state.data = payload.data;
      state.backend.revision = payload.revision;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.data));
      // 后台刷新不跳回页首：只重绘导航、通知数和当前页面
      const scrollY = window.scrollY;
      document.getElementById("notification-count").textContent = String(notificationItems().filter((item) => !item.read).length);
      renderNav();
      renderPage();
      window.scrollTo({ top: scrollY, behavior: "auto" });
      if (state.role === "regulator" && state.radar) loadRadar(true);
      if (state.role !== "elder" && state.care) loadCare(true);
    } catch (error) { /* 下一轮继续检查 */ }
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function icon(name, className = "") {
    return `<i data-lucide="${name}"${className ? ` class="${className}"` : ""} aria-hidden="true"></i>`;
  }

  function refreshIcons() {
    if (window.lucide) window.lucide.createIcons({ attrs: { "stroke-width": 1.8 } });
  }

  function riskLabel(risk) {
    return { high: "高风险", medium: "需关注", low: "低风险" }[risk] || "未评估";
  }

  function hotlineForEvent(event) {
    if (["健康异常", "健康提醒"].includes(event.category) && event.level === "high") return "120";
    if (["人身安全", "失联风险", "涉老诈骗风险"].includes(event.category)) return "110";
    if (event.category === "消费纠纷") return "12315";
    return "12345";
  }

  // 老人问“办到哪一步”：先找正在办的机构；只有高风险健康、人身安全、失联给急救或报警电话
  function eventCallButton(event, label = "") {
    const hotline = hotlineForEvent(event);
    if (["120", "110", "12315"].includes(hotline)) return `<a class="btn btn-secondary" href="tel:${hotline}">${icon("phone")}${label || `拨打 ${hotline}`}</a>`;
    const duty = (state.data.dutyRoster || [])[0]?.phone || hotline;
    return `<button class="btn btn-ghost" type="button" data-action="dial" data-number="${escapeHtml(duty)}" data-label="机构值班电话">${icon("phone")}${label || "联系机构值班"}</button>`;
  }

  function statusClass(status) {
    if (["已办结", "已完成", "正常", "在住", "已记录", "已返回", "已确认", "已核验"].includes(status)) return "success";
    if (["处置中", "待复核", "已转派", "关注", "外出中", "就医中", "待出发", "待确认", "重点跟进", "待核对"].includes(status)) return "warning";
    if (["超时", "紧急", "超时未归"].includes(status)) return "danger";
    return "neutral";
  }

  function statusTag(status) {
    return `<span class="status-tag ${statusClass(status)}">${escapeHtml(status)}</span>`;
  }

  function riskTag(risk) {
    return `<span class="risk-tag ${risk}">${riskLabel(risk)}</span>`;
  }

  function uniqueRecordId(prefix) {
    const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    const suffix = window.crypto?.randomUUID ? window.crypto.randomUUID().replaceAll("-", "").slice(0, 12) : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    return `${prefix}-${date}-${suffix}`;
  }

  // ---------------------------------------------------------------- 时间与处置时限（与服务端 sla.py 同一口径）
  // 事件的创建、截止、办结时间由服务器写入（毫秒）；“剩余 / 已超时 / 按时办结 / 超时办结”都按这些时间实时计算。
  function toMs(value) {
    if (typeof value === "number") return value > 0 ? value : null;
    if (typeof value === "string" && value.trim()) {
      if (/^\d+$/.test(value.trim())) return Number(value) || null;
      const parsed = Date.parse(value.trim());
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  function durationText(ms) {
    const minutes = Math.max(0, Math.floor(ms / 60000));
    if (minutes < 1) return "不到1分钟";
    if (minutes < 60) return `${minutes}分钟`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours < 24) return rest ? `${hours}小时${rest}分` : `${hours}小时`;
    return hours % 24 ? `${Math.floor(hours / 24)}天${hours % 24}小时` : `${Math.floor(hours / 24)}天`;
  }

  function slaMinutesFromLabel(label, level = "medium") {
    const text = String(label || "").replace(/\s+/g, "");
    const hours = text.match(/(\d+)小时(?:(\d+)分)?/);
    if (hours) return Number(hours[1]) * 60 + Number(hours[2] || 0);
    const minutes = text.match(/(\d+)分钟/);
    if (minutes) return Number(minutes[1]);
    const days = text.match(/(\d+)个?(?:工作日|天)/);
    if (days) return Number(days[1]) * 24 * 60;
    if (/优先|马上|立即|立刻|尽快/.test(text)) return 30;
    return { high: 30, medium: 120, low: 24 * 60 }[level] || 120;
  }

  // 新建事件先在本机写好时间（离线演示也能算时限）；连接服务器时以服务器写入的时间为准
  function stampNewEvent(eventItem) {
    const now = Date.now();
    eventItem.createdAt = now;
    eventItem.statusChangedAt = now;
    if (/当天|今日内|今天内/.test(String(eventItem.deadline || ""))) {
      const end = new Date(now);
      end.setHours(23, 59, 59, 0);
      eventItem.dueAt = end.getTime();
    } else {
      eventItem.dueAt = now + slaMinutesFromLabel(eventItem.deadline, eventItem.level) * 60000;
    }
    return eventItem;
  }

  function eventSla(event, now = Date.now()) {
    const due = toMs(event?.dueAt);
    const closedAt = toMs(event?.closedAt);
    if (event?.status === "已办结") {
      if (due && closedAt) return closedAt > due ? { state: "closed_late", text: `超时办结（超${durationText(closedAt - due)}）` } : { state: "closed_on_time", text: "按时办结" };
      return { state: "legacy", text: event?.deadline && event.deadline !== "已按时完成" ? event.deadline : "已办结" };
    }
    if (due) return due > now ? { state: "open_ok", text: `剩余 ${durationText(due - now)}`, soon: due - now < 30 * 60000 } : { state: "open_overdue", text: `已超时 ${durationText(now - due)}` };
    return { state: "legacy", text: event?.deadline || "未设时限" };
  }

  function slaTag(event) {
    const sla = eventSla(event);
    const tone = sla.state === "open_overdue" || sla.state === "closed_late" ? "danger" : sla.soon ? "warning" : sla.state === "closed_on_time" ? "success" : "neutral";
    return `<span class="sla-text ${tone}" title="${escapeHtml(event?.deadline ? `承诺时限：${event.deadline}` : "")}">${escapeHtml(sla.text)}</span>`;
  }

  // 给老人看的时限：不说“已超时”，而是告诉他可以催一催
  function elderSlaText(event) {
    const sla = eventSla(event);
    if (sla.state === "open_overdue") return "已超过约定时间，可以打电话问问";
    if (sla.state === "open_ok") return `约定${sla.text.replace("剩余 ", "")}内给您回复`;
    return sla.text;
  }

  // 显示时间：今天 / 昨天 / 月-日；毫秒时间和服务器写的“月-日 时:分”标签都能识别
  function friendlyTime(value) {
    let ms = toMs(value);
    if (!ms && typeof value === "string") {
      const match = value.match(/^(\d{2})-(\d{2}) (\d{2}):(\d{2})$/);
      if (match) {
        const guess = new Date(new Date().getFullYear(), Number(match[1]) - 1, Number(match[2]), Number(match[3]), Number(match[4]));
        if (guess.getTime() - Date.now() > 180 * 86400000) guess.setFullYear(guess.getFullYear() - 1);
        ms = guess.getTime();
      }
    }
    if (!ms) return String(value || "");
    const date = new Date(ms);
    const clock = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const day = 86400000;
    if (ms >= start.getTime() && ms < start.getTime() + day) return `今日 ${clock}`;
    if (ms >= start.getTime() - day && ms < start.getTime()) return `昨天 ${clock}`;
    if (ms >= start.getTime() + day && ms < start.getTime() + 2 * day) return `明日 ${clock}`;
    return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${clock}`;
  }

  function eventTimeText(event) {
    return event?.createdAt ? friendlyTime(event.createdAt) : String(event?.time || "");
  }

  // 呼救接单考核口径（与 sla.py 一致）：超过 30 秒仍无人接单的工单计入分母，避免只统计接了单的“幸存者”
  function sosOutcome(session, now = Date.now()) {
    const limit = SOS_CONFIG.claimSlaSeconds;
    if (typeof session.responseSeconds === "number") return session.responseSeconds <= limit ? "on_time" : "late";
    const created = toMs(session.createdAt);
    if (SOS_ACTIVE_STATUSES.has(session.status)) return !created ? "unknown" : now - created >= limit * 1000 ? "missed" : "pending";
    const closed = toMs(session.closedAtMs) || toMs(session.updatedAtMs);
    if (session.status === "cancelled") return created && closed && closed - created >= limit * 1000 ? "missed" : "excluded";
    if (created && closed) return closed - created <= limit * 1000 ? "on_time" : "late";
    return "unknown";
  }

  function sosSlaSummary(sessions = getSosSessions()) {
    const counts = { on_time: 0, late: 0, missed: 0, pending: 0, excluded: 0, unknown: 0 };
    sessions.forEach((session) => { counts[sosOutcome(session)] += 1; });
    const responded = counts.on_time + counts.late;
    const assessed = responded + counts.missed;
    return { ...counts, responded, assessed, overallRate: assessed ? Math.round(100 * counts.on_time / assessed) : null, respondedRate: responded ? Math.round(100 * counts.on_time / responded) : null };
  }

  // 离线演示（直接打开 index.html）没有服务器：样本日期在本机平移到今天，与服务端导入时的处理一致
  function anchorSeed(seed) {
    if (!seed || !seed.anchorDate) return seed;
    const origin = new Date(`${seed.anchorDate}T00:00:00`);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const days = Math.round((today - origin) / 86400000);
    if (!days) return seed;
    const year = origin.getFullYear();
    const pad = (value) => String(value).padStart(2, "0");
    const shiftDate = (y, m, d) => { const moved = new Date(y, m - 1, d + days); return moved; };
    const shiftText = (value) => typeof value !== "string" ? value : value
      .replace(/(^|[^\d])(\d{4})([-.])(\d{2})\3(\d{2})(?!\d)/g, (all, lead, y, sep, m, d) => { const moved = shiftDate(Number(y), Number(m), Number(d)); return `${lead}${moved.getFullYear()}${sep}${pad(moved.getMonth() + 1)}${sep}${pad(moved.getDate())}`; })
      .replace(/(^|[^\d.\-])(\d{2})-(\d{2})(?= \d{2}:\d{2})/g, (all, lead, m, d) => { const moved = shiftDate(year, Number(m), Number(d)); return `${lead}${pad(moved.getMonth() + 1)}-${pad(moved.getDate())}`; });
    const shiftMoment = (value) => { const ms = typeof value === "string" ? Date.parse(value) : NaN; return Number.isFinite(ms) ? ms + days * 86400000 : value; };
    (seed.events || []).forEach((event) => {
      ["createdAt", "dueAt", "closedAt", "statusChangedAt"].forEach((field) => { if (field in event) event[field] = shiftMoment(event[field]); });
      event.time = shiftText(event.time);
      (event.timeline || []).forEach((item) => { item.time = shiftText(item.time); });
      if (event.evidence) { event.evidence.confirmedAt = shiftText(event.evidence.confirmedAt); (event.evidence.quotes || []).forEach((quote) => { quote.time = shiftText(quote.time); }); }
    });
    (seed.movementLogs || []).forEach((log) => { ["departAt", "expectedReturn", "actualReturn"].forEach((field) => { log[field] = shiftText(log[field]); }); (log.timeline || []).forEach((item) => { item.time = shiftText(item.time); }); });
    (seed.serviceLogs || []).forEach((log) => { log.time = shiftText(log.time); });
    (seed.residents || []).forEach((resident) => { if (/^\d{2}-\d{2}$/.test(resident.checkIn || "")) resident.checkIn = shiftText(`${resident.checkIn} 00:00`).slice(0, 5); });
    if (seed.profile) seed.profile.stayRange = shiftText(seed.profile.stayRange);
    (seed.dailyChecks || []).forEach((check) => { check.date = shiftText(check.date); });
    (seed.sosSessions || []).forEach((session) => { session.createdLabel = shiftText(session.createdLabel); session.resolvedLabel = shiftText(session.resolvedLabel); });
    seed.anchoredAt = today.toLocaleDateString("sv-SE");
    return seed;
  }

  function screeningForResident(id) {
    const resident = state.data.residents.find((item) => item.id === id);
    return resident && resident.screening ? resident.screening : null;
  }

  function screeningStatusTag(screening) {
    if (!screening) return statusTag("未评估");
    const status = screening.reviewStatus || (screening.reviewRequired ? "待人工复核" : "已确认");
    return `<span class="status-tag ${status === "已确认" ? "success" : status === "缺项待补" ? "warning" : "danger"}">${escapeHtml(status)}</span>`;
  }

  function dimensionTag(dimension) {
    const level = dimension.level === "unknown" ? "neutral" : dimension.level;
    const label = dimension.level === "high" ? "高风险" : dimension.level === "medium" ? "需关注" : dimension.level === "unknown" ? "缺项" : "正常";
    return `<span class="dimension-chip ${level}"><b>${escapeHtml(dimension.label)}</b><span>${escapeHtml(dimension.value)}</span><small>${label}</small></span>`;
  }

  function screeningSummary(screening, compact = false) {
    if (!screening) return `<div class="empty-state compact">${icon("clipboard-x")}<strong>尚未完成身心快筛</strong><p>支持本人自填、机构代录或AI视频采集。</p></div>`;
    const dimensions = Array.isArray(screening.dimensions) ? screening.dimensions : [];
    return `<div class="screening-summary ${compact ? "compact" : ""}">
      <div class="screening-summary-head"><div><span class="eyebrow">五维身心快筛</span><h3>${riskLabel(screening.overall)} · 数据完整度 ${Math.round((screening.dataCompleteness ?? (5 - (screening.missing || []).length) / 5) * 100)}%</h3></div>${screeningStatusTag(screening)}</div>
      <div class="dimension-grid">${dimensions.map(dimensionTag).join("")}</div>
      <div class="screening-meta"><span>${icon("database")}来源：${escapeHtml(screening.source || "未标注")}</span><span>${icon("clock-3")}更新：${escapeHtml(screening.updatedAt || "未标注")}</span>${screening.missing && screening.missing.length ? `<span class="screening-missing">${icon("triangle-alert")}缺项：${screening.missing.map(escapeHtml).join("、")}</span>` : ""}</div>
      ${!compact && screening.carePlan ? `<div class="care-plan"><strong>${icon("hand-heart")}照护计划</strong><span>${escapeHtml(screening.carePlan)}</span></div>` : ""}
    </div>`;
  }

  function showToast(title, detail = "", type = "success") {
    toastRoot.querySelectorAll(".toast").forEach((item) => { if (item.dataset.title === title) item.remove(); });
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.dataset.title = title;
    const iconName = type === "danger" ? "circle-alert" : type === "warning" ? "triangle-alert" : "circle-check";
    toast.innerHTML = `${icon(iconName)}<div><strong>${escapeHtml(title)}</strong>${detail ? `<span>${escapeHtml(detail)}</span>` : ""}</div>`;
    toastRoot.appendChild(toast);
    refreshIcons();
    window.setTimeout(() => toast.remove(), 3600);
  }

  function setSelectedRole(role) {
    state.selectedRole = role;
    document.querySelectorAll(".role-option").forEach((button) => {
      const active = button.dataset.role === role;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    });
    const account = state.data.accounts[role];
    loginAccount.value = account.account;
    loginPassword.value = "";
    demoAccountText.textContent = state.backend.enabled ? `演示账号：${account.account}；密码查看本机 runtime/demo_credentials.json` : `离线演示账号：${account.account}（无服务端鉴权）`;
    loginError.hidden = true;
    refreshIcons();
  }

  function login(role) {
    state.role = role;
    state.page = "dashboard";
    sessionStorage.setItem(SESSION_KEY, role);
    state.sos.alerted = new Set(getSosSessions().filter((item) => SOS_ACTIVE_STATUSES.has(item.status)).map((item) => item.id));
    ensureSosSync();
    ensureMovementMonitor();
    if (!stateSyncTimer && state.backend.enabled) stateSyncTimer = window.setInterval(pollBusinessState, 5000);
    loginView.hidden = true;
    appView.hidden = false;
    renderShell();
    window.scrollTo({ top: 0, behavior: "auto" });
  }

  function logout() {
    cancelElderSpeech();
    closeModal();
    document.querySelector(".radar-alert")?.remove();
    state.radar = null; state.radarNewIds = null; state.radarScanAt = ""; state.advisorLog = [];
    state.care = null; state.careScanAt = ""; state.careError = "";
    state.insight = null; state.insightError = "";
    state.lastSpokenWeatherId = "";
    stopSosSync();
    if (stateSyncTimer) { window.clearInterval(stateSyncTimer); stateSyncTimer = null; }
    if (state.backend.enabled) fetch("/api/logout", { method: "POST", headers: authHeaders(true), body: "{}" }).catch(() => {});
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(AI_HISTORY_KEY);
    if (state.backend.enabled) { state.data = cloneSeed(); localStorage.removeItem(STORAGE_KEY); }
    state.role = null;
    delete document.body.dataset.role;
    appView.hidden = true;
    loginView.hidden = false;
    setSelectedRole(state.selectedRole);
    window.scrollTo({ top: 0, behavior: "auto" });
  }

  function renderShell() {
    const meta = roleMeta[state.role];
    const account = state.data.accounts[state.role];
    appView.dataset.role = state.role;
    document.body.dataset.role = state.role;
    document.getElementById("role-badge").textContent = meta.label;
    document.getElementById("page-eyebrow").textContent = meta.eyebrow;
    document.getElementById("user-name").textContent = account.name;
    document.getElementById("user-org").textContent = account.org;
    document.getElementById("user-avatar").textContent = account.avatar;
    document.getElementById("global-search-wrap").hidden = !meta.search;
    document.getElementById("notification-count").textContent = String(notificationItems().filter((item) => !item.read).length);
    renderNav();
    renderPage();
    if (state.role === "regulator" && !state.radar) loadRadar();
    if (state.role !== "elder" && !state.care) loadCare();
    window.scrollTo({ top: 0, behavior: "auto" });
  }

  function notificationItems() {
    let readIds = [];
    try { readIds = JSON.parse(sessionStorage.getItem(READ_NOTICES_KEY) || "[]"); } catch (error) { /* 旧缓存 */ }
    const own = state.data.profile?.id;
    const events = (state.data.events || []).filter((item) => item.status !== "已办结" && (state.role !== "elder" || item.residentId === own)).map((item) => ({ id: `event-${item.id}`, title: "待处理事件", detail: `${item.title} · ${item.status} · ${eventSla(item).text}`, time: eventTimeText(item) || "待确认", level: item.level === "high" || eventSla(item).state === "open_overdue" ? "danger" : "warning" }));
    const movements = state.role === "regulator" ? (state.data.movementLogs || []).filter((item) => item.regulatorStatus === "待确认").map((item) => ({ id: `move-${item.id}`, title: "动向待核验", detail: `${item.resident} · ${item.destination}`, time: item.departAt || "待确认", level: "warning" })) : [];
    const sos = (state.data.sosSessions || []).filter((item) => ["waiting", "claimed"].includes(item.status) && (state.role !== "elder" || item.residentId === own)).map((item) => ({ id: `sos-${item.id}-${item.status}`, title: "呼救工单进行中", detail: `${item.resident} · ${sosStatusLabel(item)}`, time: item.createdLabel || "当前", level: "danger" }));
    // 已保存的提醒（打卡关怀提醒、提醒家属记录等）；与服务端同样按身份过滤
    const stored = (state.data.notifications || []).filter((item) => state.role === "elder" ? item.residentId === own && !["provider", "staff"].includes(item.audience) : state.role === "regulator" ? item.audience !== "provider" : true)
      .map((item) => ({ id: `note-${item.id}`, title: item.title, detail: item.detail, time: friendlyTime(item.time) || "", level: item.level }));
    return [...sos, ...stored.filter((item) => item.level === "danger"), ...movements, ...stored.filter((item) => item.level !== "danger"), ...events].slice(0, 30).map((item) => ({ ...item, read: readIds.includes(item.id) }));
  }

  function renderNav() {
    const items = roleMeta[state.role].nav;
    sideNav.innerHTML = items.map((item) => {
      const count = item.id === "movements" ? (state.data.movementLogs || []).filter((log) => log.regulatorStatus === "待确认").length
        : item.id === "requests" ? state.data.events.filter((event) => event.residentId === state.data.profile.id && event.status !== "已办结").length
        : item.id === "alerts" ? state.data.events.filter((event) => event.status !== "已办结").length
        : item.id === "events" ? state.data.events.filter((event) => event.status !== "已办结").length
        : item.id === "radar" ? (state.radar?.clusters || []).filter((cluster) => !radarHandled(cluster)).length
        : item.id === "care" ? (state.care?.counts?.high || 0)
        : item.id === "devices" ? (state.data.devices || []).filter((device) => device.status !== "在线").length : 0;
      return `
      <button class="nav-item ${item.id === state.page ? "active" : ""}" type="button" data-page="${item.id}">
        ${icon(item.icon)}<span>${item.label}</span>${count ? `<span class="nav-count">${count}</span>` : ""}
      </button>
    `;
    }).join("");
    // 手机底栏最多放 5 格：条目多时放前 4 个，第 5 格“更多”打开侧栏（当前页不在前 4 个时替换第 4 格）
    let mobileItems = items;
    if (items.length > 5) {
      mobileItems = items.slice(0, 4);
      const current = items.find((item) => item.id === state.page);
      if (current && !mobileItems.includes(current)) mobileItems = [...mobileItems.slice(0, 3), current];
    }
    mobileNav.innerHTML = mobileItems.map((item) => `
      <button class="${item.id === state.page ? "active" : ""}" type="button" data-page="${item.id}">
        ${icon(item.icon)}<span>${item.label}</span>
      </button>
    `).join("") + (mobileItems.length < items.length ? `<button type="button" data-action="open-sidebar">${icon("menu")}<span>更多</span></button>` : "");
    mobileNav.style.setProperty("--nav-items", mobileItems.length + (mobileItems.length < items.length ? 1 : 0));
    refreshIcons();
  }

  function navigate(page) {
    state.page = page;
    closeSidebar();
    renderNav();
    renderPage();
    mainContent.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: "auto" });
  }

  function renderPage() {
    document.getElementById("page-title").textContent = pageTitles[state.role][state.page];
    // 老人端除首页外，顶栏始终保留一键呼救入口（首页已有大按钮）
    const topbarSos = document.getElementById("topbar-sos");
    if (topbarSos) topbarSos.hidden = !(state.role === "elder" && state.page !== "dashboard");
    const renderer = pageRenderers[state.role][state.page];
    mainContent.innerHTML = renderer ? renderer() : renderNotFound();
    bindPageEvents();
    refreshIcons();
    refreshSpeechControls();
    mountGeoMaps();
    if (state.role === "elder" && state.page === "dashboard") {
      const alert = currentWeatherAlert();
      const pending = alert && (state.data.safetyCheckins || []).some((item) => item.alertId === alert.id && item.residentId === state.data.profile.id && item.status === "pending");
      if (pending && state.lastSpokenWeatherId !== alert.id) {
        state.lastSpokenWeatherId = alert.id;
        window.setTimeout(() => speakForElder(`${alert.title}。${alert.advice}。请点击我很安全，或我需要帮助。`), 300);
      }
    }
  }

  /* 广西样本机构分布示意图：只把现有机构台账（城市、登记人数、预警、状态）画到地图上，不新增或推算数据。 */
  const GX_CITY_POINTS = {
    南宁: [108.32, 22.82], 柳州: [109.41, 24.31], 桂林: [110.29, 25.27], 梧州: [111.3, 23.47], 北海: [109.12, 21.48],
    防城港: [108.35, 21.69], 钦州: [108.62, 21.96], 贵港: [109.6, 23.09], 玉林: [110.15, 22.63], 百色: [106.62, 23.9],
    贺州: [111.55, 24.41], 河池: [108.06, 24.69], 来宾: [109.23, 23.73], 崇左: [107.35, 22.4]
  };
  const geoMapCharts = [];

  function geoMapMarkup(tall = false) {
    return `<div class="gx-map-frame${tall ? " tall" : ""}"><div class="gx-map" data-geo-map role="img" aria-label="广西样本机构分布示意图"><div class="gx-map-fallback">地图组件未加载，机构分布见机构监管清单。</div></div><span class="gx-map-caption">样本机构 · 示意</span><div class="gx-map-legend" aria-hidden="true"><span><i></i>机构状态正常</span><span><i class="warn"></i>机构状态需关注</span></div></div>`;
  }

  function institutionPoint(institution) {
    if (/巴马/.test(institution.name)) return [107.26, 24.15];
    const city = String(institution.city || "").replace(/市$/, "");
    return GX_CITY_POINTS[city] || null;
  }

  function mountGeoMaps() {
    while (geoMapCharts.length) {
      const { chart, observer } = geoMapCharts.pop();
      if (observer) observer.disconnect();
      chart.dispose();
    }
    const echarts = window.echarts;
    if (!echarts || !window.GY_GUANGXI_GEO) return;
    if (!echarts.getMap("guangxi")) echarts.registerMap("guangxi", window.GY_GUANGXI_GEO);
    mainContent.querySelectorAll("[data-geo-map]").forEach((element) => {
      element.innerHTML = "";
      const chart = echarts.init(element, null, { renderer: "canvas" });
      const points = (state.data.institutions || []).map((item) => ({ item, coord: institutionPoint(item) })).filter((entry) => entry.coord);
      const labelSide = { 防城港: "left", 钦州: "top" };
      const toPoint = ({ item, coord }) => ({ name: item.name, value: [...coord, item.residents], item, label: { position: labelSide[String(item.city || "").replace(/市$/, "")] || "right" } });
      const watch = points.filter(({ item }) => item.status !== "正常");
      const pointLabel = (item) => (/巴马/.test(item.name) ? "巴马" : String(item.city || "").replace(/市$/, ""));
      const markedCities = new Set(points.map(({ item }) => String(item.city || "").replace(/市$/, "") + "市"));
      const hiddenLabels = new Set(points.map(({ item }) => `${pointLabel(item)}市`));
      const size = (value) => Math.max(9, Math.min(18, Math.sqrt(Number(value[2]) || 0) * 1.2));
      chart.setOption({
        animation: false,
        tooltip: {
          trigger: "item",
          backgroundColor: "rgba(255,255,255,0.97)",
          borderColor: "#dce3e0",
          textStyle: { color: "#15211f", fontSize: 12 },
          extraCssText: "box-shadow:0 8px 20px -8px rgba(17,38,34,.25);border-radius:6px;",
          formatter: (params) => {
            const item = params.data && params.data.item;
            if (!item) return `${escapeHtml(params.name)}<br><span style="color:#5b6865">暂无样本机构</span>`;
            return `<strong>${escapeHtml(item.name)}</strong><br>所在城市：${escapeHtml(item.city)}<br>样本登记在住：${escapeHtml(item.residents)} 人<br>待处理预警：${escapeHtml(item.alerts)} 条<br>机构状态：${escapeHtml(item.status)}`;
          }
        },
        geo: {
          map: "guangxi",
          roam: false,
          aspectScale: 0.92,
          layoutCenter: ["50%", "50%"],
          layoutSize: "96%",
          itemStyle: { areaColor: "#e3eeea", borderColor: "#ffffff", borderWidth: 1.2 },
          emphasis: { itemStyle: { areaColor: "#cfe6de" }, label: { show: true, color: "#0d3d37", fontSize: 12 } },
          label: { show: true, color: "#6d7a77", fontSize: 11, formatter: (params) => (hiddenLabels.has(params.name) ? "" : params.name.replace(/市$/, "")) },
          regions: [...markedCities].map((name) => ({ name, itemStyle: { areaColor: "#cde5dc" } })),
          select: { disabled: true }
        },
        series: [
          {
            type: "scatter",
            coordinateSystem: "geo",
            data: points.map(toPoint),
            symbolSize: size,
            itemStyle: { color: "#13796a", borderColor: "#ffffff", borderWidth: 1.5, shadowBlur: 8, shadowColor: "rgba(15,102,87,0.35)" },
            label: { show: true, position: "right", distance: 6, color: "#0d3d37", fontSize: 12, fontWeight: 600, formatter: (params) => pointLabel(params.data.item) },
            emphasis: { scale: 1.2 },
            zlevel: 1
          },
          {
            type: "effectScatter",
            coordinateSystem: "geo",
            data: watch.map(toPoint),
            symbolSize: size,
            rippleEffect: { brushType: "stroke", scale: 2.4, period: 3.6 },
            itemStyle: { color: "#e39a2e", borderColor: "#ffffff", borderWidth: 1.5 },
            label: { show: false },
            zlevel: 2
          }
        ]
      });
      const observer = window.ResizeObserver ? new ResizeObserver(() => { if (!chart.isDisposed()) chart.resize(); }) : null;
      if (observer) observer.observe(element);
      geoMapCharts.push({ chart, observer });
    });
  }

  function renderNotFound() {
    return `<div class="empty-state">${icon("file-question")}<strong>页面不存在</strong><p>请从左侧导航重新选择。</p></div>`;
  }

  function openSidebar() {
    sidebar.classList.add("open");
    sidebarScrim.hidden = false;
  }

  function closeSidebar() {
    sidebar.classList.remove("open");
    sidebarScrim.hidden = true;
  }

  function openModal({ title, subtitle = "", body, footer = "", wide = false, onOpen }) {
    modalRoot.innerHTML = `
      <div class="modal-layer" role="presentation">
        <section class="modal ${wide ? "wide" : ""}" role="dialog" aria-modal="true" aria-labelledby="modal-title">
          <header class="modal-header">
            <div><h2 id="modal-title">${escapeHtml(title)}</h2>${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ""}</div>
            <button class="icon-btn modal-close" type="button" data-action="close-modal" aria-label="关闭" title="关闭">${icon("x")}</button>
          </header>
          <div class="modal-body">${body}</div>
          ${footer ? `<footer class="modal-footer">${footer}</footer>` : ""}
        </section>
      </div>
    `;
    document.body.style.overflow = "hidden";
    refreshIcons();
    const closeButton = modalRoot.querySelector(".modal-close");
    if (closeButton) closeButton.focus();
    if (onOpen) onOpen();
  }

  function closeModal() {
    cancelElderSpeech();
    if (state.speechRecognition) {
      try { state.speechRecognition.abort(); } catch (error) { /* recognition may already be stopped */ }
      state.speechRecognition = null;
    }
    if (state.activeStream) {
      state.activeStream.getTracks().forEach((track) => track.stop());
      state.activeStream = null;
    }
    if (state.voiceStream) {
      state.voiceStream.getTracks().forEach((track) => track.stop());
      state.voiceStream = null;
    }
    state.voiceRecorder = null;
    modalRoot.innerHTML = "";
    document.body.style.overflow = "";
  }

  function statCard(label, value, unit, iconName, note, noteType = "") {
    return `
      <article class="stat-card">
        <div class="stat-top"><span>${label}</span><span class="stat-icon">${icon(iconName)}</span></div>
        <div class="stat-value"><strong>${value}</strong>${unit ? `<small>${unit}</small>` : ""}</div>
        <div class="stat-note ${noteType}">${noteType === "positive" ? icon("trending-up") : noteType === "warning" ? icon("triangle-alert") : noteType === "danger" ? icon("circle-alert") : icon("clock-3")}${note}</div>
      </article>
    `;
  }

  function residentCell(resident) {
    return `<div class="cell-main"><span class="cell-avatar">${escapeHtml(resident.name.slice(-1))}</span><span class="cell-copy"><strong>${escapeHtml(resident.name)}</strong><small>${escapeHtml(resident.id)}</small></span></div>`;
  }

  function eventRows(events, role) {
    if (!events.length) return `<tr><td colspan="7"><div class="empty-state">${icon("inbox")}<strong>暂无匹配事件</strong></div></td></tr>`;
    return events.map((event) => `
      <tr>
        <td><button class="text-btn" type="button" data-action="event-detail" data-id="${event.id}">${escapeHtml(event.id)}</button></td>
        <td><div class="cell-copy"><strong>${escapeHtml(event.title)}</strong><small>${escapeHtml(event.category)} · ${escapeHtml(event.source)}</small></div></td>
        <td class="nowrap">${escapeHtml(event.resident)}</td>
        <td>${riskTag(event.level)}</td>
        <td>${statusTag(event.status)}</td>
        <td><div class="cell-copy"><strong>${escapeHtml(event.owner)}</strong><small>${slaTag(event)}</small></div></td>
        <td>
          <button class="text-btn" type="button" data-action="${role === "elder" ? "event-detail" : "handle-event"}" data-id="${event.id}">
            ${role === "elder" ? "查看进度" : event.status === "已办结" ? "查看" : "处理"}${icon("arrow-right")}
          </button>
        </td>
      </tr>
    `).join("");
  }

  function eventPriority(a, b) {
    const overdue = (event) => eventSla(event).state === "open_overdue";
    return (overdue(b) - overdue(a)) || ((b.level === "high") - (a.level === "high")) || ((toMs(a.dueAt) || Infinity) - (toMs(b.dueAt) || Infinity));
  }

  function getMovementLogs() {
    return Array.isArray(state.data.movementLogs) ? state.data.movementLogs : [];
  }

  function movementDueAt(log) {
    if (!log || !log.expectedReturnAt) return null;
    const timestamp = Date.parse(log.expectedReturnAt);
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  function movementMonitorEvent(log) {
    const eventId = uniqueRecordId("EV");
    return {
      id: eventId,
      residentId: log.residentId,
      resident: log.resident,
      level: log.risk === "high" ? "high" : "medium",
      category: "失联风险",
      title: "旅居动向超时未归",
      source: "动向台账规则",
      location: log.destination,
      time: "刚刚",
      status: "待复核",
      owner: log.responsible || "机构责任人",
      deadline: "立即核验",
      summary: `${log.resident}预计${log.expectedReturn}返回，目前仍未完成返回核验。`,
      action: `立即联系${log.responsible || "机构责任人"}核实位置；无法联系时按失联流程升级并报告最后已知地点。`,
      movementId: log.id,
      locationScope: "outside",
      rationale: ["预计返回时间已过", `最后记录地点：${log.destination}；场所风险${routeRiskLabel(log.routeAssessment)}（资料须复核）`, `责任人：${log.responsible || "未填写"}`],
      timeline: [
        { time: "刚刚", text: "系统检测到预计返回时间已过，自动转入失联风险复核", state: "current" }
      ]
    };
  }

  function refreshOverdueMovements() {
    const now = Date.now();
    let changed = false;
    getMovementLogs().forEach((log) => {
      const dueAt = movementDueAt(log);
      if (!dueAt || dueAt > now || !isMovementActive(log) || log.status === "超时未归") return;
      log.status = "超时未归";
      log.risk = log.risk === "high" ? "high" : "medium";
      log.timeline = log.timeline || [];
      log.timeline.push({ time: "刚刚", text: "系统按预计返回时间自动标记为超时未归", state: "current" });
      if (!log.eventId) {
        const eventItem = movementMonitorEvent(log);
        state.data.events.unshift(stampNewEvent(eventItem));
        log.eventId = eventItem.id;
      }
      state.data.notifications = Array.isArray(state.data.notifications) ? state.data.notifications : [];
      state.data.notifications.unshift({ id: Date.now(), title: "动向超时未归", detail: `${log.resident}在${log.destination}尚未完成返回核验`, time: "刚刚", level: "danger", read: false });
      changed = true;
    });
    if (changed) {
      saveData("系统自动标记超时未归", "movement_monitor", "overdue");
      renderNav();
      if (state.role) renderPage();
    }
    return changed;
  }

  function ensureMovementMonitor() {
    // 连接本地服务时，外出超时未归由服务器后台值守判定（页面关闭也照常运行）；只有离线演示才由本页计时
    if (state.movementMonitorTimer || state.backend.enabled) return;
    refreshOverdueMovements();
    state.movementMonitorTimer = window.setInterval(refreshOverdueMovements, MOVEMENT_MONITOR_INTERVAL_MS);
  }

  function isMovementActive(log) {
    return ["外出中", "就医中", "在途中", "超时未归"].includes(log.status);
  }

  function activeMovementResidentIds(logs = getMovementLogs()) {
    return new Set(logs.filter(isMovementActive).map((log) => log.residentId));
  }

  function movementRows(logs, role) {
    if (!logs.length) return `<tr><td colspan="7"><div class="empty-state">${icon("map-pin-off")}<strong>暂无匹配动向</strong><p>调整筛选条件后再试。</p></div></td></tr>`;
    return logs.map((log) => {
      const primaryAction = role === "regulator" && log.regulatorStatus === "待确认"
        ? `<button class="text-btn" type="button" data-action="movement-confirm" data-id="${log.id}">确认${icon("arrow-right")}</button>`
        : `<button class="text-btn" type="button" data-action="movement-detail" data-id="${log.id}">查看${icon("arrow-right")}</button>`;
      return `
        <tr class="${log.status === "超时未归" ? "movement-row-overdue" : ""}">
          <td><div class="movement-person-cell">${residentCell({ name: log.resident, id: log.residentId })}<small>${escapeHtml(log.id)} · ${escapeHtml(log.source)}</small></div></td>
          <td><div class="cell-copy"><strong>${statusTag(log.status)}</strong><small>${escapeHtml(log.type)}</small></div></td>
          <td><div class="cell-copy movement-destination"><strong>${escapeHtml(log.destination)}</strong><small>${escapeHtml(log.reason)}</small><small>场所：${escapeHtml(routeRiskLabel(log.routeAssessment))}${log.routeAssessment ? " · 演示/待核验" : ""}</small></div></td>
          <td><div class="cell-copy"><strong>${escapeHtml(log.departAt)}</strong><small>预计返回：${escapeHtml(log.expectedReturn)}</small></div></td>
          <td><div class="cell-copy"><strong>${escapeHtml(log.responsible)}</strong><small>${escapeHtml(log.responsiblePhone)} · ${escapeHtml(log.companion)}</small></div></td>
          <td><div class="confirmation-stack"><span><small>机构</small>${statusTag(log.institutionStatus)}</span><span><small>监管</small>${statusTag(log.regulatorStatus)}</span></div></td>
          <td><div class="table-actions action-row">${primaryAction}${role === "provider" && isMovementActive(log) ? `<button class="text-btn" type="button" data-action="movement-return" data-id="${log.id}">确认返回</button>` : ""}</div></td>
        </tr>
      `;
    }).join("");
  }

  function routeRiskLabel(assessment) {
    return !assessment || assessment.level === "unknown" ? "资料待核验" : { high: "高风险提示", medium: "需关注", low: "低风险提示" }[assessment.level] || "资料待核验";
  }

  function routeRiskMarkup(assessment) {
    if (!assessment) return "填写目的地后生成场所风险提示；资料未核验时不判为低风险。";
    const checklist = (assessment.border_checklist || []).length ? `<br><b>${assessment.border === "cross" ? "出境核查" : "边境地区提醒"}：</b>${assessment.border_checklist.map(escapeHtml).join("；")}` : "";
    return `<strong>${escapeHtml(routeRiskLabel(assessment))}</strong> · ${escapeHtml(assessment.source)}。${(assessment.factors || []).map(escapeHtml).join("、") || "适老风险资料不足"}。${(assessment.advice || []).map((item) => escapeHtml(String(item).replace(/[。；]$/, ""))).join("；")}${checklist}`;
  }

  async function assessDestination(residentId, destination) {
    if (!state.backend.enabled || !destination.trim()) return { level: "unknown", source: "离线演示：未查到场所资料", missing: ["场所踏勘"], advice: ["请机构人工核实路线与陪同安排。"] };
    try {
      const response = await fetch("/api/route-risk", { method: "POST", headers: authHeaders(true), body: JSON.stringify({ residentId, destination }) });
      if (response.ok) return (await response.json()).assessment;
    } catch (error) { /* 无接口时按资料不足显示 */ }
    return { level: "unknown", source: "场所资料暂不可用", missing: ["场所踏勘"], advice: ["请机构人工核实路线与陪同安排。"] };
  }

  function currentWeatherAlert() {
    return (state.data.weatherAlerts || []).find((alert) => alert.status === "生效中") || null;
  }

  function renderWeatherElderBanner() {
    const alert = currentWeatherAlert();
    if (!alert) return "";
    const checkin = (state.data.safetyCheckins || []).find((item) => item.alertId === alert.id && item.residentId === state.data.profile.id);
    if (!checkin) return "";
    const trip = getMovementLogs().find((item) => item.residentId === state.data.profile.id && ["外出中", "就医中", "在途中", "超时未归"].includes(item.status));
    return `<section class="weather-banner" role="alert" data-weather-alert="${escapeHtml(alert.id)}">
      <span class="weather-banner-icon">${icon(alert.type === "台风" ? "cloud-lightning" : "sun")}</span>
      <div><span class="eyebrow">${escapeHtml(alert.source)} · ${escapeHtml(alert.cities.join("、"))}</span><h3>${escapeHtml(alert.title)}</h3><p>${escapeHtml(alert.advice)}</p>${trip ? `<p class="weather-trip">您正在外出，请尽快返回安全地点，或告诉工作人员您在哪里。</p>` : ""}</div>
      <div class="weather-actions">${checkin.status === "pending" ? `<button class="btn btn-secondary" type="button" data-action="weather-safe" data-id="${escapeHtml(alert.id)}">我很安全</button><button class="btn btn-danger" type="button" data-action="weather-help" data-id="${escapeHtml(alert.id)}">我需要帮助</button>` : `<span class="status-tag ${checkin.status === "help" ? "danger" : "success"}">${checkin.status === "help" ? "已发出求助" : "已报平安"}</span>`}</div>
    </section>`;
  }

  function renderWeatherTasks(role, compact = false) {
    const active = (state.data.weatherAlerts || []).filter((alert) => alert.status === "生效中");
    if (!active.length && role !== "regulator") return "";
    const ids = new Set(active.map((alert) => alert.id));
    const items = (state.data.safetyCheckins || []).filter((item) => ids.has(item.alertId));
    const responded = items.filter((item) => item.status !== "pending").length;
    const pending = items.filter((item) => item.status === "pending").length;
    const help = items.filter((item) => item.status === "help").length;
    const overdue = items.filter((item) => item.status === "pending" && item.escalatedAt).length;
    const shown = compact ? items.slice(0, 4) : items;
    return `<section class="panel weather-panel mb-4">
      <header class="panel-header"><div class="section-head-copy"><h3>${role === "regulator" ? "应急调度 · 报平安" : "报平安任务"}</h3><p>${active.length ? `${active.map((alert) => alert.title).map(escapeHtml).join("、")} · 模拟预警（演示）` : "当前无生效预警；本地完整服务可发布模拟预警"}</p></div><div class="weather-panel-actions">${role === "regulator" && LOCAL_BACKEND_ENABLED ? `<button class="btn btn-primary" type="button" data-action="weather-publish">${icon("megaphone")}发布预警</button>` : ""}${active.length ? `<span class="status-tag ${overdue ? "danger" : "warning"}">${pending}位未回应</span>` : ""}</div></header>
      ${active.length ? `<div class="panel-body"><div class="quality-metrics weather-metrics"><div><strong>${items.length ? Math.round(responded * 100 / items.length) : 0}%</strong><span>报平安率</span></div><div><strong>${pending}</strong><span>未回应</span></div><div><strong>${help}</strong><span>需要帮助</span></div><div><strong>${overdue}</strong><span>超时待跟进</span></div></div>
      <div class="weather-task-list">${shown.map((item) => `<div class="weather-task${item.status === "pending" && item.escalatedAt ? " overdue" : ""}"><div><strong>${escapeHtml(item.resident)}</strong><small>${escapeHtml(item.reason || "预警范围内")} · ${item.status === "pending" ? item.escalatedAt ? "超时未回应，机构负责人待跟进" : `截止 ${new Date(item.deadlineAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}` : item.status === "help" ? "请求帮助" : `${escapeHtml(item.by)}已确认安全`}</small></div><div>${item.status === "pending" && role === "provider" ? `<button class="btn btn-secondary" type="button" data-action="weather-provider-safe" data-alert="${escapeHtml(item.alertId)}" data-resident="${escapeHtml(item.residentId)}">已电话确认安全</button>` : ""}${item.status === "pending" && item.escalatedAt && role === "regulator" ? `<button class="btn btn-secondary" type="button" data-action="weather-followup" data-id="${escapeHtml(item.id)}"${item.supervisedAt ? " disabled" : ""}>${item.supervisedAt ? "已督办" : "一键督办"}</button>` : ""}<span class="status-tag ${item.status === "help" || item.escalatedAt && item.status === "pending" ? "danger" : item.status === "safe" ? "success" : "warning"}">${item.status === "help" ? "求助" : item.status === "safe" ? "安全" : "待回应"}</span></div></div>`).join("")}${compact && items.length > shown.length ? `<button class="text-btn" type="button" data-page="alerts">查看全部报平安任务${icon("arrow-right")}</button>` : ""}</div>${role === "regulator" ? `<div class="weather-panel-foot">${active.map((alert) => `<button class="text-btn" type="button" data-action="weather-resolve" data-id="${escapeHtml(alert.id)}">解除${escapeHtml(alert.title)}</button>`).join("")}</div>` : ""}</div>` : ""}
    </section>`;
  }

  function openWeatherPublish() {
    if (state.role !== "regulator") return;
    const cities = [...new Set((state.data.institutions || []).map((item) => String(item.city || "").replace(/市$/, "")))];
    openModal({
      title: "发布模拟天气预警",
      subtitle: "仅演示数据，不接外部天气服务；发布后自动生成报平安任务",
      body: `<form id="weather-publish-form" class="form-grid"><label><span>预警类型</span><select class="form-control" name="type"><option>台风</option><option>高温</option></select></label><label><span>等级</span><select class="form-control" name="level"><option>蓝色</option><option>黄色</option><option>橙色</option><option>红色</option></select></label><label class="full"><span>预警城市</span><span class="weather-city-list">${cities.map((city) => `<label><input type="checkbox" name="cities" value="${escapeHtml(city)}"${["北海", "防城港"].includes(city) ? " checked" : ""}>${escapeHtml(city)}</label>`).join("")}</span></label><label class="full"><span>报平安截止</span><select class="form-control" name="deadlineMinutes"><option value="30">30 分钟</option><option value="2">2 分钟（演示超时升级）</option></select></label><div class="notice full">${icon("shield-check")}天气信息始终标注“模拟预警（演示）”；提醒文案只依据所选类型和城市生成。</div></form>`,
      footer: `<button class="btn btn-secondary" type="button" data-action="close-modal">取消</button><button class="btn btn-primary" type="submit" form="weather-publish-form">${icon("megaphone")}确认发布</button>`,
      onOpen: () => document.getElementById("weather-publish-form").addEventListener("submit", publishWeatherAlert)
    });
  }

  async function publishWeatherAlert(event) {
    event.preventDefault();
    const form = new FormData(event.target);
    const cities = form.getAll("cities").map(String);
    if (!cities.length) return showToast("请选择城市", "至少选择一个预警城市。", "warning");
    const button = modalRoot.querySelector('[type="submit"][form="weather-publish-form"]');
    if (button) button.disabled = true;
    try {
      const response = await fetch("/api/weather-alert", { method: "POST", headers: authHeaders(true), body: JSON.stringify({ type: form.get("type"), level: form.get("level"), cities, deadlineMinutes: Number(form.get("deadlineMinutes")) }) });
      if (!response.ok) throw new Error("publish_failed");
      const payload = await response.json();
      closeModal();
      await syncFromBackend();
      renderShell();
      showToast("模拟预警已发布", `已生成 ${payload.alert.affectedResidentIds.length} 位老人的报平安任务。`, "success");
    } catch (error) { if (button) button.disabled = false; showToast("发布失败", "请检查本地服务后重试。", "warning"); }
  }

  async function submitWeatherCheckin(alertId, residentId, status) {
    if (status === "help" && state.role === "elder") startSosSession(`${(state.data.weatherAlerts || []).find((item) => item.id === alertId)?.type || "天气"}预警·报平安求助`, { openStatus: true });
    try {
      const response = await fetch("/api/checkin", { method: "POST", headers: authHeaders(true), body: JSON.stringify({ alertId, residentId, status, note: status === "help" ? "本人需要工作人员联系" : state.role === "provider" ? "工作人员已电话确认安全" : "本人确认安全" }) });
      if (!response.ok) throw new Error("checkin_failed");
      await syncFromBackend();
      renderShell();
      showToast(status === "help" ? "求助已发出" : "报平安成功", status === "help" ? "已进入现有呼救接单与升级流程。" : "机构和监管端已同步更新。", "success");
    } catch (error) { showToast("报平安同步失败", "呼救如已发出仍会继续处理；请检查本地服务后重试。", "warning"); }
  }

  async function weatherAction(action, payload) {
    const response = await fetch("/api/weather-alert", { method: "POST", headers: authHeaders(true), body: JSON.stringify({ action, ...payload }) });
    if (!response.ok) throw new Error("weather_action_failed");
    await syncFromBackend();
    renderShell();
  }

  async function superviseWeatherCheckin(id) {
    try {
      const response = await fetch("/api/weather-followup", { method: "POST", headers: authHeaders(true), body: JSON.stringify({ checkinId: id }) });
      if (!response.ok) throw new Error("followup_failed");
      await syncFromBackend();
      renderShell();
      showToast("已生成督办记录", "机构负责人需在站内跟进未回应老人。", "success");
    } catch (error) { showToast("督办失败", "请检查本地服务后重试。", "warning"); }
  }

  function elderGreeting() {
    const hour = new Date().getHours();
    return hour < 5 ? "晚上好" : hour < 11 ? "上午好" : hour < 13 ? "中午好" : hour < 18 ? "下午好" : "晚上好";
  }

  function elderHonorific(profile = state.data.profile) {
    const surname = String(profile?.name || "").slice(0, 1);
    return surname ? `${surname}${profile.gender === "男" ? "叔叔" : "阿姨"}` : "您";
  }

  const ELDER_ASK_EXAMPLES = ["明天想去巴马长寿村爬山", "有个养生基地让我今天交一万块定金", "儿子说住院了，要我转他1000", "康复训练多收了钱，和公示价格不一样"];

  // 打招呼、道谢这类话不需要查证，像平常说话一样回一句，不出建议卡
  const SMALL_TALK = [
    ["who", "你是谁|你叫什么(?:名字)?|你能做什么|你会做?什么|你能干什么|你能帮我(?:做|干)?什么|你有什么用"],
    ["bye", "再见|拜拜|回头见|晚安|先这样"],
    ["thanks", "谢谢(?:你|您)?|谢了|多谢|感谢(?:你|您)?|辛苦(?:你|您)?了|麻烦(?:你|您)了"],
    ["greet", "你好|您好|哈喽|嗨|在吗|在不在|早上好|上午好|中午好|下午好|晚上好|早安|早"],
    ["ack", "好的|好嘞|好|嗯嗯|嗯|哦|行|可以|收到|没问题|没事了|没事|没有了|没了|我?知道了|我?明白了|我?懂了"]
  ];

  function smallTalkKind(message) {
    const text = String(message || "").replace(/[\s，。！？、,.!?~…～]+/g, "").replace(/小桂/g, "");
    if (!text) return "greet";
    const words = SMALL_TALK.map(([, pattern]) => pattern).join("|");
    if (text.length > 14 || !new RegExp(`^(?:(?:${words})[啊呀啦哈呢吧哦喔]*)+$`).test(text)) return "";
    return SMALL_TALK.find(([, pattern]) => new RegExp(pattern).test(text))[0];
  }

  function smallTalkReply(kind) {
    const name = elderHonorific();
    const alert = currentWeatherAlert();
    const checkin = alert && (state.data.safetyCheckins || []).find((item) => item.alertId === alert.id && item.residentId === state.data.profile.id);
    const weatherTip = checkin ? `今天有${alert.type || "天气"}预警，先别出远门${checkin.status === "pending" ? "，记得在首页点“我很安全”报个平安" : ""}。` : "";
    return {
      who: "我是小桂，帮您办事的助手。想出门、有人让您交钱、收费和说的不一样，都可以问我，我先帮您查清楚，再告诉您怎么做。",
      greet: `${name}好呀，我在呢！${weatherTip || "您想问点什么？"}`,
      thanks: `不客气，${name}。还有什么事，随时叫我。`,
      ack: "好嘞，有事随时跟我说。",
      bye: `${name}再见，有事随时叫我。`
    }[kind];
  }

  function elderFamilyHtml(profile) {
    if (!profile.emergencyName) return "";
    const relation = (String(profile.emergencyName).match(/[（(](.+?)[）)]/) || [])[1] || "家人";
    const person = String(profile.emergencyName).replace(/[（(].*/, "");
    return `<button class="elder-family" type="button" data-action="dial" data-number="${escapeHtml(profile.emergencyPhone || "")}" data-label="${escapeHtml(profile.emergencyName)}"><span class="elder-family-icon">${icon("phone-call")}</span><span><strong>给${escapeHtml(relation)}打电话</strong><small>${escapeHtml(person)} · ${escapeHtml(profile.emergencyPhone || "未登记电话")}</small></span></button>`;
  }

  // 老人首页的三个常用服务：入口上直接写清现在的状态
  function elderServicesHtml(openEvents) {
    const today = new Date().toLocaleDateString("sv-SE");
    const checkedToday = (state.data.dailyChecks || []).some((item) => item.date === today && DAILY_CHECK_FIELDS.every(([key, , options]) => options.includes(item[key])));
    return `<nav class="elder-services" aria-label="常用服务">
      <button class="svc" type="button" data-page="check">
        <span class="svc-icon">${icon("clipboard-check")}</span>
        <span class="svc-copy"><strong>今日打卡 ${checkedToday ? `<span class="status-tag success">今天已做</span>` : `<span class="status-tag warning">今天还没做</span>`}</strong><small>${checkedToday ? "今天的已经记下了" : "4 个问题，约 30 秒"}</small></span>
        <span class="svc-go">${icon("chevron-right")}</span>
      </button>
      <button class="svc svc-report" type="button" data-action="emergency-report">
        <span class="svc-icon">${icon("message-square-warning")}</span>
        <span class="svc-copy"><strong>求助与维权</strong><small>多收费、服务差、有人让交钱</small></span>
        <span class="svc-go">${icon("chevron-right")}</span>
      </button>
      <button class="svc" type="button" data-page="requests">
        <span class="svc-icon">${icon("list-checks")}</span>
        <span class="svc-copy"><strong>办理进度</strong><small>${openEvents.length ? `${openEvents.length} 件正在办理` : "没有要办的事"}</small></span>
        <span class="svc-go">${icon("chevron-right")}</span>
      </button>
    </nav>`;
  }

  function renderElderDashboard() {
    const p = state.data.profile;
    const elderEvents = state.data.events.filter((event) => event.residentId === p.id);
    const openEvents = elderEvents.filter((event) => event.status !== "已办结");
    const activeEvent = openEvents[0];
    const screening = p.screening;
    const overall = screening ? screening.overall : p.risk;
    // 预警生效且本人还没报平安时，报平安横幅放在最前面
    const weatherAlert = currentWeatherAlert();
    const weatherPending = Boolean(weatherAlert) && (state.data.safetyCheckins || []).some((item) => item.alertId === weatherAlert.id && item.residentId === p.id && item.status === "pending");
    const trip = getMovementLogs().find((log) => log.residentId === p.id && isMovementActive(log));
    const notice = (state.data.broadcasts || [])[0];
    const schedule = [
      { time: "07:30", title: "早餐与用药提醒", place: "一楼营养餐厅", who: "护理员 林静", done: true },
      { time: "14:30", title: "血压复测", place: "健康管理室，请带上健康卡", who: "护士 梁燕" },
      { time: "16:00", title: "膝关节康复训练", place: "二楼康复区，约 20 分钟", who: "康复师 罗文" }
    ];
    return `
      <section class="elder-greet">
        <div>
          <h2>${escapeHtml(elderHonorific(p))}，${elderGreeting()}</h2>
          <p>${escapeHtml(p.institution)} · ${escapeHtml(p.room)}</p>
        </div>
        <dl class="elder-greet-meta">
          <div><dt>今天的状态</dt><dd class="tone-${escapeHtml(overall)}">${riskLabel(overall)}</dd></div>
          <div><dt>最近打卡</dt><dd>${escapeHtml(friendlyTime(p.lastCheck))}</dd></div>
        </dl>
      </section>

      ${weatherPending ? renderWeatherElderBanner() : ""}

      <div class="elder-hero">
        <section class="assistant-card" aria-label="和小桂说说话">
          <div class="assistant-head">
            <span class="assistant-mark" aria-hidden="true">桂</span>
            <div>
              <h3>和小桂说说话</h3>
              <p>出门、交钱、身体不舒服，说一句就行</p>
            </div>
          </div>
          <button class="assistant-talk" type="button" data-action="ai-video">${icon("video")}<span><strong>按一下，和小桂视频说话</strong><small>也可以打字</small></span></button>
          <div class="assistant-try"><span>常有人这样问</span>${ELDER_ASK_EXAMPLES.map((text) => `<button type="button" data-action="ai-ask" data-text="${escapeHtml(text)}">${escapeHtml(text)}</button>`).join("")}</div>
        </section>
        <div class="elder-sos-col">${sosBandHtml()}${elderFamilyHtml(p)}</div>
      </div>

      ${elderServicesHtml(openEvents)}

      ${weatherPending ? "" : renderWeatherElderBanner()}

      ${notice ? `<section class="broadcast-banner" role="note"><span class="broadcast-icon">${icon("megaphone")}</span><div><strong>${escapeHtml(notice.title)} · ${escapeHtml(notice.from || "主管部门")}</strong><p>${escapeHtml(notice.text)}</p></div><div class="broadcast-side"><small>${escapeHtml(notice.time || "")}</small>${LOCAL_BACKEND_ENABLED ? `<button class="btn btn-amber" type="button" data-action="ai-video">${icon("mic")}有人这样找我？问小桂</button>` : ""}</div></section>` : ""}

      ${trip ? `<section class="elder-trip"><span class="elder-trip-icon">${icon("map-pin")}</span><div><strong>您现在在外面：${escapeHtml(trip.destination)}</strong><p>${trip.routeAssessment ? routeRiskMarkup(trip.routeAssessment) : "记得按时回来，有事按呼救或问小桂。"}</p></div><span class="elder-trip-time">预计 ${escapeHtml(trip.expectedReturn || "--")} 回</span></section>` : ""}

      <div class="elder-grid">
        <section class="panel">
          <header class="panel-header"><h3>今天的安排</h3><button class="text-btn" type="button" data-page="profile">我的档案${icon("arrow-right")}</button></header>
          <ol class="elder-schedule">
            ${schedule.map((item) => `<li class="${item.done ? "done" : ""}"><time>${item.time}</time><div><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.place)}<span class="who">${escapeHtml(item.who)}</span></small></div>${item.done ? `<span class="elder-done">${icon("check")}已完成</span>` : ""}</li>`).join("")}
          </ol>
        </section>

        <section class="panel">
          <header class="panel-header"><h3>我的身体状态</h3>${screening ? screeningStatusTag(screening) : ""}</header>
          <div class="panel-body elder-state">
            <div class="elder-state-head"><strong class="tone-${escapeHtml(overall)}">${riskLabel(overall)}</strong><span>${screening ? `${escapeHtml(screening.updatedAt || "")}更新 · 五项里 ${(screening.dimensions || []).filter((d) => d.level === "medium" || d.level === "high").length} 项需要留意` : "今天还没做快筛"}</span></div>
            ${screening ? `<ul class="elder-dims">${(screening.dimensions || []).map((d) => `<li class="lv-${escapeHtml(d.level)}"><span>${escapeHtml(d.label)}</span><b>${escapeHtml(d.value)}</b></li>`).join("")}</ul>` : ""}
            <button class="btn btn-primary btn-block" type="button" data-page="check">${icon("clipboard-check")}去做今日打卡</button>
          </div>
        </section>

        <section class="panel">
          <header class="panel-header"><h3>要办的事</h3><button class="text-btn" type="button" data-page="requests">全部 ${elderEvents.length} 件${icon("arrow-right")}</button></header>
          <div class="panel-body">
            ${activeEvent ? `
              <div class="elder-todo">
                <span class="status-tag warning">${escapeHtml(activeEvent.status)}</span>
                <strong>${escapeHtml(activeEvent.title)}</strong>
                <p>${escapeHtml(activeEvent.action)}</p>
                <div class="elder-todo-actions"><button class="btn btn-primary" type="button" data-action="event-detail" data-id="${activeEvent.id}">查看进度</button>${eventCallButton(activeEvent)}</div>
              </div>
              ${openEvents.length > 1 ? `<p class="elder-more">还有 ${openEvents.length - 1} 件在办理中</p>` : ""}
            ` : `<div class="empty-state compact">${icon("badge-check")}<strong>没有要办的事</strong><p>今天一切正常。</p></div>`}
          </div>
        </section>
      </div>

      <nav class="elder-links" aria-label="其他">
        <button type="button" data-page="profile">${icon("contact-round")}我的档案</button>
        <button class="speech-setting" type="button" data-action="speech-toggle" aria-pressed="${autoSpeakEnabled()}" hidden>${speechToggleLabel()}</button>
      </nav>
    `;
  }

  function renderElderProfile() {
    const p = state.data.profile;
    return `
      <div class="page-toolbar">
        <div class="page-toolbar-title"><h2>我的档案</h2><p>换机构不用重填，给谁看都由您决定，随时可以收回</p></div>
        <div class="toolbar-actions"><button class="btn btn-secondary" type="button" data-action="edit-profile">${icon("pencil")}更新资料</button></div>
      </div>
      <div class="panel-grid">
        <section class="panel">
          <header class="panel-header"><div class="section-head-copy"><h3>基本信息</h3><p>${escapeHtml(p.id)}</p></div>${riskTag(p.risk)}</header>
          <div class="panel-body">
            <div class="profile-grid">
              <div class="data-field"><span>姓名</span><strong>${escapeHtml(p.name)}</strong></div>
              <div class="data-field"><span>性别 / 年龄</span><strong>${escapeHtml(p.gender)} / ${p.age}岁</strong></div>
              <div class="data-field"><span>来源地</span><strong>${escapeHtml(p.source)}</strong></div>
              <div class="data-field"><span>身份证号</span><strong>${escapeHtml(p.idCard)}</strong></div>
              <div class="data-field"><span>本人电话</span><strong>${escapeHtml(p.phone)}</strong></div>
              <div class="data-field"><span>紧急联系人</span><strong>${escapeHtml(p.emergencyName)} · ${escapeHtml(p.emergencyPhone)}</strong></div>
            </div>
          </div>
        </section>
        <section class="panel">
          <header class="panel-header"><div class="section-head-copy"><h3>档案质量</h3><p>最近核验：今日 07:42</p></div><strong>${p.completeness}%</strong></header>
          <div class="panel-body">
            <div class="progress-track"><div class="progress-bar" style="width:${p.completeness}%"></div></div>
            <div class="list-stack mt-3">
              <div class="list-item"><span class="list-icon success">${icon("badge-check")}</span><div class="list-content"><strong>身份与联系方式</strong><p>来源：本人实名认证 · 今日核验</p></div></div>
              <div class="list-item"><span class="list-icon success">${icon("building-2")}</span><div class="list-content"><strong>入住与服务信息</strong><p>来源：北海银龄康养中心 · 2小时前</p></div></div>
              <div class="list-item"><span class="list-icon warning">${icon("user-round-check")}</span><div class="list-content"><strong>跨区域共享授权</strong><p>尚未开启，更换机构时需重新确认</p></div></div>
            </div>
          </div>
        </section>
      </div>
      <div class="panel-grid equal mt-4">
        <section class="panel">
          <header class="panel-header"><div class="section-head-copy"><h3>当前旅居计划</h3></div></header>
          <div class="panel-body"><div class="profile-grid">
            <div class="data-field"><span>所在城市</span><strong>${escapeHtml(p.stayCity)}</strong></div>
            <div class="data-field"><span>入住机构</span><strong>${escapeHtml(p.institution)}</strong></div>
            <div class="data-field"><span>房间</span><strong>${escapeHtml(p.room)}</strong></div>
            <div class="data-field"><span>计划时间</span><strong>${escapeHtml(p.stayRange)}</strong></div>
          </div></div>
        </section>
        <section class="panel">
          <header class="panel-header"><div class="section-head-copy"><h3>最低必要照护摘要</h3><p>仅在照护与紧急救助场景使用</p></div></header>
          <div class="panel-body"><div class="profile-grid">
            <div class="data-field"><span>慢性病</span><strong>${p.conditions.map(escapeHtml).join("、")}</strong></div>
            <div class="data-field"><span>过敏信息</span><strong>${escapeHtml(p.allergy)}</strong></div>
            <div class="data-field"><span>活动能力</span><strong>可独立行走，长距离需休息</strong></div>
            <div class="data-field"><span>用药提示</span><strong>每日早间降压药</strong></div>
          </div></div>
        </section>
      </div>
      <section class="panel mt-4">
        <header class="panel-header"><div class="section-head-copy"><h3>数据授权</h3><p>按用途和字段控制信息使用范围</p></div></header>
        <div class="panel-body">
          ${consentRow("basic", "基础身份核验", "用于入住登记与本人身份确认", p.consents.basic)}
          ${consentRow("institution", "机构服务记录", "用于服务执行、质量追踪和离住交接", p.consents.institution)}
          ${consentRow("health", "健康风险筛查", "用于生成非诊断性风险提示", p.consents.health)}
          ${consentRow("crossRegion", "跨区域档案复用", "更换旅居机构时携带必要信息", p.consents.crossRegion)}
        </div>
      </section>
    `;
  }

  function consentRow(key, title, detail, checked) {
    return `<div class="consent-row"><div class="consent-copy"><strong>${title}</strong><small>${detail}</small></div><label class="toggle"><input type="checkbox" data-consent="${key}" ${checked ? "checked" : ""} aria-label="${title}"><span></span></label></div>`;
  }

  const DAILY_CHECK_FIELDS = [
    ["sleep", "昨晚睡得怎么样", ["良好", "一般", "较差"]],
    ["appetite", "今天胃口怎么样", ["良好", "一般", "较差"]],
    ["mood", "现在心情怎么样", ["愉快", "平稳", "低落"]],
    ["mobility", "走路、活动怎么样", ["正常", "轻度不适", "行动困难"]]
  ];
  const DAILY_CHECK_ABNORMAL = { sleep: ["一般", "较差"], appetite: ["一般", "较差"], mood: ["低落"], mobility: ["轻度不适", "行动困难"] };

  function checkIsAbnormal(item) {
    return Boolean(item) && Object.keys(DAILY_CHECK_ABNORMAL).some((key) => DAILY_CHECK_ABNORMAL[key].includes(item[key]));
  }

  function checkDayMs(value) {
    const day = Date.parse(`${value}T00:00:00`);
    return Number.isFinite(day) ? day : null;
  }

  function friendlyCheckDate(value) {
    const day = checkDayMs(value);
    if (day == null) return String(value || "");
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const diff = Math.round((today.getTime() - day) / 86400000);
    return diff === 0 ? "今天" : diff === 1 ? "昨天" : new Date(day).toLocaleDateString("zh-CN", { month: "long", day: "numeric" });
  }

  // 近 7 天打卡按真实日期统计（同一天多次只算一天），不写死天数
  function dailyCheckStats(checks = state.data.dailyChecks || []) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const since = today.getTime() - 6 * 86400000;
    const recent = checks.filter((item) => { const day = checkDayMs(item.date); return day != null && day >= since && day <= today.getTime(); });
    const days = new Set(recent.map((item) => item.date)).size;
    const latest = checks.find((item) => checkDayMs(item.date) != null);
    const gapDays = latest ? Math.round((today.getTime() - checkDayMs(latest.date)) / 86400000) : null;
    const tone = !recent.length ? "neutral" : checkIsAbnormal(recent[0]) ? "warning" : "success";
    const label = !recent.length ? "近7天没有打卡" : checkIsAbnormal(recent[0]) ? "最近一次有需要留意的地方" : "最近一次状态平稳";
    return { days, recent, latest, gapDays, tone, label };
  }

  function choiceField(name, label, options, selected = "") {
    return `<fieldset class="choice-group full"><legend>${escapeHtml(label)}</legend><div class="choice-options">${options.map((option) => `<label class="choice"><input type="radio" name="${name}" value="${escapeHtml(option)}" required${selected === option ? " checked" : ""}><span>${escapeHtml(option)}</span></label>`).join("")}</div></fieldset>`;
  }

  function renderElderCheck() {
    const checks = state.data.dailyChecks || [];
    const screening = state.data.profile.screening;
    const today = new Date().toLocaleDateString("sv-SE");
    // 今天已经明确选过的四项可以带出来改；没选过的一律不预选，避免不点也提交出一份“正常”
    const todayCheck = checks.find((item) => item.date === today && DAILY_CHECK_FIELDS.every(([key, , options]) => options.includes(item[key])));
    const stats = dailyCheckStats(checks);
    return `
      <div class="page-toolbar">
        <div class="page-toolbar-title"><h2>今日状态打卡</h2><p>4 个问题，约 30 秒；有不舒服的地方，护理员会来看您</p></div>
      </div>
      <div class="panel-grid">
        <section class="panel">
          <header class="panel-header"><div class="section-head-copy"><h3>${new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" })}</h3><p>${todayCheck ? "今天已经打过卡了，想改可以重新选择再提交" : "每个问题点一下最接近的情况"}</p></div>${todayCheck ? `<span class="status-tag success">今天已打卡</span>` : `<span class="status-tag warning">今天还没打卡</span>`}</header>
          <div class="panel-body">
            <form id="daily-check-form" class="form-grid daily-check-form">
              ${DAILY_CHECK_FIELDS.map(([name, label, options]) => choiceField(name, label, options, todayCheck ? todayCheck[name] : "")).join("")}
              <label class="full"><span>想补充的话（选填）</span><textarea class="form-control" name="note" maxlength="120" placeholder="例如：膝盖有些酸，但可以正常走路">${escapeHtml(todayCheck?.note || "")}</textarea></label>
              <div class="full"><button class="btn btn-primary btn-lg" type="submit">${icon("send")}提交今日状态</button></div>
            </form>
          </div>
        </section>
        <section class="panel">
          <header class="panel-header"><div class="section-head-copy"><h3>近 7 天打卡</h3><p>${stats.days ? `近7天打卡 ${stats.days} 天` : stats.latest ? `最近一次是${escapeHtml(friendlyCheckDate(stats.latest.date))}` : "还没有打卡记录"}</p></div><span class="status-tag ${stats.tone}">${escapeHtml(stats.label)}</span></header>
          <div class="panel-body">
            <div class="stat-value mt-0"><strong>${stats.days}</strong><small>天 / 近7天</small></div>
            <div class="progress-track mt-3"><div class="progress-bar" style="width:${Math.round(stats.days / 7 * 100)}%"></div></div>
            ${stats.gapDays != null && stats.gapDays > 1 ? `<p class="meta-text mt-2">已经 ${stats.gapDays} 天没有打卡了，今天记一下吧。</p>` : ""}
            <div class="notice mt-4">${icon("info")}若出现胸痛、呼吸困难、意识异常等紧急情况，请直接拨打120，不要等待系统分析。</div>
          </div>
        </section>
      </div>
      <section class="panel mt-4">
        <header class="panel-header"><h3>最近记录</h3></header>
        <div class="table-wrap"><table class="data-table"><thead><tr><th>日期</th><th>睡眠</th><th>食欲</th><th>心情</th><th>活动</th><th>状态</th></tr></thead><tbody>
          ${checks.slice(0, 7).map((item) => `<tr><td class="nowrap">${escapeHtml(friendlyCheckDate(item.date))}</td><td>${escapeHtml(item.sleep)}</td><td>${escapeHtml(item.appetite)}</td><td>${escapeHtml(item.mood)}</td><td>${escapeHtml(item.mobility)}</td><td>${statusTag(item.status)}</td></tr>`).join("") || `<tr><td colspan="6"><div class="empty-state compact">${icon("calendar-x")}<strong>还没有打卡记录</strong></div></td></tr>`}
        </tbody></table></div>
      </section>
      <section class="panel mt-4 more-checks">
        <header class="panel-header"><div class="section-head-copy"><h3>更多检查</h3><p>不是每天都要做，可以请护理员陪着一起做</p></div></header>
        <div class="panel-body more-check-grid">
          <article class="more-check"><div><strong>${icon("clipboard-check")}五维身心快筛</strong><p>活动、沟通、视听、情绪、日常生活五项，比每日打卡更完整；结果由工作人员复核，不是医学诊断。</p></div><button class="btn btn-secondary" type="button" data-action="screening-check">开始五维快筛</button></article>
          <article class="more-check demo"><div><strong>${icon("scan-face")}摄像头模拟流程</strong><p>演示后续接入设备后的流程；显示的是固定样本，不是生理测量，不作为健康判断依据。</p></div><button class="btn btn-ghost" type="button" data-action="health-scan">查看模拟流程</button></article>
        </div>
        ${screening ? `<div class="panel-body more-check-result">${screeningSummary(screening, true)}</div>` : ""}
      </section>
    `;
  }

  function openScreeningCheck() {
    const screening = state.data.profile.screening || {};
    const values = Object.fromEntries((screening.dimensions || []).map((item) => [item.label, item.value]));
    openModal({
      title: "完成今日身心快筛",
      subtitle: "只记录可观察变化，不作医学诊断；缺项会拒绝自动判级并转人工。",
      wide: true,
      body: `<form id="screening-form" class="screening-form">
        <div class="screening-source-row"><span class="source-badge">${icon("user-round-check")}本人自填</span><span class="source-badge muted">${icon("video")}AI视频 / 语音</span><span class="source-badge muted">${icon("hand-helping")}护理员代录</span><span class="source-badge muted">${icon("history")}历史结果导入</span></div>
        <div class="screening-form-grid">
          <label><span>肢体活动</span><select class="form-control" name="activity"><option>正常</option><option ${values["肢体活动"] === "轻度不适" ? "selected" : ""}>轻度不适</option><option>头晕步态不稳</option><option>跌倒高风险</option></select><small>如起身、步态、跌倒、头晕</small></label>
          <label><span>言语沟通</span><select class="form-control" name="communication"><option>正常</option><option>可沟通但需重复</option><option>表达困难</option></select><small>记录表达与理解是否顺畅</small></label>
          <label><span>视听能力</span><select class="form-control" name="sensory"><option>正常</option><option>听力下降</option><option>视力下降</option><option>本轮未采集</option></select><small>缺项不会被系统强行判级</small></label>
          <label><span>心理与情绪</span><select class="form-control" name="emotion"><option>愉快</option><option>平稳</option><option>担忧</option><option>低落</option><option>本轮未采集</option></select><small>近24小时情绪与主动交流变化</small></label>
          <label><span>日常生活</span><select class="form-control" name="daily"><option>正常</option><option>睡眠一般</option><option>夜间睡眠差</option><option>食欲一般</option><option>食欲下降</option><option>本轮未采集</option></select><small>睡眠、食欲、进食与生活自理</small></label>
          <label class="full"><span>补充证据（选填）</span><textarea class="form-control" name="evidence" placeholder="例如：昨晚醒来两次，今天早餐吃了一半"></textarea></label>
        </div>
        <div class="notice">${icon("shield-check")}最终等级由确定性规则生成；高风险、缺项和冲突数据必须由工作人员确认。</div>
      </form>`,
      footer: `<button class="btn btn-secondary" type="button" data-action="close-modal">取消</button><button class="btn btn-primary" type="submit" form="screening-form">${icon("check")}生成快筛结果</button>`,
      onOpen: () => document.getElementById("screening-form").addEventListener("submit", submitScreening)
    });
  }

  function submitScreening(event) {
    event.preventDefault();
    const form = new FormData(event.target);
    const values = { activity: String(form.get("activity")), communication: String(form.get("communication")), sensory: String(form.get("sensory")), emotion: String(form.get("emotion")), daily: String(form.get("daily")) };
    const missing = Object.entries(values).filter(([, value]) => value === "本轮未采集").map(([key]) => ({ activity: "肢体活动", communication: "言语沟通", sensory: "视听能力", emotion: "心理与情绪", daily: "日常生活" }[key]));
    const highWords = /头晕|步态不稳|跌倒|表达困难|夜间睡眠差|食欲下降|低落/;
    const mediumWords = /轻度不适|需重复|听力下降|视力下降|担忧|睡眠一般|食欲一般/;
    const levels = Object.values(values).map((value) => value === "本轮未采集" ? "unknown" : highWords.test(value) ? "high" : mediumWords.test(value) ? "medium" : "low");
    const overall = levels.includes("high") ? "high" : levels.includes("medium") || missing.length ? "medium" : "low";
    const dataCompleteness = (5 - missing.length) / 5;
    const labels = { activity: "肢体活动", communication: "言语沟通", sensory: "视听能力", emotion: "心理与情绪", daily: "日常生活" };
    const dimensions = Object.entries(values).map(([key, value]) => ({ label: labels[key], value, level: value === "本轮未采集" ? "unknown" : highWords.test(value) ? "high" : mediumWords.test(value) ? "medium" : "low", evidence: String(form.get("evidence") || "本人自填") }));
    state.data.profile.screening = { overall, dataCompleteness, source: "本人自填", updatedAt: "刚刚", reviewRequired: missing.length > 0 || overall !== "low", reviewStatus: missing.length ? "缺项待补" : overall === "low" ? "已确认" : "待人工复核", missing, dimensions, carePlan: overall === "high" ? "立即通知机构护理员现场确认；如出现胸痛、呼吸困难或意识异常请拨打120。" : overall === "medium" ? "安排24小时内护理回访，补齐缺项并观察睡眠、食欲和活动变化。" : "保持每日一次快筛，按原旅居计划活动。" };
    state.data.profile.lastCheck = "刚刚";
    if (riskRank(overall) >= riskRank(state.data.profile.risk)) state.data.profile.risk = overall;
    const residentRecord = state.data.residents.find((item) => item.id === state.data.profile.id);
    if (residentRecord) {
      residentRecord.screening = state.data.profile.screening;
      if (riskRank(overall) > riskRank(residentRecord.risk)) residentRecord.risk = overall;
      residentRecord.fresh = "刚刚";
    }
    state.data.dailyChecks.unshift({ date: new Date().toLocaleDateString("sv-SE"), sleep: values.daily.includes("睡眠") ? values.daily : "已纳入快筛", appetite: values.daily.includes("食欲") ? values.daily : "已纳入快筛", mood: values.emotion, mobility: values.activity, status: missing.length ? "待补项" : "已完成" });
    saveData("提交老人身心快筛", "resident_screening", state.data.profile.id);
    closeModal();
    showToast(missing.length ? "快筛已保存，等待补齐缺项" : "五维快筛已完成", `${riskLabel(overall)} · 数据完整度 ${Math.round(dataCompleteness * 100)}%${overall !== "low" ? "，已进入人工复核队列" : ""}`, overall === "high" ? "danger" : overall === "medium" ? "warning" : "success");
    renderPage();
  }

  // 老人看的状态用大白话：先说办到哪一步
  function elderStatusWord(event) {
    return { "待复核": "已收到，等工作人员核实", "处置中": "正在处理", "已转派": `已转给${event.owner || "相关部门"}处理`, "已办结": "已办结" }[event.status] || event.status;
  }

  function elderRequestCard(event) {
    const timeline = Array.isArray(event.timeline) ? event.timeline : [];
    const latest = timeline[timeline.length - 1];
    const done = event.status === "已办结";
    return `<li class="request-card${done ? " done" : ""}">
      <div class="request-head"><span class="status-tag ${statusClass(event.status)}">${escapeHtml(elderStatusWord(event))}</span><small>${escapeHtml(eventTimeText(event))}</small></div>
      <strong>${escapeHtml(event.title)}</strong>
      ${latest ? `<p class="request-latest">${icon("message-square-text")}<span>最新进展：${escapeHtml(String(latest.text || "").replace(/^老人/, "您"))}${latest.time ? `<small>${escapeHtml(latest.time)}</small>` : ""}</span></p>` : ""}
      <p class="request-owner">${escapeHtml(event.owner || "工作人员")}负责${!done ? ` · ${escapeHtml(elderSlaText(event))}` : ""}</p>
      <div class="request-actions"><button class="btn btn-secondary" type="button" data-action="event-detail" data-id="${escapeHtml(event.id)}">查看详情</button>${done ? "" : eventCallButton(event, "打电话问问")}</div>
    </li>`;
  }

  function renderElderRequests() {
    const events = state.data.events.filter((event) => event.residentId === state.data.profile.id);
    const open = events.filter((event) => event.status !== "已办结");
    const done = events.filter((event) => event.status === "已办结");
    return `
      <div class="page-toolbar">
        <div class="page-toolbar-title"><h2>我的求助</h2><p>${open.length ? `${open.length} 件正在办理` : "没有正在办理的事"}${done.length ? `，${done.length} 件已办结` : ""}</p></div>
        <div class="toolbar-actions"><button class="btn btn-danger" type="button" data-action="emergency-report">${icon("siren")}发起求助</button></div>
      </div>
      ${(() => {
        const mySessions = getSosSessions().filter((session) => session.residentId === state.data.profile.id);
        if (!mySessions.length) return "";
        return `
      <section class="panel">
        <div class="panel-header"><div class="section-head-copy"><h3>我的呼救记录</h3></div></div>
        <div class="panel-body"><div class="sos-recent">${mySessions.map((session) => `<button class="sos-recent-row" type="button" data-action="${SOS_ACTIVE_STATUSES.has(session.status) ? "sos-status" : "sos-detail"}" data-id="${session.id}"><strong>${escapeHtml(session.id)}</strong><span>${escapeHtml(session.trigger)} · ${escapeHtml(session.createdLabel)}</span>${sosStatusTag(session)}<span class="sos-recent-metric">${typeof session.responseSeconds === "number" ? `接单${session.responseSeconds}秒` : "—"}</span>${icon("arrow-right")}</button>`).join("")}</div></div>
      </section>`;
      })()}
      <section class="panel">
        <header class="panel-header"><h3>正在办理</h3></header>
        <div class="panel-body">${open.length ? `<ol class="request-list">${open.map(elderRequestCard).join("")}</ol>` : `<div class="empty-state compact">${icon("badge-check")}<strong>没有正在办理的事</strong><p>有事可以直接和小桂说，或点右上角“发起求助”。</p></div>`}</div>
      </section>
      ${done.length ? `<section class="panel"><header class="panel-header"><h3>已办结</h3></header><div class="panel-body"><ol class="request-list">${done.map(elderRequestCard).join("")}</ol></div></section>` : ""}
    `;
  }

  function providerTodoItems() {
    const data = state.data;
    const movements = getMovementLogs();
    const overdue = movements.filter((log) => log.status === "超时未归");
    const drafts = movements.filter((log) => log.institutionStatus === "待核验");
    const review = data.residents.filter((resident) => resident.screening?.reviewRequired);
    const stale = data.residents.filter((resident) => /昨天|天前/.test(resident.fresh || ""));
    const offline = (data.devices || []).filter((device) => device.status === "离线");
    const highEvents = data.events.filter((event) => event.status !== "已办结" && event.level === "high");
    const today = new Date().toLocaleDateString("sv-SE");
    const checkAlerts = (data.notifications || []).filter((item) => item.audience === "provider" && String(item.id).startsWith("DC-") && String(item.id).endsWith(today));
    return [
      careTodoItem(),
      checkAlerts.length ? { tone: "warning", page: "care", title: `${checkAlerts.length} 位老人今天打卡异常，需当面查看`, detail: checkAlerts.map((item) => `${item.title.replace(/^关怀提醒：/, "")}：${item.detail}`).join("；"), cta: "去查看" } : null,
      overdue.length ? { tone: "danger", page: "services", title: `${overdue.length} 位老人外出超时未归`, detail: overdue.map((log) => `${log.resident} · ${log.destination}（应于 ${log.expectedReturn} 返回）`).join("；"), cta: "去核实" } : null,
      overdueEvents().length ? { tone: "danger", page: "alerts", title: `${overdueEvents().length} 件事件已超过处置时限`, detail: overdueEvents().slice(0, 3).map((event) => `${event.resident} · ${event.title}（${eventSla(event).text}）`).join("；"), cta: "去处置" } : null,
      highEvents.length ? { tone: "danger", page: "alerts", title: `${highEvents.length} 件高风险事件待处置`, detail: highEvents.slice(0, 3).map((event) => `${event.resident} · ${event.title}`).join("；"), cta: "去处置" } : null,
      drafts.length ? { tone: "warning", page: "services", title: `${drafts.length} 条外出报备待核验`, detail: drafts.map((log) => `${log.resident} · ${log.destination}`).join("；"), cta: "去核验" } : null,
      offline.length ? { tone: "warning", page: "devices", title: `${offline.length} 台安全设备离线`, detail: offline.map((device) => `${device.resident}的${device.type}（${device.lastSeen}起）`).join("；"), cta: "去排查" } : null,
      review.length ? { tone: "neutral", page: "residents", title: `${review.length} 份快筛等待人工复核`, detail: `${review.slice(0, 4).map((resident) => resident.name).join("、")}${stale.length ? `；${stale.length} 位老人档案超过一天未更新` : ""}`, cta: "去复核" } : null,
    ];
  }

  // 服务老人按居住方式分列：机构入住、居家、社区，各页面同一口径
  function sceneBreakdown(residents) {
    const count = (scene) => residents.filter((resident) => (resident.scene || "机构入住") === scene).length;
    return `机构入住 ${count("机构入住")} · 居家 ${count("居家旅居")} · 社区 ${count("社区嵌入")}`;
  }

  function renderProviderDashboard() {
    const data = state.data;
    const residents = data.residents;
    const alerts = data.events.filter((event) => ["处置中", "待复核", "已转派"].includes(event.status));
    const high = alerts.filter((event) => event.level === "high").length;
    const movements = getMovementLogs();
    const outsideIds = activeMovementResidentIds(movements);
    const overdue = movements.filter((log) => log.status === "超时未归").length;
    const todayServices = data.serviceLogs.filter((log) => String(log.time || "").startsWith("今日")).length;
    const duty = currentDutyStaff();
    const sosLive = getSosSessions().some((session) => SOS_ACTIVE_STATUSES.has(session.status));
    const today = new Date().toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "short" });
    return `
      <div class="page-toolbar">
        <div class="page-toolbar-title"><h2>${escapeHtml(data.accounts?.provider?.org || "机构工作台")}</h2><p>${escapeHtml(today)} · 当班 ${escapeHtml(duty.name)}（${escapeHtml(duty.shift)}）</p></div>
        <div class="toolbar-actions"><button class="btn btn-ghost" type="button" data-action="register-resident">${icon("user-plus")}办理入住</button><button class="btn btn-secondary" type="button" data-action="record-service">${icon("plus")}记录服务</button><button class="btn btn-primary" type="button" data-action="movement-report">${icon("route")}外出报备</button></div>
      </div>
      <div class="stat-grid">
        ${statCard("本机构服务老人", residents.length, "人", "users-round", sceneBreakdown(residents))}
        ${statCard("当前在外", outsideIds.size, "人", "map-pinned", overdue ? `${overdue} 人超时未归` : "都在约定时间内", overdue ? "danger" : "")}
        ${statCard("待处置事件", alerts.length, "件", "siren", high ? `${high} 件高风险` : "暂无高风险", high ? "danger" : "")}
        ${statCard("今日服务", todayServices, "项", "clipboard-check", `共 ${data.serviceLogs.length} 条服务记录`)}
      </div>
      ${renderWeatherTasks("provider", true)}
      ${sosLive ? renderSosQueuePanel("provider", { always: true }) : ""}
      ${todoPanel(providerTodoItems())}
      ${sosLive ? "" : `<div class="mt-4">${renderSosQueuePanel("provider", { always: true })}</div>`}
      <section class="panel mt-4">
        <header class="panel-header"><h3>优先处置<span class="muted-inline">${alerts.length}</span></h3><button class="text-btn" type="button" data-page="alerts">预警处置${icon("arrow-right")}</button></header>
        <div class="table-wrap"><table class="data-table"><thead><tr><th>老人</th><th>事件</th><th>风险</th><th>状态</th><th>时限</th><th></th></tr></thead><tbody>
          ${alerts.sort(eventPriority).slice(0, 5).map((event) => `<tr><td>${residentCell({ name: event.resident, id: event.residentId })}</td><td><div class="cell-copy"><strong>${escapeHtml(event.title)}</strong><small>${escapeHtml(eventTimeText(event))} · ${escapeHtml(event.source)}</small></div></td><td>${riskTag(event.level)}</td><td>${statusTag(event.status)}</td><td class="nowrap">${slaTag(event)}</td><td><button class="text-btn" type="button" data-action="handle-event" data-id="${event.id}">处理${icon("arrow-right")}</button></td></tr>`).join("") || `<tr><td colspan="6"><div class="empty-state compact">${icon("badge-check")}<strong>没有待处置事件</strong></div></td></tr>`}
        </tbody></table></div>
      </section>
      <section class="panel mt-4">
        <header class="panel-header"><h3>最近服务记录</h3><button class="text-btn" type="button" data-page="services">动态台账${icon("arrow-right")}</button></header>
        <div class="table-wrap"><table class="data-table"><thead><tr><th>老人</th><th>服务</th><th>执行人</th><th>时间</th><th>结果</th><th>状态</th></tr></thead><tbody>
          ${data.serviceLogs.slice(0, 5).map((log) => `<tr><td>${residentCell({ name: log.resident, id: log.residentId })}</td><td><span class="type-tag">${escapeHtml(log.type)}</span></td><td class="nowrap">${escapeHtml(log.staff)}</td><td class="nowrap">${escapeHtml(log.time)}</td><td>${escapeHtml(log.result)}</td><td>${statusTag(log.status)}</td></tr>`).join("")}
        </tbody></table></div>
      </section>
    `;
  }

  function serviceBar(label, value, tone) {
    return `<div class="bar-row"><span>${label}</span><span class="bar-track"><span class="bar-fill ${tone}" style="width:${value}%"></span></span><strong>${value}%</strong></div>`;
  }

  function renderProviderResidents() {
    const query = state.residentQuery.trim().toLowerCase();
    const residents = state.data.residents.filter((resident) => {
      const matchesQuery = !query || [resident.name, resident.id, resident.room, resident.source].join(" ").toLowerCase().includes(query);
      const matchesRisk = state.residentRisk === "all" || resident.risk === state.residentRisk;
      return matchesQuery && matchesRisk;
    });
    return `
      <div class="page-toolbar">
        <div class="page-toolbar-title"><h2>本机构服务老人动态档案</h2><p>${escapeHtml(sceneBreakdown(state.data.residents))} · 每条档案展示最后更新时间和当前风险等级</p></div>
        <div class="toolbar-actions"><button class="btn btn-primary" type="button" data-action="register-resident">${icon("user-plus")}办理入住</button></div>
      </div>
      <section class="panel">
        <div class="panel-header"><div class="section-head-copy"><h3>全部服务老人 <span class="muted-inline">${residents.length}人</span></h3></div><div class="filter-row"><label class="global-search search-md"><i data-lucide="search" aria-hidden="true"></i><input id="resident-query" type="search" value="${escapeHtml(state.residentQuery)}" placeholder="搜索老人档案" aria-label="搜索老人档案"></label><select id="resident-risk" class="form-control filter-control" aria-label="风险筛选"><option value="all" ${state.residentRisk === "all" ? "selected" : ""}>全部风险</option><option value="high" ${state.residentRisk === "high" ? "selected" : ""}>高风险</option><option value="medium" ${state.residentRisk === "medium" ? "selected" : ""}>需关注</option><option value="low" ${state.residentRisk === "low" ? "selected" : ""}>低风险</option></select></div></div>
        <div class="table-wrap"><table class="data-table"><thead><tr><th>老人</th><th>年龄 / 来源</th><th>房间</th><th>入住时间</th><th>综合风险</th><th>五维快筛</th><th>数据新鲜度</th><th>操作</th></tr></thead><tbody>
          ${residents.length ? residents.map((resident) => `<tr><td>${residentCell(resident)}</td><td>${resident.age}岁 · ${escapeHtml(resident.source)}</td><td>${escapeHtml(resident.room)}<br>${sceneTag(resident.scene)}</td><td>${escapeHtml(resident.checkIn)}</td><td>${riskTag(resident.screening ? resident.screening.overall : resident.risk)}</td><td>${resident.screening ? screeningStatusTag(resident.screening) : statusTag("未评估")}</td><td>${escapeHtml(resident.fresh)}</td><td><button class="text-btn" type="button" data-action="screening-review" data-id="${resident.id}">复核快筛${icon("arrow-right")}</button></td></tr>`).join("") : `<tr><td colspan="8"><div class="empty-state">${icon("search-x")}<strong>没有匹配的老人</strong><p>请调整搜索词或风险筛选条件。</p></div></td></tr>`}
        </tbody></table></div>
      </section>
    `;
  }

  function renderProviderServices() {
    const movements = getMovementLogs();
    const outsideIds = activeMovementResidentIds(movements);
    const overdue = movements.filter((log) => log.status === "超时未归");
    const pending = movements.filter((log) => log.regulatorStatus === "待确认");
    const inInstitution = Math.max(0, state.data.residents.length - outsideIds.size);
    return `
      <div class="page-toolbar">
        <div class="page-toolbar-title"><h2>旅居老人动态台账</h2><p>从机构内服务延伸至外出去向、责任人、返回核验和监管确认</p></div>
        <div class="toolbar-actions"><button class="btn btn-secondary" type="button" data-action="record-service">${icon("clipboard-plus")}记录服务</button><button class="btn btn-primary" type="button" data-action="movement-report">${icon("route")}外出报备</button></div>
      </div>
      <div class="stat-grid movement-stat-grid">
        ${statCard("当前在机构", inInstitution, "人", "building-2", "按最新动向自动更新", "positive")}
        ${statCard("当前在外", outsideIds.size, "人", "map-pinned", "均已绑定责任人", outsideIds.size ? "warning" : "positive")}
        ${statCard("超时未归", overdue.length, "人", "triangle-alert", overdue.length ? "需立即跟进" : "暂无异常", overdue.length ? "danger" : "positive")}
        ${statCard("待监管确认", pending.length, "条", "badge-check", "机构报备后同步推送", pending.length ? "warning" : "positive")}
      </div>
      <section class="panel movement-panel">
        <div class="panel-header"><div class="section-head-copy"><h3>旅居动向记录</h3></div><span class="status-tag ${overdue.length ? "danger" : "success"}">${overdue.length ? `${overdue.length}条超时` : "动向正常"}</span></div>
        <div class="table-wrap"><table class="data-table movement-table"><thead><tr><th>老人 / 记录</th><th>当前动向</th><th>去向 / 事由</th><th>出发 / 预计返回</th><th>责任人 / 联络</th><th>双重确认</th><th>操作</th></tr></thead><tbody>
          ${movementRows(movements, "provider")}
        </tbody></table></div>
      </section>
      <section class="panel service-ledger-panel">
        <div class="panel-header"><div class="section-head-copy"><h3>机构服务记录</h3><p>已记录 ${state.data.serviceLogs.length} 项 · 与老人档案和动向记录共同构成过程台账</p></div><span class="status-tag success">数据已同步</span></div>
        <div class="table-wrap"><table class="data-table"><thead><tr><th>记录编号</th><th>老人</th><th>服务类型</th><th>执行人</th><th>时间</th><th>服务结果</th><th>状态</th></tr></thead><tbody>
          ${state.data.serviceLogs.map((log) => `<tr><td>${escapeHtml(log.id)}</td><td>${residentCell({ name: log.resident, id: log.residentId })}</td><td><span class="type-tag">${escapeHtml(log.type)}</span></td><td>${escapeHtml(log.staff)}</td><td>${escapeHtml(log.time)}</td><td>${escapeHtml(log.result)}</td><td>${statusTag(log.status)}</td></tr>`).join("")}
        </tbody></table></div>
      </section>
    `;
  }

  function renderProviderAlerts() {
    let alerts = state.data.events.filter((event) => event.status !== "已办结").sort(eventPriority);
    if (state.eventLevel !== "all") alerts = alerts.filter((event) => event.level === state.eventLevel);
    return `
      <div class="page-toolbar">
        <div class="page-toolbar-title"><h2>预警处置队列</h2><p>按责任人接收、处理并回填结果；时限按服务器记录的创建与截止时间计算，已超时的排在最前</p></div>
        <div class="toolbar-actions"><span class="status-tag danger">${alerts.filter((event) => event.level === "high").length}条高风险</span><button class="btn btn-secondary" type="button" data-action="refresh-data">${icon("refresh-cw")}刷新</button></div>
      </div>
      ${renderSosQueuePanel("provider", { always: true })}
      ${renderWeatherTasks("provider")}
      <section class="panel">
        <div class="panel-header"><div class="section-head-copy"><h3>待处置事件 <span class="muted-inline">${alerts.length}条</span></h3></div><div class="filter-row"><select id="provider-alert-level" class="form-control filter-control" aria-label="风险等级"><option value="all">全部等级</option><option value="high" ${state.eventLevel === "high" ? "selected" : ""}>高风险</option><option value="medium" ${state.eventLevel === "medium" ? "selected" : ""}>需关注</option><option value="low" ${state.eventLevel === "low" ? "selected" : ""}>低风险</option></select></div></div>
        <div class="table-wrap"><table class="data-table"><thead><tr><th>事件编号</th><th>事件</th><th>老人</th><th>风险</th><th>状态</th><th>责任单位 / 时限</th><th>操作</th></tr></thead><tbody>${eventRows(alerts, "provider")}</tbody></table></div>
      </section>
      
    `;
  }

  // “今天要处理的事”：把类案雷达、主动预警、呼救、报平安和台账动作汇成一张清单，按紧急程度排序
  function todoPanel(items, title = "今天要处理的事") {
    const order = { danger: 0, warning: 1, info: 2, neutral: 3 };
    const sorted = items.filter(Boolean).sort((a, b) => (order[a.tone] ?? 3) - (order[b.tone] ?? 3));
    return `<section class="panel todo-panel">
      <header class="panel-header"><h3>${escapeHtml(title)}<span class="muted-inline">${sorted.length}</span></h3></header>
      ${sorted.length ? `<ol class="todo-list">${sorted.map((item) => `<li class="todo-item tone-${escapeHtml(item.tone || "neutral")}">
        <span class="todo-mark" aria-hidden="true"></span>
        <div class="todo-copy"><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.detail || "")}</p></div>
        ${item.source ? `<span class="todo-source">${escapeHtml(item.source)}</span>` : ""}
        <button class="text-btn" type="button" ${item.action ? `data-action="${escapeHtml(item.action)}"${item.id ? ` data-id="${escapeHtml(item.id)}"` : ""}` : `data-page="${escapeHtml(item.page)}"`}>${escapeHtml(item.cta || "去处理")}${icon("arrow-right")}</button>
      </li>`).join("")}</ol>` : `<div class="empty-state compact">${icon("badge-check")}<strong>今天没有待处理的事</strong></div>`}
    </section>`;
  }

  function careTodoItem(page = "care") {
    const care = state.care;
    if (!care || !care.counts?.high) return null;
    const names = care.items.filter((item) => item.priority === "high").map((item) => item.name);
    return { tone: "danger", page, source: "AI 主动预警", title: `${care.counts.high} 位老人今天需要当面处理`, detail: `${names.slice(0, 4).join("、")}${care.counts.medium ? `；另有 ${care.counts.medium} 位需要留意` : ""}`, cta: "看原因" };
  }

  function radarTodoItem() {
    const radar = state.radar;
    if (!radar || !radar.clusters?.length) return null;
    const pending = radar.clusters.filter((cluster) => !radarHandled(cluster));
    if (!pending.length) return null;
    const top = pending[0];
    return { tone: pending.some((cluster) => cluster.risk === "high") ? "danger" : "warning", page: "radar", source: "类案雷达", title: `${pending.length} 类类案待处置，涉及 ${radar.residents} 位老人`, detail: `最突出：${top.report?.title || "类案"}（${top.residents.length} 位老人）`, cta: "打开雷达" };
  }

  function sosTodoItem(page) {
    const live = getSosSessions().filter((session) => SOS_ACTIVE_STATUSES.has(session.status));
    if (!live.length) return null;
    return { tone: "danger", page, source: "安心应答", title: `${live.length} 条呼救正在响应`, detail: live.slice(0, 3).map((session) => `${session.resident} · ${sosPhaseText(session)}`).join("；"), cta: "去调度" };
  }

  // 机构填报分与按台账核算的分数对照：差 10 分以上值得监管员核查
  function qualityGap(institution) {
    const row = (state.insight?.quality || []).find((item) => item.id === institution.id);
    if (!row || !row.sufficient || typeof row.score !== "number") return null;
    return { score: row.score, gap: Number(institution.score || 0) - row.score, deductions: row.deductions || [] };
  }

  function qualityTodoItem() {
    const gaps = (state.data.institutions || []).map((item) => ({ item, gap: qualityGap(item) })).filter((row) => row.gap && row.gap.gap >= 10);
    if (!gaps.length) return null;
    return { tone: "warning", page: "insight", title: `${gaps.length} 家机构填报分明显高于台账核算`, detail: gaps.map(({ item, gap }) => `${item.name} 填报 ${item.score} / 核算 ${gap.score.toFixed(1)}（${gap.deductions.slice(0, 2).map((d) => d.item).join("、") || "见扣分依据"}）`).join("；"), cta: "看扣分依据", source: "态势研判" };
  }

  function regulatorTodoItems() {
    const tones = { danger: "danger", warning: "warning", neutral: "neutral" };
    const ledger = todayRegulatorActions().map((item) => ({ tone: tones[item.tone] || "neutral", page: item.page, title: item.title, detail: item.detail, cta: item.side === "优先" ? "去督办" : "去处理" }));
    return [sosTodoItem("events"), careTodoItem(), radarTodoItem(), qualityTodoItem(), ...ledger];
  }

  function renderRegulatorDashboard() {
    if (LOCAL_BACKEND_ENABLED && !state.insight && !state.insightLoading && !state.insightError) loadInsight();
    const data = state.data;
    const active = data.events.filter((event) => event.status !== "已办结");
    const high = active.filter((event) => event.level === "high").length;
    const movementLogs = getMovementLogs();
    const outside = activeMovementResidentIds(movementLogs).size;
    const overdueMovement = movementLogs.filter((log) => log.status === "超时未归").length;
    const stats = sosStats();
    const weatherActive = (data.weatherAlerts || []).some((alert) => alert.status === "生效中");
    const today = new Date().toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "short" });
    return `
      <div class="page-toolbar">
        <div class="page-toolbar-title"><h2>监管总览</h2><p>${escapeHtml(today)} · ${data.institutions.length} 家机构 · ${data.residents.length} 位旅居老人</p></div>
        <div class="toolbar-actions">${state.backend.connected ? `<button class="btn btn-ghost" type="button" data-action="view-audit">${icon("history")}操作审计</button>` : ""}<button class="btn btn-ghost" type="button" data-action="export-report">${icon("download")}导出简报</button>${LOCAL_BACKEND_ENABLED && !weatherActive ? `<button class="btn btn-secondary" type="button" data-action="weather-publish">${icon("cloud-lightning")}发布天气预警</button>` : ""}<button class="btn btn-primary" type="button" data-page="advisor">${icon("bot")}问 AI 参谋</button></div>
      </div>
      <div class="stat-grid stat-grid-5">
        ${statCard("已建档旅居老人", data.residents.length, "人", "users-round", sceneBreakdown(data.residents))}
        ${statCard("未办结事件", active.length, "件", "siren", high ? `${high} 件高风险` : "暂无高风险", high ? "danger" : "")}
        ${statCard("当前在外", outside, "人", "map-pinned", overdueMovement ? `${overdueMovement} 人超时未归` : "都在约定时间内", overdueMovement ? "danger" : "")}
        ${statCard("呼救按时接单", stats.sla.assessed ? `${stats.sla.on_time}/${stats.sla.assessed}` : "—", stats.sla.assessed ? "单" : "", "timer", stats.sla.assessed ? `整体达标 ${stats.sla.overallRate}% · 超时未接单 ${stats.sla.missed} 单` : `接单时限 ${SOS_CONFIG.claimSlaSeconds} 秒，暂无已到考核时点的工单`, stats.sla.missed ? "danger" : stats.sla.late ? "warning" : "")}
        ${statCard("事件办结率", data.events.length ? Math.round(100 * data.events.filter((item) => item.status === "已办结").length / data.events.length) : 0, "%", "circle-check", `${data.events.filter((item) => item.status === "已办结").length} / ${data.events.length} 件`)}
      </div>
      ${weatherActive ? renderWeatherTasks("regulator") : ""}
      <div class="dash-grid">
        ${todoPanel(regulatorTodoItems())}
        <section class="panel geo-panel">
          <header class="panel-header"><h3>机构分布</h3><button class="text-btn" type="button" data-page="institutions">机构监管${icon("arrow-right")}</button></header>
          <div class="panel-body">${geoMapMarkup()}</div>
        </section>
      </div>
      <section class="panel mt-4">
        <header class="panel-header"><h3>重点事件<span class="muted-inline">${active.length}</span></h3><button class="text-btn" type="button" data-page="events">事件中心${icon("arrow-right")}</button></header>
        <div class="table-wrap"><table class="data-table event-table"><thead><tr><th>编号</th><th>事项</th><th>老人</th><th>风险</th><th>状态</th><th>责任单位 / 时限</th><th></th></tr></thead><tbody>${eventRows(active.sort(eventPriority).slice(0, 5), "regulator")}</tbody></table></div>
      </section>
      <div class="panel-grid equal mt-4">
        <section class="panel">
          <header class="panel-header"><h3>应急响应时效</h3>${stats.active ? `<span class="status-tag danger">${stats.active} 条响应中</span>` : ""}</header>
          <div class="panel-body sos-overview"><div class="quality-metrics sos-metrics"><div><strong>${sosRateText(stats.sla, true)}</strong><span>整体达标（${stats.sla.on_time}/${stats.sla.assessed}）</span></div><div><strong>${stats.avgClaim != null ? `${stats.avgClaim}秒` : "—"}</strong><span>平均接单</span></div><div><strong class="${stats.sla.missed ? "tone-high" : ""}">${stats.sla.missed}</strong><span>超时未接单</span></div><div><strong>${stats.escalated}</strong><span>升级联动</span></div></div>
            <p class="metric-rule">${icon("info")}达标率分母含超过 ${SOS_CONFIG.claimSlaSeconds} 秒仍无人接单的工单；时限内本人取消（误触 ${stats.falseTouch} 单）和仍在时限内的工单不计入。回拨为模拟流程，不统计接通率。</p>
            <ul class="sos-recent-list">${getSosSessions().slice(0, 3).map((session) => `<li><button type="button" data-action="sos-detail" data-id="${escapeHtml(session.id)}"><span><strong>${escapeHtml(session.resident)}</strong><small>${escapeHtml(session.trigger)} · ${escapeHtml(session.createdLabel || "")}</small></span>${sosStatusTag(session)}</button></li>`).join("") || `<li class="sos-recent-list-empty">暂无呼救记录</li>`}</ul></div>
        </section>
        <section class="panel">
          <header class="panel-header"><h3>机构质量</h3><button class="text-btn" type="button" data-page="insight">扣分依据${icon("arrow-right")}</button></header>
          <div class="table-wrap"><table class="data-table quality-table"><thead><tr><th>机构</th><th>城市</th><th class="num">机构填报</th><th class="num">台账核算</th><th>状态</th></tr></thead><tbody>${data.institutions.slice(0, 4).map((institution) => {
            const computed = qualityGap(institution);
            return `<tr><td><strong>${escapeHtml(institution.name)}</strong></td><td>${escapeHtml(institution.city)}</td><td class="num">${institution.score}</td><td class="num">${computed ? `<strong class="${computed.gap >= 10 ? "gap-warn" : ""}">${computed.score.toFixed(1)}</strong>${computed.gap >= 10 ? `<small class="gap-note">低 ${computed.gap.toFixed(1)}</small>` : ""}` : `<span class="meta-text">${state.insight ? "样本不足" : "计算中"}</span>`}</td><td>${statusTag(institution.status)}</td></tr>`;
          }).join("")}</tbody></table></div>
        </section>
      </div>
    `;
  }

  function todayRegulatorActions() {
    const data = state.data;
    const open = data.events.filter((event) => event.status !== "已办结");
    const high = open.filter((event) => event.level === "high");
    const owners = [...new Set(high.map((event) => String(event.owner || "").replace(/（.*?）/g, "")).filter(Boolean))];
    const pending = getMovementLogs().filter((log) => log.regulatorStatus === "待确认");
    const border = pending.filter((log) => log.border || log.type === "出境行程");
    const offline = (data.devices || []).filter((device) => device.status === "离线");
    const review = data.residents.filter((resident) => resident.screening?.reviewRequired);
    const items = [];
    const overdue = overdueEvents(open);
    if (overdue.length) items.push({ page: "events", tone: "danger", icon: "alarm-clock", title: `${overdue.length} 件事件已超过处置时限`, detail: overdue.slice(0, 3).map((event) => `${event.resident} · ${event.title}（${eventSla(event).text}）`).join("；"), side: "优先" });
    if (high.length) items.push({ page: "events", tone: "danger", icon: "alarm-clock", title: `督办 ${high.length} 条高风险未办结事件`, detail: `责任单位：${owners.slice(0, 3).join("、") || "待指派"}`, side: "优先" });
    if (pending.length) items.push({ page: "movements", tone: "warning", icon: "route", title: `核验 ${pending.length} 条外出报备`, detail: border.length ? `其中出境行程 ${border.length} 条：核对证件、境外医疗保险和旅行社资质` : "核对去向、返回时间和责任人", side: "今日内" });
    if (offline.length) items.push({ page: "insight", tone: "warning", icon: "wifi-off", title: `督促排查 ${offline.length} 台离线安全设备`, detail: offline.map((device) => `${device.resident}的${device.type}（${device.lastSeen}起离线）`).join("、"), side: "今日内" });
    if (review.length) items.push({ page: "monitoring", tone: "neutral", icon: "clipboard-check", title: `跟进 ${review.length} 份快筛人工复核`, detail: "机构复核后才能升级或办结", side: "本周" });
    return items.slice(0, 5);
  }

  // 已超过处置时限仍未办结的事件，超时最久的排在前面
  function overdueEvents(events = state.data.events) {
    const now = Date.now();
    return events.filter((event) => event.status !== "已办结" && eventSla(event, now).state === "open_overdue").sort((a, b) => (toMs(a.dueAt) || 0) - (toMs(b.dueAt) || 0));
  }

  function regionBar(name, people, alerts, tone) {
    const width = Math.round(people / 4.5);
    return `<div class="bar-row"><span>${name}</span><span class="bar-track"><span class="bar-fill ${tone}" style="width:${width}%"></span></span><strong>${people}<small class="meta-text">${alerts}条预警</small></strong></div>`;
  }

  function renderRegulatorMonitoring() {
    const residents = state.data.residents;
    const screenings = residents.map((resident) => resident.screening).filter(Boolean);
    const reviewCount = screenings.filter((item) => item.reviewRequired).length;
    const missingCount = screenings.filter((item) => item.missing && item.missing.length).length;
    const logs = getMovementLogs();
    const outsideIds = activeMovementResidentIds(logs);
    const crossCity = logs.filter((log) => ["跨市行程", "出境行程"].includes(log.type) && log.status !== "已返回");
    const stale = residents.filter((resident) => /昨天|天前/.test(resident.fresh || ""));
    const riskCount = (level) => residents.filter((resident) => (resident.screening?.overall || resident.risk) === level).length;
    const statusOf = (resident) => {
      const log = logs.find((item) => item.residentId === resident.id && isMovementActive(item));
      if (!log) return { text: resident.scene && resident.scene !== "机构入住" ? resident.scene : "在机构", place: resident.scene && resident.scene !== "机构入住" ? (resident.address || resident.room) : `${resident.institution || ""} ${resident.room || ""}`, tone: "" };
      return { text: log.status, place: `${log.destination}${log.expectedReturn ? ` · 应于 ${log.expectedReturn} 返回` : ""}`, tone: log.status === "超时未归" ? "danger" : "warning", id: log.id };
    };
    const rank = { 超时未归: 0, 外出中: 1, 就医中: 1, 在途中: 1, 待出发: 2 };
    const rows = residents.map((resident) => ({ resident, status: statusOf(resident) })).sort((a, b) => (rank[a.status.text] ?? 3) - (rank[b.status.text] ?? 3));
    return `
      <div class="page-toolbar">
        <div class="page-toolbar-title"><h2>人群动态监测</h2><p>旅居老人现在在哪、状态如何、风险有没有变化</p></div>
        <div class="toolbar-actions"><button class="btn btn-secondary" type="button" data-action="export-report">${icon("download")}导出监测表</button></div>
      </div>
      <div class="stat-grid stat-grid-5">
        ${statCard("已建档旅居老人", residents.length, "人", "users-round", sceneBreakdown(residents))}
        ${statCard("当前在外", outsideIds.size, "人", "map-pinned", logs.some((log) => log.status === "超时未归") ? `${logs.filter((log) => log.status === "超时未归").length} 人超时未归` : "都在约定时间内", logs.some((log) => log.status === "超时未归") ? "danger" : "")}
        ${statCard("跨市 / 出境行程", crossCity.length, "条", "train-front", `${crossCity.filter((log) => log.border || log.type === "出境行程").length} 条出境`)}
        ${statCard("快筛待复核", reviewCount, "份", "clipboard-check", `${missingCount} 份有缺项`, reviewCount ? "warning" : "")}
        ${statCard("档案超一天未更新", stale.length, "人", "clock-3", stale.length ? stale.map((r) => r.name).join("、") : "都在 24 小时内更新", stale.length ? "warning" : "")}
      </div>
      <div class="panel-grid">
        <section class="panel geo-panel">
          <header class="panel-header"><h3>区域分布</h3></header>
          <div class="panel-body">${geoMapMarkup(true)}</div>
        </section>
        <div class="panel-stack">
        <section class="panel">
          <header class="panel-header"><h3>风险构成</h3></header>
          <div class="panel-body"><div class="quality-metrics"><div><strong class="tone-high">${riskCount("high")}</strong><span>高风险</span></div><div><strong class="tone-medium">${riskCount("medium")}</strong><span>需关注</span></div><div><strong>${riskCount("low")}</strong><span>低风险</span></div></div></div>
        </section>
        <section class="panel screening-panel">
          <header class="panel-header"><h3>身心快筛覆盖</h3>${reviewCount ? `<span class="status-tag warning">${reviewCount} 份待复核</span>` : ""}</header>
          <div class="panel-body"><div class="dimension-rollup">${["肢体活动", "言语沟通", "视听能力", "心理与情绪", "日常生活"].map((label) => `<span><b>${label}</b><em>${screenings.filter((item) => item.dimensions.some((d) => d.label === label && d.level !== "unknown")).length}/${screenings.length}</em></span>`).join("")}</div></div>
        </section>
        </div>
      </div>
      <section class="panel mt-4">
        <header class="panel-header"><h3>在管老人动态<span class="muted-inline">${residents.length}</span></h3><button class="text-btn" type="button" data-page="movements">动向监管${icon("arrow-right")}</button></header>
        <div class="table-wrap"><table class="data-table"><thead><tr><th>老人</th><th>居住方式</th><th>现在</th><th>位置</th><th>综合风险</th><th>快筛</th><th>最近更新</th></tr></thead><tbody>
          ${rows.map(({ resident, status }) => `<tr><td>${residentCell(resident)}</td><td class="nowrap">${escapeHtml(resident.scene || "机构入住")}<small class="meta-text">${escapeHtml(resident.institution || "")}</small></td><td class="nowrap">${status.tone ? `<span class="status-tag ${status.tone}">${escapeHtml(status.text)}</span>` : escapeHtml(status.text)}</td><td>${status.id ? `<button class="text-btn" type="button" data-action="movement-detail" data-id="${escapeHtml(status.id)}">${escapeHtml(status.place)}</button>` : `<span class="meta-text">${escapeHtml(status.place)}</span>`}</td><td>${riskTag(resident.screening ? resident.screening.overall : resident.risk)}</td><td>${resident.screening ? screeningStatusTag(resident.screening) : statusTag("未评估")}</td><td class="nowrap">${escapeHtml(resident.fresh || "")}</td></tr>`).join("")}
        </tbody></table></div>
      </section>
    `;
  }

  function renderRegulatorMovements() {
    const allMovements = getMovementLogs();
    let movements = allMovements.slice();
    if (state.movementStatus === "active") movements = movements.filter(isMovementActive);
    if (state.movementStatus === "overdue") movements = movements.filter((log) => log.status === "超时未归");
    if (state.movementStatus === "returned") movements = movements.filter((log) => log.status === "已返回");
    if (state.movementStatus === "place_risk") movements = movements.filter((log) => log.routeAssessment?.level === "high");
    if (state.movementStatus === "scheduled") movements = movements.filter((log) => log.status === "待出发");
    if (state.movementConfirm === "pending") movements = movements.filter((log) => log.regulatorStatus === "待确认");
    if (state.movementConfirm === "confirmed") movements = movements.filter((log) => log.regulatorStatus !== "待确认");
    const outsideIds = activeMovementResidentIds(allMovements);
    const overdue = allMovements.filter((log) => log.status === "超时未归");
    const pending = allMovements.filter((log) => log.regulatorStatus === "待确认");
    const crossCity = allMovements.filter((log) => ["跨市行程", "出境行程"].includes(log.type) && log.status !== "已返回");
    return `
      <div class="page-toolbar">
        <div class="page-toolbar-title"><h2>旅居老人动向监管</h2><p>确认机构外出报备、责任链和返回状态，异常动向联动事件中心</p></div>
        <div class="toolbar-actions"><button class="btn btn-secondary" type="button" data-action="refresh-data">${icon("refresh-cw")}刷新台账</button><button class="btn btn-secondary" type="button" data-action="export-movements">${icon("download")}导出动向表</button></div>
      </div>
      <div class="stat-grid movement-stat-grid">
        ${statCard("当前在外", outsideIds.size, "人", "map-pinned", "来自机构最新报备", outsideIds.size ? "warning" : "positive")}
        ${statCard("待监管确认", pending.length, "条", "badge-check", "核验责任人和返回计划", pending.length ? "warning" : "positive")}
        ${statCard("超时未归", overdue.length, "条", "triangle-alert", overdue.length ? "已联动风险预警" : "暂无异常", overdue.length ? "danger" : "positive")}
        ${statCard("跨市 / 出境行程", crossCity.length, "条", "train-front", crossCity.some((log) => log.border) ? `含出境 ${crossCity.filter((log) => log.border).length} 条，核对证件与保险` : "关注离住交接完整性", crossCity.some((log) => log.border) ? "warning" : "")}
      </div>
      <section class="panel movement-panel">
        <div class="panel-header"><div class="section-head-copy"><h3>动向清单 <span class="muted-inline">${movements.length}条</span></h3><p>监管确认只核验报备与责任链，不替代机构现场照护责任</p></div><div class="filter-row"><select id="movement-status" class="form-control filter-control" aria-label="动向状态筛选"><option value="all" ${state.movementStatus === "all" ? "selected" : ""}>全部动向</option><option value="active" ${state.movementStatus === "active" ? "selected" : ""}>当前在外</option><option value="overdue" ${state.movementStatus === "overdue" ? "selected" : ""}>超时未归</option><option value="scheduled" ${state.movementStatus === "scheduled" ? "selected" : ""}>待出发</option><option value="returned" ${state.movementStatus === "returned" ? "selected" : ""}>已返回</option><option value="place_risk" ${state.movementStatus === "place_risk" ? "selected" : ""}>高风险场所</option></select><select id="movement-confirm" class="form-control filter-control" aria-label="监管确认筛选"><option value="all" ${state.movementConfirm === "all" ? "selected" : ""}>全部确认状态</option><option value="pending" ${state.movementConfirm === "pending" ? "selected" : ""}>待监管确认</option><option value="confirmed" ${state.movementConfirm === "confirmed" ? "selected" : ""}>已确认 / 跟进</option></select></div></div>
        <div class="table-wrap"><table class="data-table movement-table"><thead><tr><th>老人 / 记录</th><th>当前动向</th><th>去向 / 事由</th><th>出发 / 预计返回</th><th>责任人 / 联络</th><th>双重确认</th><th>操作</th></tr></thead><tbody>${movementRows(movements, "regulator")}</tbody></table></div>
      </section>
      
    `;
  }

  function renderRegulatorInstitutions() {
    if (LOCAL_BACKEND_ENABLED && !state.insight && !state.insightLoading && !state.insightError) loadInsight();
    const computed = new Map((state.insight?.quality || []).map((row) => [row.id, row]));
    const query = state.institutionQuery.trim().toLowerCase();
    const institutions = state.data.institutions.filter((item) => !query || [item.name, item.city].join(" ").toLowerCase().includes(query));
    return `
      <div class="page-toolbar">
        <div class="page-toolbar-title"><h2>机构服务质量监管</h2><p>用服务记录、响应时长和事件闭环评价机构；“台账计算分”的扣分依据见态势研判</p></div>
        <div class="toolbar-actions"><button class="btn btn-secondary" type="button" data-page="insight">${icon("chart-no-axes-combined")}查看扣分依据</button><button class="btn btn-secondary" type="button" data-action="export-report">${icon("download")}导出机构报告</button></div>
      </div>
      <div class="stat-grid">
        ${statCard("演示机构评分均值", institutions.length ? (institutions.reduce((sum, item) => sum + Number(item.score || 0), 0) / institutions.length).toFixed(1) : "—", "分", "medal", "样本字段；非实时自动评分", "positive")}
        ${statCard("快筛字段完整率", state.data.residents.length ? Math.round(100 * state.data.residents.reduce((sum, item) => sum + Number(item.screening?.dataCompleteness ?? 0), 0) / state.data.residents.length) : 0, "%", "clipboard-check", "按五维已填项统计", "warning")}
        ${statCard("工单平均接单", sosStats().avgClaim ?? "—", "秒", "timer", "由服务器记录的工单统计", "positive")}
        ${statCard("样本投诉事件", state.data.events.filter((item) => item.category === "服务投诉").length, "件", "message-square-warning", "按当前台账统计", "positive")}
      </div>
      <section class="panel">
        <div class="panel-header"><div class="section-head-copy"><h3>机构清单<span class="muted-inline">${institutions.length}</span></h3><p>填报参考分与台账计算分并列，扣分依据见态势研判</p></div><label class="global-search search-lg"><i data-lucide="search" aria-hidden="true"></i><input id="institution-query" type="search" value="${escapeHtml(state.institutionQuery)}" placeholder="搜索机构或城市" aria-label="搜索机构或城市"></label></div>
        <div class="table-wrap"><table class="data-table"><thead><tr><th>机构</th><th>城市</th><th>在住老人</th><th>待处理预警</th><th>平均响应</th><th>事件闭环率</th><th>填报参考分</th><th>台账计算分</th><th>状态</th><th>操作</th></tr></thead><tbody>
          ${institutions.length ? institutions.map((item) => `<tr><td><strong>${escapeHtml(item.name)}</strong><small class="meta-text">${escapeHtml(item.id)}</small></td><td>${escapeHtml(item.city)}</td><td>${item.residents}</td><td>${item.alerts}</td><td>${escapeHtml(item.response)}</td><td>${item.closure}%</td><td><strong>${item.score}</strong></td><td>${(() => { const row = computed.get(item.id); return !row ? "—" : row.sufficient ? `<strong>${row.score}</strong><small class="meta-text">${escapeHtml(row.grade)}</small>` : `<small class="meta-text">样本不足</small>`; })()}</td><td>${statusTag(item.status)}</td><td><button class="text-btn" type="button" data-action="institution-detail" data-id="${item.id}">查看${icon("arrow-right")}</button></td></tr>`).join("") : `<tr><td colspan="10"><div class="empty-state">${icon("search-x")}<strong>没有匹配机构</strong></div></td></tr>`}
        </tbody></table></div>
      </section>
    `;
  }

  function renderRegulatorEvents() {
    // 未办结的排前面（已超时 > 高风险 > 截止时间早），已办结的放在最后
    let events = [...state.data.events.filter((event) => event.status !== "已办结").sort(eventPriority), ...state.data.events.filter((event) => event.status === "已办结")];
    if (state.eventLevel !== "all") events = events.filter((event) => event.level === state.eventLevel);
    if (state.eventStatus !== "all") events = events.filter((event) => event.status === state.eventStatus);
    return `
      <div class="page-toolbar">
        <div class="page-toolbar-title"><h2>风险与事件中心</h2><p>当前样本事件清单，支持转派、督办、升级和闭环核验</p></div>
        <div class="toolbar-actions"><button class="btn btn-secondary" type="button" data-action="export-report">${icon("download")}导出事件清单</button></div>
      </div>
      ${renderSosQueuePanel("regulator", { always: true })}
      ${renderSosRankingPanel()}
      <section class="panel">
        <div class="panel-header"><div class="section-head-copy"><h3>事件清单 <span class="muted-inline">${events.length}条</span></h3><p>高风险事件须人工复核后派单</p></div><div class="filter-row"><select id="event-level" class="form-control filter-control" aria-label="事件风险筛选"><option value="all">全部风险</option><option value="high" ${state.eventLevel === "high" ? "selected" : ""}>高风险</option><option value="medium" ${state.eventLevel === "medium" ? "selected" : ""}>需关注</option><option value="low" ${state.eventLevel === "low" ? "selected" : ""}>低风险</option></select><select id="event-status" class="form-control filter-control" aria-label="事件状态筛选"><option value="all">全部状态</option><option value="处置中" ${state.eventStatus === "处置中" ? "selected" : ""}>处置中</option><option value="待复核" ${state.eventStatus === "待复核" ? "selected" : ""}>待复核</option><option value="已转派" ${state.eventStatus === "已转派" ? "selected" : ""}>已转派</option><option value="已办结" ${state.eventStatus === "已办结" ? "selected" : ""}>已办结</option></select></div></div>
        <div class="table-wrap"><table class="data-table"><thead><tr><th>事件编号</th><th>事项</th><th>老人</th><th>风险</th><th>状态</th><th>责任单位 / 时限</th><th>操作</th></tr></thead><tbody>${eventRows(events, "regulator")}</tbody></table></div>
      </section>
    `;
  }

  function radarHandled(cluster) {
    const broadcasted = (state.data.broadcasts || []).some((item) => item.clusterId === cluster.id);
    const transferred = state.data.events.some((item) => item.clusterId === cluster.id);
    return cluster.kind === "fraud" ? broadcasted && transferred : transferred;
  }

  async function loadRadar(force = false, options = {}) {
    if (!LOCAL_BACKEND_ENABLED || (state.radarLoading && !force)) return;
    state.radarLoading = true;
    const previous = state.radar;
    try {
      const response = await fetch("/api/radar", { cache: "no-store", headers: authHeaders() });
      if (!response.ok) throw new Error("radar_unavailable");
      state.radar = await response.json();
      state.radarError = "";
      state.radarScanAt = sosClock();
      if (previous && !options.quiet) radarDetect(previous, state.radar);
    } catch (error) {
      state.radarError = "类案研判服务暂不可用";
    }
    state.radarLoading = false;
    if (state.role === "regulator") { renderNav(); if (state.page === "radar" || state.page === "dashboard") renderPage(); }
  }

  // 台账变化后重新研判，与上一次结果比对：出现新类案或已有类案加入新老人时，弹出“发现时刻”提示。
  function radarDetect(previous, current) {
    const known = new Set((previous.clusters || []).flatMap((cluster) => cluster.event_ids));
    state.radarNewIds = state.radarNewIds || new Set();
    current.clusters.forEach((cluster) => {
      const fresh = cluster.event_ids.filter((id) => !known.has(id));
      if (!fresh.length) return;
      fresh.forEach((id) => state.radarNewIds.add(id));
      const isNew = !(previous.clusters || []).some((item) => item.id === cluster.id);
      showRadarAlert(cluster, fresh, isNew);
    });
  }

  function showRadarAlert(cluster, freshIds, isNew) {
    document.querySelector(".radar-alert")?.remove();
    const members = cluster.members.filter((member) => freshIds.includes(member.id));
    const names = [...new Set(members.map((member) => member.resident))].join("、");
    const earlier = new Set(cluster.members.filter((member) => !freshIds.includes(member.id)).map((member) => member.residentId));
    const newPerson = members.some((member) => !earlier.has(member.residentId));
    const shared = [...new Set(members.flatMap((member) => member.clues || []))].filter((clue) => (cluster.common_clues || cluster.clues || []).includes(clue) || (cluster.clues || []).includes(clue)).slice(0, 3);
    const alert = document.createElement("section");
    alert.className = `radar-alert ${cluster.risk}`;
    alert.setAttribute("role", "alert");
    alert.innerHTML = `<span class="radar-scope" aria-hidden="true"><i></i></span>
      <div class="radar-alert-copy">
        <span class="eyebrow">类案雷达 · ${members.some((member) => member.intercepted) ? "预警生效" : isNew ? "发现新类案" : "类案扩大"}</span>
        <strong>${members.some((member) => member.intercepted) ? "老人收到防骗提醒后，先来问AI再上报" : isNew ? `${cluster.residents.length}位老人分别报告相似问题` : newPerson ? `第${cluster.residents.length}位老人报告了相似话术` : `相似话术又被上报（共 ${cluster.count} 件）`}</strong>
        <p>${escapeHtml(names)}刚刚上报${shared.length ? `，命中“${shared.map(escapeHtml).join("”“")}”` : ""}，已并入「${escapeHtml(cluster.report?.title || "类案")}」。</p>
        <div class="radar-alert-actions"><button class="btn btn-primary btn-sm" type="button" data-action="radar-alert-open">${icon("radar")}查看类案并处置</button><button class="btn btn-secondary btn-sm" type="button" data-action="radar-alert-close">稍后</button></div>
      </div>`;
    document.body.appendChild(alert);
    refreshIcons();
  }



  // 关系图：上报老人 → 命中的话术线索 → 指向的名义/机构。三列布局，连线逐条“画出来”。
  function radarGraph(cluster) {
    const fresh = state.radarNewIds || new Set();
    const members = cluster.members;
    const clues = (cluster.clues || []).slice(0, 6);
    const aiFound = cluster.found_by === "AI" && cluster.ai_scheme;
    const subject = aiFound ? cluster.ai_scheme : cluster.entities && cluster.entities[0] ? cluster.entities[0] : cluster.kind === "fraud" ? "同类推销" : "同一机构收费";
    const rows = Math.max(members.length, clues.length, 2);
    const height = rows * 44 + 36;
    const y = (index, count) => 36 + (height - 36) * (index + 0.5) / count;
    const subjectY = 36 + (height - 36) / 2;
    const clueY = Object.fromEntries(clues.map((clue, index) => [clue, y(index, clues.length)]));
    let edge = 0;
    const links = members.flatMap((member, index) => (member.clues || []).filter((clue) => clue in clueY).map((clue) => {
      const y1 = y(index, members.length); const y2 = clueY[clue];
      return `<path class="radar-edge${fresh.has(member.id) ? " fresh" : ""}" pathLength="1" style="--d:${edge++}" d="M128 ${y1} C 178 ${y1}, 178 ${y2}, 222 ${y2}"/>`;
    })).join("");
    const toSubject = clues.map((clue) => `<path class="radar-edge core" pathLength="1" style="--d:${edge++}" d="M338 ${clueY[clue]} C 372 ${clueY[clue]}, 372 ${subjectY}, 402 ${subjectY}"/>`).join("");
    const elderNodes = members.map((member, index) => {
      const cy = y(index, members.length);
      return `<g class="radar-node elder${fresh.has(member.id) ? " fresh" : ""}${member.intercepted ? " intercepted" : ""}" data-action="event-detail" data-id="${escapeHtml(member.id)}" role="button" tabindex="0" aria-label="${escapeHtml(member.resident)}上报：${escapeHtml(member.title)}">
        <rect x="8" y="${cy - 15}" width="120" height="30" rx="15"/><circle cx="24" cy="${cy}" r="10"/><text class="avatar" x="24" y="${cy + 4}">${escapeHtml(String(member.resident || "?").slice(-1))}</text><text x="40" y="${cy + 4}">${escapeHtml(String(member.resident || "").slice(0, 4))}${member.intercepted ? " · 求证" : fresh.has(member.id) ? " · 新" : ""}</text></g>`;
    }).join("");
    const clueNodes = clues.map((clue) => `<g class="radar-node clue${(cluster.ai_clues || []).includes(clue) ? " ai" : ""}"><rect x="222" y="${clueY[clue] - 13}" width="116" height="26" rx="6"/><text x="280" y="${clueY[clue] + 4}" text-anchor="middle">${escapeHtml(clue.slice(0, 8))}</text></g>`).join("");
    const subjectNode = `<g class="radar-node subject"><rect x="402" y="${subjectY - 22}" width="130" height="44" rx="10"/><text x="467" y="${subjectY - 3}" text-anchor="middle">${escapeHtml(subject.slice(0, 9))}</text><text class="sub" x="467" y="${subjectY + 13}" text-anchor="middle">${aiFound ? "AI 识别的手法" : cluster.kind === "fraud" ? "指向的名义（待核实）" : (cluster.common_clues || []).includes("低价团/强制购物") ? "指向的线路（待核实）" : "指向的机构"}</text></g>`;
    return `<figure class="radar-graph"><svg viewBox="0 0 540 ${height}" role="img" aria-label="上报老人、共同话术与指向名义的关系图">
      <text class="col" x="68" y="16" text-anchor="middle">上报老人</text><text class="col" x="280" y="16" text-anchor="middle">命中的话术线索</text><text class="col" x="467" y="16" text-anchor="middle">线索指向（待核实）</text>
      ${links}${toSubject}${elderNodes}${clueNodes}${subjectNode}</svg>
      <figcaption>${cluster.residents.length} 位老人分别上报（共 ${members.length} 件），有 ${clues.length} 条相似的手法或主体线索；是否为同一主体、上报人之间是否相识均未核实。点老人可查看原始上报，归错的个案可在下方移出。</figcaption></figure>`;
  }

  function radarBroadcastText(cluster) {
    const subject = cluster.found_by === "AI" && cluster.ai_scheme ? `用“${cluster.ai_scheme}”的手法` : cluster.entities && cluster.entities[0] ? `以“${cluster.entities[0]}”等名义` : "";
    const plain = { "预付/定金": "先交定金或预付款", "养生基地/康养团": "介绍养生基地、康养团", "限时催促": "说名额有限、今天必须交", "包住包吃": "包吃包住", "免费体检": "送免费体检", "高回报投资": "承诺高回报", "索要验证码": "要手机验证码", "转个人账户": "让转到个人账户", "巴马/长寿村": "打巴马长寿村的旗号", "会员卡": "办会员卡" };
    const phrases = (cluster.clues || []).map((clue) => plain[clue] || ((cluster.ai_clues || []).includes(clue) ? clue : "")).filter(Boolean).slice(0, 3);
    return `近期有人${subject}向旅居老人推销，常见说法是${phrases.join("、") || "先交钱"}。请不要预付款、不要向个人账户转账，拿不准先问机构工作人员。`;
  }

  function radarCluster(cluster) {
    const report = cluster.report || {};
    const broadcasted = (state.data.broadcasts || []).some((item) => item.clusterId === cluster.id);
    const transferred = state.data.events.some((item) => item.clusterId === cluster.id);
    return `<article class="radar-card ${cluster.risk}">
      <header class="radar-card-head">
        <div><span class="eyebrow">${escapeHtml(cluster.category)} · ${escapeHtml(cluster.id)}${cluster.found_by && cluster.found_by !== "规则" ? `<b class="ai-found">${icon("bot")}${cluster.found_by === "AI" ? "由 AI 发现" : "AI 补充归并"}</b>` : ""}</span><h3>${escapeHtml(report.title || "类案")}</h3></div>
        <div class="radar-card-meta">${riskTag(cluster.risk)}<span class="radar-count"><strong>${cluster.residents.length}</strong>位老人${cluster.count > cluster.residents.length ? ` · ${cluster.count}件` : ""}</span></div>
      </header>
      <div class="radar-card-body">
        <div class="radar-report">
          ${cluster.ai_scheme ? `<div><span>AI 识别手法</span><p><strong class="ai-scheme">${icon("bot")}${escapeHtml(cluster.ai_scheme)}</strong></p></div>` : ""}
          <div><span>共同线索</span><p class="radar-clues">${(cluster.clues || []).map((clue) => `<em${(cluster.ai_clues || []).includes(clue) ? ' class="ai" title="AI 从原始上报中抽取"' : ""}>${escapeHtml(clue)}</em>`).join("")}</p></div>
          ${cluster.entities && cluster.entities.length ? `<div><span>涉及名义</span><p>${cluster.entities.map(escapeHtml).join("、")}<small class="radar-hint">名称取自老人描述，待核实</small></p></div>` : ""}
          <div><span>研判</span><p>${escapeHtml(report.judgement || "")}</p></div>
          <div><span>建议措施</span><ol>${(report.actions || []).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ol></div>
          <small class="radar-source">${icon(report.by === "DeepSeek" ? "bot" : "file-text")}研判来源：${report.by === "DeepSeek" ? "DeepSeek 依据归并证据生成" : "规则归并 + 模板生成"}${report.note ? `（${escapeHtml(report.note)}）` : ""} · 不直接认定违法，需人工核实</small>
        </div>
        <div class="radar-members">${radarGraph(cluster)}<span>归并的个案 · 点击查看证据链${state.role === "regulator" ? "；归错的可移出" : ""}</span>${cluster.members.map((member) => `<div class="radar-member-row"><button type="button" class="radar-member${(state.radarNewIds || new Set()).has(member.id) ? " fresh" : ""}" data-action="event-detail" data-id="${escapeHtml(member.id)}"><span class="cell-avatar">${escapeHtml(String(member.resident || "?").slice(-1))}</span><span><strong>${escapeHtml(member.title)}</strong><small>${escapeHtml(member.resident)} · ${escapeHtml(eventTimeText(getEvent(member.id) || member))} · ${escapeHtml(member.status)} · 查看证据链</small></span>${icon("arrow-right")}</button>${state.role === "regulator" ? `<button type="button" class="text-btn radar-exclude" data-action="radar-exclude" data-id="${escapeHtml(member.id)}" data-cluster="${escapeHtml(cluster.id)}" title="人工核实后认为这件个案不属于本类案">不属于此类</button>` : ""}</div>`).join("")}</div>
      </div>
      <footer class="radar-card-actions">
        ${broadcasted ? `<div class="radar-effect">${icon("megaphone")}<span>已提醒 <strong>${state.data.residents.length}</strong> 位旅居老人</span>${icon("shield-check")}<span>预警后主动求证 <strong>${cluster.intercepted || 0}</strong> 起</span></div>` : ""}
        <button class="btn btn-ghost" type="button" data-action="radar-export" data-id="${cluster.id}">${icon("file-down")}导出证据材料</button>
        ${cluster.kind === "fraud" ? `<button class="btn ${broadcasted ? "btn-secondary" : "btn-primary"}" type="button" data-action="radar-broadcast" data-id="${cluster.id}"${broadcasted ? " disabled" : ""}>${icon(broadcasted ? "check" : "megaphone")}${broadcasted ? "已推送防骗提醒" : "向旅居老人推送防骗提醒"}</button>` : ""}
        <button class="btn ${transferred ? "btn-secondary" : cluster.kind === "fraud" ? "btn-danger" : "btn-primary"}" type="button" data-action="radar-transfer" data-id="${cluster.id}"${transferred ? " disabled" : ""}>${icon(transferred ? "check" : "send")}${transferred ? "已生成督办事件" : cluster.kind === "fraud" ? "汇总证据移交反诈" : (cluster.common_clues || []).includes("低价团/强制购物") ? "通报文旅市场监管核查" : "督办机构整改"}</button>
      </footer>
    </article>`;
  }

  function renderRegulatorRadar() {
    if (!LOCAL_BACKEND_ENABLED) {
      return `<div class="page-toolbar"><div class="page-toolbar-title"><h2>类案雷达</h2><p>把不同老人分别上报的相似问题归并为类案</p></div></div><div class="notice">${icon("info")}类案研判需要通过“启动作品.bat”运行本地完整服务。</div>`;
    }
    if (!state.radar && !state.radarLoading) window.setTimeout(() => loadRadar(), 0);
    const radar = state.radar;
    const clusters = radar ? radar.clusters : [];
    return `
      <div class="page-toolbar">
        <div class="page-toolbar-title"><h2>类案雷达</h2><p>把不同老人分别上报的相似问题自动归并为类案，从“一件一件处理”转向“一类一类治理”</p></div>
        <div class="toolbar-actions"><div class="radar-live"><span class="radar-scope" aria-hidden="true"><i></i></span><div><strong>实时监测中</strong><small>台账一有新上报即自动研判${state.radarScanAt ? ` · 最近 ${escapeHtml(state.radarScanAt)}` : ""}</small></div></div>${radar ? `<span class="status-tag success">${escapeHtml(radar.source)}</span>` : ""}<button class="btn btn-secondary" type="button" data-action="radar-refresh">${icon("refresh-cw")}重新研判</button></div>
      </div>
      <div class="stat-grid">
        ${statCard("纳入分析的个案", radar ? radar.scanned : "—", "件", "files", "诈骗风险、服务投诉、消费纠纷", "positive")}
        ${statCard("发现类案", radar ? clusters.length : "—", "类", "radar", radar ? (radar.ai && radar.ai.found ? `其中 ${radar.ai.found} 类由 AI 发现或补充` : `涉及 ${radar.residents} 位老人，均为不同人上报`) : "至少2位不同老人上报", clusters.length ? "warning" : "positive")}
        ${statCard("预警后主动求证", radar ? radar.intercepted || 0 : "—", "起", "shield-check", "收到提醒后先问AI、再确认上报", radar && radar.intercepted ? "positive" : "")}
        ${statCard("高风险类案", radar ? radar.high : "—", "类", "siren", "疑似涉老预付款骗局", radar && radar.high ? "danger" : "positive")}
      </div>
      ${state.radarError ? `<div class="notice warning">${icon("triangle-alert")}${escapeHtml(state.radarError)}</div>` : ""}
      ${!radar && !state.radarError ? `<div class="empty-state">${icon("loader-circle", "spin")}<strong>正在归并分析事件台账…</strong></div>` : ""}
      ${radar && !clusters.length ? `<div class="empty-state">${icon("badge-check")}<strong>暂未发现类案</strong><p>单个事件仍在事件中心逐件处置。</p></div>` : ""}
      <div class="radar-list">${clusters.map(radarCluster).join("")}</div>
      ${radar && (radar.excluded || []).length ? `<section class="panel radar-excluded"><header class="panel-header"><div class="section-head-copy"><h3>人工移出的个案 <span class="muted-inline">${radar.excluded.length}</span></h3><p>监管员核实后判定不属于类案，不再参与归并；个案本身仍在事件中心逐件处置</p></div></header><div class="panel-body"><ul class="excluded-list">${radar.excluded.map((item) => `<li><button class="text-btn" type="button" data-action="event-detail" data-id="${escapeHtml(item.eventId)}">${escapeHtml(item.eventId)}</button><span>${escapeHtml(item.resident || "")} · ${escapeHtml(item.title || "")}</span><small>移出原因：${escapeHtml(item.reason || "未填写")}</small><button class="btn btn-ghost btn-sm" type="button" data-action="radar-restore" data-id="${escapeHtml(item.eventId)}">撤销移出</button></li>`).join("")}</ul></div></section>` : ""}
      <section class="panel review-note-panel"><div class="notice">${icon("shield-check")}归并依据为文本相似度、共同线索，以及 AI 从原始上报中抽取的手法与话术（虚线标注，可逐条复核）；归并只说明手法相似，是否同一主体需人工核实，归错的个案可移出。研判报告只引用已归并的证据，不直接认定违法。推送给老人的提醒不含任何个人信息。</div></section>
    `;
  }

  const RADAR_EXCLUDE_REASONS = ["手法不同，只是用词相近", "同一位老人重复上报", "信息不足，暂不能归类", "已核实与类案无关"];

  function openRadarExclude(eventId, clusterId) {
    const event = getEvent(eventId);
    openModal({
      title: "把个案移出类案",
      subtitle: `${eventId}${event ? ` · ${event.resident} · ${event.title}` : ""}`,
      body: `<form id="radar-exclude-form" class="form-grid"><label class="full"><span>移出原因</span><select class="form-control" name="reason" required><option value="">请选择</option>${RADAR_EXCLUDE_REASONS.map((item) => `<option>${item}</option>`).join("")}</select></label><div class="full notice">${icon("info")}移出后这件个案不再参与类案归并，事件本身仍在事件中心处置；操作写入审计，可随时撤销。</div></form>`,
      footer: `<button class="btn btn-secondary" type="button" data-action="close-modal">取消</button><button class="btn btn-primary" type="submit" form="radar-exclude-form">${icon("split")}确认移出</button>`,
      onOpen: () => document.getElementById("radar-exclude-form").addEventListener("submit", (formEvent) => {
        formEvent.preventDefault();
        const reason = String(new FormData(formEvent.target).get("reason") || "");
        if (!reason) return;
        saveRadarReview({ eventId, clusterId, decision: "exclude", reason }, "类案人工纠错：移出个案");
        closeModal();
        showToast("已移出类案", `${eventId} 不再参与归并，可在雷达页底部撤销。`);
      })
    });
  }

  function saveRadarReview(item, action) {
    state.data.radarReviews = [item, ...(state.data.radarReviews || []).filter((entry) => entry.eventId !== item.eventId)];
    if (item.decision !== "exclude") state.data.radarReviews = state.data.radarReviews.filter((entry) => entry.eventId !== item.eventId);
    saveData(action, "radar_review", item.eventId).then(() => loadRadar(true, { quiet: true }));
  }

  function radarBroadcast(id) {
    const cluster = (state.radar?.clusters || []).find((item) => item.id === id);
    if (!cluster) return;
    state.data.broadcasts = Array.isArray(state.data.broadcasts) ? state.data.broadcasts : [];
    const item = { id: `BC-${cluster.id}`, title: "防骗提醒", text: radarBroadcastText(cluster), area: "北海、河池旅居片区", clusterId: cluster.id, time: `今日 ${sosClock().slice(0, 5)}`, from: "自治区民政主管部门" };
    state.data.broadcasts = [item, ...state.data.broadcasts.filter((entry) => entry.id !== item.id)];
    saveData("推送类案防骗提醒", "broadcast", item.id);
    showToast("防骗提醒已推送", "旅居老人在首页会看到这条提醒，不含任何个人信息。");
    renderPage();
  }

  function radarTransfer(id) {
    const cluster = (state.radar?.clusters || []).find((item) => item.id === id);
    if (!cluster) return;
    const report = cluster.report || {};
    const fraud = cluster.kind === "fraud";
    const border = (cluster.common_clues || []).includes("低价团/强制购物");
    // 数据库要求事件关联一位老人：以风险最高的个案为主案，其余老人记在 residentIds 中。
    const primary = [...cluster.members].sort((a, b) => (b.level === "high") - (a.level === "high"))[0] || {};
    const eventItem = { id: uniqueRecordId("EV"), residentId: primary.residentId || "", residentIds: [...new Set(cluster.members.map((member) => member.residentId))], resident: `${primary.resident || ""}等${cluster.residents.length}位老人`, level: cluster.risk, category: fraud ? "类案移交" : "类案督办", title: String(report.title || "类案").slice(0, 40), source: "类案雷达", location: border ? "东兴边境旅游线路" : "北海、河池旅居片区", time: "刚刚", status: "已转派", owner: fraud ? "属地公安反诈中心" : border ? "防城港市文旅、市场监管部门" : "北海市市场监管部门", deadline: fraud ? "优先响应" : "3个工作日", summary: `${report.pattern || ""}${report.judgement || ""}`.slice(0, 300), action: (report.actions || []).join("；"), clusterId: cluster.id, rationale: [`归并个案：${cluster.event_ids.join("、")}`, `共同线索：${(cluster.clues || []).slice(0, 4).join("、")}`], timeline: [{ time: "刚刚", text: `类案雷达归并 ${cluster.count} 件个案并生成研判`, state: "done" }, { time: "刚刚", text: fraud ? "监管端汇总证据移交属地公安反诈中心" : border ? "监管端通报文旅、市场监管部门核查旅行社" : "监管端督办机构自查整改", state: "current" }] };
    state.data.events.unshift(stampNewEvent(eventItem));
    saveData(fraud ? "类案移交反诈" : "类案督办整改", "risk_event", eventItem.id);
    showToast(fraud ? "已移交反诈" : "已生成督办事件", `${eventItem.id} 已进入事件中心。`);
    renderNav();
    renderPage();
  }


  // ---------------------------------------------------------------- AI 监管参谋
  const ADVISOR_SUGGESTIONS = ["这周有哪些事要督办？", "今天哪些老人最需要重点关注？", "有没有老人外出超时没回来？", "北海银龄康养中心最近投诉多吗？", "巴马那边的诈骗线索处置到哪一步了？"];

  function advisorEvidenceChip(id) {
    const eventItem = state.data.events.find((item) => item.id === id);
    const label = eventItem ? `${id} · ${String(eventItem.title || "").slice(0, 14)}` : id;
    if (id.startsWith("EV-")) return `<button type="button" class="evidence-chip" data-action="event-detail" data-id="${escapeHtml(id)}">${icon("file-text")}${escapeHtml(label)}</button>`;
    const resident = id.startsWith("GX-") ? state.data.residents.find((item) => item.id === id) : null;
    const page = id.startsWith("MV-") ? "movements" : id.startsWith("IN-") ? "institutions" : id.startsWith("CL-") ? "radar" : id.startsWith("GX-") ? "monitoring" : "";
    const pageIcon = { radar: "radar", movements: "map-pinned", institutions: "building-2", monitoring: "contact-round" }[page];
    if (page) return `<button type="button" class="evidence-chip" data-page="${page}">${icon(pageIcon)}${escapeHtml(resident ? `${resident.name} · 档案` : id)}</button>`;
    const kindIcon = id.startsWith("DV-") ? "watch" : id.startsWith("WA-") || id.startsWith("CK-") ? "cloud-lightning" : "phone-call";
    return `<span class="evidence-chip">${icon(kindIcon)}${escapeHtml(id)}</span>`;
  }

  function advisorEntryMarkup(entry, index) {
    const question = `<div class="advisor-q"><span class="cell-avatar">${escapeHtml((state.data.accounts?.regulator?.name || "陈").slice(0, 1))}</span><p>${escapeHtml(entry.question)}</p></div>`;
    if (entry.loading) return `<article class="advisor-entry">${question}<div class="empty-state compact">${icon("loader-circle", "spin")}<strong>正在查询台账并研判…</strong></div></article>`;
    if (entry.error) return `<article class="advisor-entry">${question}<div class="notice warning">${icon("triangle-alert")}${escapeHtml(entry.error)}</div></article>`;
    const reply = entry.reply; const card = reply.result;
    // 先给结论、待办、责任与时限；查询过程默认收起放在后面，需要时再展开
    return `<article class="advisor-entry">${question}
      <div class="ai-result-area agent${entry.shown ? " no-anim" : ""}" style="--steps:0">
        <section class="advisor-answer">
          <span class="eyebrow">${icon("bot")}AI 监管参谋研判</span>
          <h3>${escapeHtml(card.answer)}</h3>
          ${card.findings.length ? `<ol class="advisor-findings">${card.findings.map((item) => `<li><p>${escapeHtml(item.text)}</p><div class="evidence-row">${item.evidence.length ? item.evidence.map(advisorEvidenceChip).join("") : `<span class="evidence-chip muted">未关联证据，仅供参考</span>`}</div></li>`).join("")}</ol>` : ""}
          ${card.suggestions.length ? `<div class="advisor-suggest"><strong>${icon("clipboard-check")}督办建议</strong><ul>${card.suggestions.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>` : ""}
          ${card.draft ? `<div class="advisor-draft"><header><strong>${icon("file-pen-line")}督办通知草稿</strong><small>AI 按台账起草，印发前需人工审核修改</small><button class="btn btn-secondary btn-sm" type="button" data-action="advisor-copy" data-index="${index}">${icon("copy")}复制正文</button></header><pre>${escapeHtml(card.draft)}</pre></div>` : ""}
          <footer><small>${icon("cpu")}${escapeHtml(reply.provider)} · ${escapeHtml(reply.model)} · 结论只引用台账中存在的编号${card.dropped_ids ? `（已删去 ${card.dropped_ids} 个不存在的编号）` : ""}</small><button class="btn btn-secondary btn-sm" type="button" data-action="advisor-brief" data-index="${index}">${icon("download")}生成督办简报</button></footer>
          ${card.followups.length ? `<div class="ai-suggestions"><span>接着问</span>${card.followups.map((text) => `<button type="button" data-action="advisor-suggest" data-text="${escapeHtml(text)}">${escapeHtml(text)}</button>`).join("")}</div>` : ""}
        </section>
        ${agentTraceMarkup({ trace: reply.trace, elapsed: reply.elapsed_ms }, true)}
      </div>
    </article>`;
  }

  function renderRegulatorAdvisor() {
    const log = state.advisorLog || [];
    const markup = `
      <div class="page-toolbar">
        <div class="page-toolbar-title"><h2>AI 监管参谋</h2><p>用一句话提问，AI 查询事件、机构、动向、类案台账后给出带证据的研判和督办建议</p></div>
        <div class="toolbar-actions"><span class="status-tag neutral">只读查询，不修改台账</span></div>
      </div>
      ${!LOCAL_BACKEND_ENABLED ? `<div class="notice">${icon("info")}AI 监管参谋需要通过“启动作品.bat”运行本地完整服务。</div>` : `
      <section class="panel advisor-ask">
        <div class="advisor-input-row"><input id="advisor-input" class="form-control" type="text" maxlength="300" placeholder="例如：这周有哪些事要督办？" autocomplete="off"><button class="btn btn-primary" type="button" data-action="advisor-ask">${icon("send")}提问</button></div>
        <div class="ai-suggestions"><span>试试这样问</span>${ADVISOR_SUGGESTIONS.map((text) => `<button type="button" data-action="advisor-suggest" data-text="${escapeHtml(text)}">${escapeHtml(text)}</button>`).join("")}</div>
      </section>
      <div class="advisor-log">${log.map((entry, index) => advisorEntryMarkup(entry, index)).reverse().join("")}</div>
      ${log.length ? "" : `<div class="empty-state">${icon("bot")}<strong>还没有提问</strong><p>回答中的每条结论都附证据编号，点编号可查看原始记录。</p></div>`}`}
    `;
    log.forEach((entry) => { if (entry.reply) window.setTimeout(() => { entry.shown = true; }, 0); });
    return markup;
  }

  async function askAdvisor(question) {
    const text = String(question || "").trim();
    if (!text || (state.advisorLog || []).some((entry) => entry.loading)) return;
    state.advisorLog = [...(state.advisorLog || []), { question: text, loading: true }];
    const entry = state.advisorLog[state.advisorLog.length - 1];
    renderPage();
    try {
      const response = await fetch("/api/advisor", { method: "POST", headers: authHeaders(true), body: JSON.stringify({ question: text }) });
      if (!response.ok) throw new Error("advisor_failed");
      entry.reply = await response.json();
    } catch (error) {
      entry.error = "AI 监管参谋暂时不可用，请稍后重试。";
    }
    entry.loading = false;
    if (state.page === "advisor") renderPage();
  }

  function copyAdvisorDraft(index) {
    const draft = (state.advisorLog || [])[Number(index)]?.reply?.result?.draft;
    if (!draft) return;
    const done = () => showToast("已复制督办通知正文", "粘贴到公文系统后，请人工审核修改再印发。", "success");
    const fallback = () => {
      const area = document.createElement("textarea");
      area.value = draft;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      try { document.execCommand("copy"); done(); } catch (error) { showToast("复制失败", "请手动选中正文复制。", "warning"); }
      area.remove();
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(draft).then(done, fallback);
    else fallback();
  }

  function downloadAdvisorBrief(index) {
    const entry = (state.advisorLog || [])[Number(index)];
    if (!entry || !entry.reply) return;
    const card = entry.reply.result;
    const describe = (id) => { const item = state.data.events.find((eventItem) => eventItem.id === id); return item ? `${id}（${item.resident}，${item.title}，${item.status}）` : id; };
    const lines = [
      "旅居养老监管督办简报（AI 监管参谋生成，需人工审核后印发）", "",
      `生成时间：${new Date().toLocaleString("zh-CN")}`, `提问：${entry.question}`, "",
      "一、研判结论", card.answer, "",
      "二、主要发现", ...card.findings.map((item, i) => `${i + 1}. ${item.text}\n   证据：${item.evidence.map(describe).join("；") || "无"}`), "",
      "三、督办建议", ...card.suggestions.map((item, i) => `${i + 1}. ${item}`), "",
      ...(card.draft ? ["四、督办通知草稿（需人工审核）", card.draft, ""] : []),
      `来源：${entry.reply.provider} · ${entry.reply.model}；数据为演示样本台账。`,
    ];
    const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `督办简报_${new Date().toISOString().slice(0, 10)}.txt`;
    link.click();
    URL.revokeObjectURL(link.href);
    showToast("督办简报已生成", "文本已下载，印发前请人工审核。");
  }

  // ---------------------------------------------------------------- AI 主动预警
  const CARE_FOLLOW_UP = "AI预警随访";
  const CARE_KIND_ICON = { 快筛: "clipboard-check", 事件: "siren", 外出: "map-pinned", 服务记录: "heart-pulse", 类案: "radar", 档案: "history", 打卡: "calendar-check" };
  const CARE_RANK = { low: 0, medium: 1, high: 2 };
  const CARE_PRIORITY = { high: "今日必须当面处理", medium: "今日留意", low: "常规照护" };

  async function loadCare(force = false) {
    if (!LOCAL_BACKEND_ENABLED || (state.careLoading && !force)) return;
    state.careLoading = true;
    const role = state.role;
    const fetchCare = async (mode) => {
      const response = await fetch(`/api/care${mode ? `?mode=${mode}` : ""}`, { cache: "no-store", headers: authHeaders() });
      if (!response.ok) throw new Error("care_unavailable");
      return response.json();
    };
    const refresh = () => { if (state.role === role && ["care", "dashboard"].includes(state.page)) renderPage(); if (state.role === role) renderNav(); };
    try {
      state.care = await fetchCare("rules");  // 规则结果先到，页面立刻有内容
      state.careError = "";
      state.careScanAt = sosClock();
      refresh();
      if (state.care.pending_ai) {
        state.care = await fetchCare("");  // 再等 DeepSeek 综合研判
        state.careScanAt = sosClock();
      }
    } catch (error) {
      state.careError = "AI 主动预警服务暂不可用";
    }
    state.careLoading = false;
    refresh();
  }

  function careTaskFor(item) {
    return state.data.serviceLogs.find((log) => log.type === CARE_FOLLOW_UP && log.residentId === item.id && log.status === "待执行");
  }

  function careEvidenceChip(id) {
    if (/^(EV|MV|CL|IN)-/.test(id)) return advisorEvidenceChip(id);
    if (id.startsWith("SV-")) return `<button type="button" class="evidence-chip" data-page="services">${icon("heart-pulse")}${escapeHtml(id)}</button>`;
    if (id.startsWith("DV-")) {
      const device = (state.data.devices || []).find((item) => item.id === id);
      return `<button type="button" class="evidence-chip" ${state.role === "provider" ? 'data-page="devices"' : 'data-page="insight"'}>${icon("radio")}${escapeHtml(device ? `${device.type} ${id}` : id)}</button>`;
    }
    if (/^(WA|CK)-/.test(id)) return `<span class="evidence-chip">${icon("cloud-lightning")}${escapeHtml(id.startsWith("WA-") ? "天气预警" : "报平安")} ${escapeHtml(id.slice(-6))}</span>`;
    if (!/^GX-/.test(id)) return `<span class="evidence-chip">${escapeHtml(id)}</span>`;
    return `<button type="button" class="evidence-chip" data-action="resident-detail" data-id="${escapeHtml(id)}">${icon("user-round")}档案 ${escapeHtml(id.slice(-6))}</button>`;
  }

  function careCard(item) {
    const task = state.role === "provider" ? careTaskFor(item) : null;
    const raised = item.by === "DeepSeek" && item.priority !== item.rule_priority;
    return `<article class="care-card ${item.priority}">
      <header class="care-card-head">
        <span class="cell-avatar">${escapeHtml(String(item.name || "?").slice(-1))}</span>
        <div><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.age)}岁 · ${escapeHtml(item.room)}</small></div>
        <div class="care-card-meta">${riskTag(item.priority)}<small>${CARE_PRIORITY[item.priority]}</small>${raised ? `<b class="ai-found" title="规则判定为${riskLabel(item.rule_priority)}，AI 结合多条信号调整">${icon("bot")}AI ${CARE_RANK[item.priority] > CARE_RANK[item.rule_priority] ? "上调" : "下调"}</b>` : ""}</div>
      </header>
      <p class="care-headline">${escapeHtml(item.headline)}</p>
      ${item.insight ? `<p class="care-insight">${icon("git-merge")}<span><b>AI 看到的关联：</b>${escapeHtml(item.insight)}</span></p>` : ""}
      ${item.actions.length ? `<ol class="care-actions">${item.actions.map((action) => `<li><b>${escapeHtml(action.who)}</b><span>${escapeHtml(action.what)}</span><em>${escapeHtml(action.when)}</em></li>`).join("")}</ol>` : ""}
      <details class="care-signals"><summary>${item.signals.length} 条信号 · 证据 ${item.evidence.length} 项</summary>
        <ul>${item.signals.map((signal) => `<li>${icon(CARE_KIND_ICON[signal.kind] || "dot")}<span>${escapeHtml(signal.text)}</span></li>`).join("")}</ul>
      </details>
      <footer class="care-card-foot">
        <div class="care-evidence">${item.evidence.map(careEvidenceChip).join("")}${item.dropped_ids ? `<small class="care-dropped" title="AI 引用了台账中不存在的编号，已删去">已删去 ${item.dropped_ids} 个不存在的编号</small>` : ""}</div>
        ${state.role === "provider" && item.priority !== "low" ? `<button class="btn ${task ? "btn-secondary" : "btn-primary"} btn-sm" type="button" data-action="care-task" data-id="${escapeHtml(item.id)}"${task ? " disabled" : ""}>${icon(task ? "check" : "clipboard-plus")}${task ? "随访任务已生成" : "生成随访任务"}</button>` : ""}
      </footer>
    </article>`;
  }

  function renderCare() {
    const care = state.care;
    const title = state.role === "provider" ? "今天谁最需要关注" : "辖区重点关注老人";
    const head = `<div class="page-toolbar">
        <div class="page-toolbar-title"><h2>AI 主动预警</h2><p>不等老人开口：每天把快筛、服务记录、事件、外出、类案信号扫一遍，AI 把几条信号连起来看，找出${title}</p></div>
        <div class="toolbar-actions">${care ? `<span class="status-tag neutral">${escapeHtml(care.source)}${state.careScanAt ? ` · ${escapeHtml(state.careScanAt)}` : ""}</span>` : ""}<button class="btn btn-secondary" type="button" data-action="care-refresh"${state.careLoading ? " disabled" : ""}>${icon("refresh-cw")}重新研判</button></div>
      </div>`;
    if (!LOCAL_BACKEND_ENABLED) return `${head}<div class="notice">${icon("info")}AI 主动预警需要通过“启动作品.bat”运行本地完整服务。</div>`;
    if (state.careError && !care) return `${head}<div class="notice warning">${icon("triangle-alert")}${escapeHtml(state.careError)}</div>`;
    if (!care) return `${head}<div class="empty-state">${icon("loader-circle", "spin")}<strong>正在扫描台账信号…</strong></div>`;
    const flagged = care.items.filter((item) => item.priority !== "low");
    const quiet = care.items.filter((item) => item.priority === "low");
    return `${head}
      <div class="stat-grid care-stats">
        ${statCard("今日必须处理", care.counts.high, "位", "siren", "当面查看，不能只打电话", care.counts.high ? "danger" : "positive")}
        ${statCard("今日留意", care.counts.medium, "位", "eye", "安排在今日巡查中", care.counts.medium ? "warning" : "positive")}
        ${statCard("常规照护", care.counts.low, "位", "heart-handshake", `共扫描 ${care.scanned} 位老人`, "positive")}
      </div>
      ${care.pending_ai || state.careLoading ? `<div class="notice care-pending">${icon("loader-circle", "spin")}已先按规则信号排序，DeepSeek 正在把多条信号连起来综合研判…</div>` : ""}
      ${care.note && !care.pending_ai ? `<div class="notice">${icon(care.source.includes("DeepSeek") ? "bot" : "info")}${escapeHtml(care.note)}</div>` : ""}
      <div class="care-list">${flagged.map(careCard).join("")}</div>
      ${quiet.length ? `<section class="panel care-quiet"><strong>常规照护（${quiet.length} 位）</strong><p>${quiet.map((item) => `${escapeHtml(item.name)}：${escapeHtml(item.headline)}`).join("；")}</p></section>` : ""}
      <small class="radar-source">${icon("shield-check")}规则先列出每条信号和证据编号；AI 只能引用这些编号，不能把“超时未归”等规则判定的高危降级；不做医学诊断，结论需人工确认。</small>`;
  }



  function createCareTask(id) {
    const item = (state.care?.items || []).find((entry) => entry.id === id);
    const resident = state.data.residents.find((entry) => entry.id === id);
    if (!item || !resident || careTaskFor(item)) return;
    const first = item.actions[0] || { who: "责任护理员", what: "当面查看并记录状态", when: "今日内" };
    const record = { id: uniqueRecordId("SV"), residentId: resident.id, resident: resident.name, type: CARE_FOLLOW_UP, staff: `${first.who}（待指派）`, time: `今日 ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`, result: `${first.when}：${first.what}（依据 ${item.evidence.join("、")}）`, status: "待执行" };
    state.data.serviceLogs.unshift(record);
    saveData("生成 AI 预警随访任务", "service", record.id);
    showToast("随访任务已生成", `${resident.name}：${first.when}${first.what}，已写入动态台账。`);
    renderPage();
  }

  /* 安全防护设备（13.0）：机构、居家、社区老人的手环、跌倒雷达、烟感、燃气报警器统一接入。
     告警直接生成呼救工单，进入与老人呼救相同的回拨、30秒接单、分级升级流程；居家老人同步通知社区网格员。 */
  const DEVICE_ICONS = { 智能手环: "watch", 跌倒监测雷达: "scan-eye", 燃气泄漏报警器: "flame", 紧急呼叫按钮: "bell-ring", 独立式烟感: "siren", 智能血压计: "activity" };

  function sceneTag(scene) {
    const value = scene || "机构入住";
    return `<span class="scene-tag ${value === "机构入住" ? "" : value === "居家旅居" ? "home" : "community"}">${escapeHtml(value)}</span>`;
  }

  function deviceStatusTag(device) {
    const tone = device.status === "在线" ? "success" : device.status === "离线" ? "danger" : "warning";
    return `<span class="status-tag ${tone}">${escapeHtml(device.status)}${device.status === "低电量" && device.battery != null ? ` ${device.battery}%` : ""}</span>`;
  }

  function renderProviderDevices() {
    const all = state.data.devices || [];
    const devices = state.deviceScene === "all" ? all : all.filter((device) => device.scene === state.deviceScene);
    const offline = all.filter((device) => device.status === "离线");
    const low = all.filter((device) => device.status === "低电量");
    const homeResidents = state.data.residents.filter((resident) => (resident.scene || "机构入住") !== "机构入住");
    const alarms = getSosSessions().filter((session) => String(session.trigger || "").startsWith("设备告警"));
    return `
      <div class="page-toolbar">
        <div class="page-toolbar-title"><h2>安全防护设备</h2><p>机构、居家、社区旅居老人的设备统一接入；告警自动生成呼救工单，走同一套接单与升级流程</p></div>
        <div class="toolbar-actions"><button class="btn btn-secondary" type="button" data-action="refresh-data">${icon("refresh-cw")}刷新</button></div>
      </div>
      <div class="stat-grid">
        ${statCard("接入设备", all.length, "台", "router", `覆盖 ${new Set(all.map((device) => device.residentId)).size} 位老人`, "positive")}
        ${statCard("设备在线率", all.length ? Math.round(100 * (all.length - offline.length) / all.length) : "—", "%", "radio", offline.length ? `${offline.length} 台离线，需排查` : "全部在线", offline.length ? "danger" : "positive")}
        ${statCard("低电量", low.length, "台", "battery-low", low.length ? "提醒老人或家属充电" : "电量正常", low.length ? "warning" : "positive")}
        ${statCard("设备告警工单", alarms.length, "单", "siren", `${alarms.filter((session) => SOS_ACTIVE_STATUSES.has(session.status)).length} 单响应中`, alarms.some((session) => SOS_ACTIVE_STATUSES.has(session.status)) ? "danger" : "positive")}
      </div>
      ${renderSosQueuePanel("provider")}
      ${offline.length ? `<section class="notice warning device-offline-note">${icon("wifi-off")}<span><strong>${offline.map((device) => `${escapeHtml(device.resident)}的${escapeHtml(device.type)}`).join("、")}已离线</strong>（最后在线 ${offline.map((device) => escapeHtml(device.lastSeen)).join("、")}）。离线设备收不到告警，已计入 AI 主动预警；若老人正在外出，按失联风险处置。</span></section>` : ""}
      <section class="panel">
        <div class="panel-header"><div class="section-head-copy"><h3>居家与社区旅居老人 <span class="muted-inline">${homeResidents.length}人</span></h3><p>机构上门服务，社区网格员共同照看</p></div></div>
        <div class="table-wrap"><table class="data-table"><thead><tr><th>老人</th><th>居住场景</th><th>住址</th><th>社区对接人</th><th>已接入设备</th><th>快筛</th></tr></thead><tbody>
          ${homeResidents.map((resident) => `<tr><td>${residentCell(resident)}</td><td>${sceneTag(resident.scene)}${resident.livingAlone ? ` <span class="status-tag warning">独居</span>` : ""}</td><td>${escapeHtml(resident.address || resident.room)}</td><td>${escapeHtml(resident.gridWorker || "待登记")}<small class="meta-text">${escapeHtml(resident.gridPhone || "")}</small></td><td>${all.filter((device) => device.residentId === resident.id).map((device) => `<span class="type-tag">${escapeHtml(device.type)}</span>`).join(" ") || "未接入"}</td><td>${resident.screening ? screeningStatusTag(resident.screening) : statusTag("未评估")}</td></tr>`).join("") || `<tr><td colspan="6"><div class="empty-state compact">${icon("house")}<strong>暂无居家或社区老人</strong></div></td></tr>`}
        </tbody></table></div>
      </section>
      <section class="panel">
        <div class="panel-header"><div class="section-head-copy"><h3>设备清单 <span class="muted-inline">${devices.length}台</span></h3></div><div class="filter-row"><select id="device-scene" class="form-control filter-control" aria-label="居住场景筛选"><option value="all">全部场景</option>${["机构入住", "居家旅居", "社区嵌入"].map((scene) => `<option value="${scene}" ${state.deviceScene === scene ? "selected" : ""}>${scene}</option>`).join("")}</select></div></div>
        <div class="table-wrap"><table class="data-table"><thead><tr><th>设备</th><th>老人 / 场景</th><th>安装位置</th><th>状态</th><th>最近在线</th><th>告警内容</th><th>操作</th></tr></thead><tbody>
          ${devices.map((device) => `<tr><td><div class="cell-main"><span class="cell-avatar device-avatar">${icon(DEVICE_ICONS[device.type] || "cpu")}</span><span class="cell-copy"><strong>${escapeHtml(device.type)}</strong><small>${escapeHtml(device.id)}</small></span></div></td><td><div class="cell-copy"><strong>${escapeHtml(device.resident)}</strong><small>${sceneTag(device.scene)}</small></div></td><td>${escapeHtml(device.location)}</td><td>${deviceStatusTag(device)}</td><td>${escapeHtml(device.lastSeen)}</td><td>${escapeHtml(device.alarm)}</td><td><button class="text-btn" type="button" data-action="device-alarm" data-id="${device.id}"${device.status === "离线" ? ' disabled title="设备离线，收不到告警"' : ""}>${icon("siren")}模拟告警</button></td></tr>`).join("") || `<tr><td colspan="7"><div class="empty-state compact">${icon("search-x")}<strong>该场景暂无设备</strong></div></td></tr>`}
        </tbody></table></div>
      </section>
      <section class="panel review-note-panel"><div class="notice">${icon("plug-zap")}<span>接入方式：设备厂商网关调用 <code>POST /api/device-alarm</code>（请求头 <code>X-Device-Token</code>，令牌由环境变量 <code>GUIYANG_DEVICE_TOKEN</code> 配置），服务器校验设备登记后生成呼救工单并写入审计。同一老人已有进行中的工单时只追加时间线，不重复派单。设备与告警均为演示样本，未接入真实厂商平台。</span></div></section>
    `;
  }

  async function simulateDeviceAlarm(id) {
    const device = (state.data.devices || []).find((item) => item.id === id);
    if (!device) return;
    if (device.status === "离线") { showToast("设备离线", "离线设备收不到告警，请先排查设备。", "warning"); return; }
    if (state.backend.enabled) {
      try {
        const response = await fetch("/api/device-alarm", { method: "POST", headers: authHeaders(true), body: JSON.stringify({ deviceId: id }) });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "device_alarm_failed");
        applySosUpdate(payload.sessions || [payload.session]);
        ensureSosTicker();
        showToast(payload.created ? "设备告警已生成呼救工单" : "已追加到进行中的工单", `${device.resident} · ${device.alarm}`, "warning");
        renderPage();
      } catch (error) {
        showToast("告警上报失败", "本地服务暂不可用，请稍后重试。", "warning");
      }
      return;
    }
    // 离线演示：在本机生成同结构的工单
    const resident = state.data.residents.find((item) => item.id === device.residentId) || { id: device.residentId, name: device.resident };
    const note = `${device.type}（${device.id}，${device.location}）：${device.alarm}`;
    const active = activeSosFor(resident.id);
    if (active) {
      pushSosTimeline(active, `设备再次告警：${note}`);
      saveSos("设备告警追加到进行中工单", active.id);
      showToast("已追加到进行中的工单", `${resident.name} · ${device.alarm}`, "warning");
      renderPage();
      return;
    }
    const duty = currentDutyStaff();
    const home = (resident.scene || "机构入住") !== "机构入住";
    const session = {
      id: uniqueRecordId("SOS"), residentId: resident.id, resident: resident.name, residentPhone: "", institution: resident.institution || state.data.profile.institution,
      location: `${home ? resident.address || resident.room : `${resident.institution || ""} · ${resident.room || ""}`} · ${device.location}`, trigger: `设备告警·${device.type}`, transcript: "", deviceId: device.id, scene: resident.scene || "机构入住",
      riskLevel: "high", status: "waiting", escalation: 1, createdAt: Date.now(), createdLabel: `今日 ${sosClock().slice(0, 5)}`, resolvedLabel: "",
      callback: { status: "dialing", attempts: 1, startedAt: Date.now() }, claimedBy: "", responseSeconds: null, notified: { manager: false, family: false, regulator: false },
      dutyShift: `${duty.shift} · ${duty.name}`,
      contacts: [{ role: duty.title || "机构值班员", name: duty.name, phone: duty.phone, shift: duty.shift }, ...(home && resident.gridWorker ? [{ role: "社区网格员", name: resident.gridWorker, phone: resident.gridPhone || "" }] : []), { role: "机构负责人", name: "黄志强", phone: "137****2214" }, { role: "紧急联系人", name: resident.emergencyName || "家属", phone: resident.emergencyPhone || "" }],
      linkedEventId: "",
      timeline: [{ time: sosClock(), text: `设备告警接入：${note}`, state: "done" }, { time: sosClock(), text: `平台受理，开始自动回拨并推送值班响应队列${home ? "，同步通知社区网格员" : ""}`, state: "current" }]
    };
    getSosSessions().unshift(session);
    ensureSosTicker();
    saveSos("设备告警生成呼救工单", session.id);
    showToast("设备告警已生成呼救工单", `${resident.name} · ${device.alarm}`, "warning");
    renderPage();
  }

  /* 运行态势研判（13.0）：人群结构、风险按场景分布、出境与跨市行程、设备在线、按台账计算的机构服务质量评价。 */
  async function loadInsight(force = false) {
    if (!LOCAL_BACKEND_ENABLED || (state.insightLoading && !force)) return;
    state.insightLoading = true;
    try {
      const response = await fetch("/api/insight", { cache: "no-store", headers: authHeaders() });
      if (!response.ok) throw new Error("insight_unavailable");
      state.insight = await response.json();
      state.insightError = "";
    } catch (error) {
      state.insightError = "态势研判服务暂不可用";
    }
    state.insightLoading = false;
    if (state.role === "regulator" && ["insight", "institutions", "dashboard"].includes(state.page)) renderPage();
  }

  function evidenceChip(id) {
    const value = String(id || "");
    if (/^EV-/.test(value) && getEvent(value)) return `<button class="evidence-chip" type="button" data-action="event-detail" data-id="${escapeHtml(value)}">${escapeHtml(value)}</button>`;
    if (/^MV-/.test(value) && getMovementLogs().some((log) => log.id === value)) return `<button class="evidence-chip" type="button" data-action="movement-detail" data-id="${escapeHtml(value)}">${escapeHtml(value)}</button>`;
    if (/^IN-/.test(value)) return `<button class="evidence-chip" type="button" data-action="institution-detail" data-id="${escapeHtml(value)}">${escapeHtml(value)}</button>`;
    return `<span class="evidence-chip">${escapeHtml(value)}</span>`;
  }

  function insightBars(entries, total, tone = "") {
    return `<div class="bar-chart">${entries.map(([label, count]) => `<div class="bar-row"><span>${escapeHtml(label)}</span><span class="bar-track"><span class="bar-fill ${tone}" style="width:${total ? Math.round(100 * count / total) : 0}%"></span></span><strong>${count}<small> 人</small></strong></div>`).join("")}</div>`;
  }

  function renderRegulatorInsight() {
    if (!LOCAL_BACKEND_ENABLED) return `<div class="empty-state">${icon("chart-no-axes-combined")}<strong>态势研判需要本地完整服务</strong><p>请用“启动作品.bat”或 python server.py 启动后访问。</p></div>`;
    if (!state.insight) {
      if (!state.insightLoading && !state.insightError) loadInsight();
      return `<div class="empty-state">${icon(state.insightError ? "circle-alert" : "loader")}<strong>${state.insightError || "正在按台账计算运行态势…"}</strong>${state.insightError ? `<button class="btn btn-secondary" type="button" data-action="insight-refresh">${icon("refresh-cw")}重试</button>` : ""}</div>`;
    }
    const x = state.insight;
    const scenes = Object.entries(x.population.scenes);
    const regions = Object.entries(x.population.regions);
    const sceneOrder = ["涉诈", "老年消费", "边境", "出行", "居家社区安全", "机构服务"];
    const byScene = sceneOrder.filter((key) => x.events.by_scene[key]).map((key) => [key, x.events.by_scene[key]]);
    const levelTone = { high: "danger", medium: "warning", low: "neutral" };
    return `
      <div class="page-toolbar">
        <div class="page-toolbar-title"><h2>运行态势研判</h2><p>按台账实时计算，每个数字都能追到原始记录</p></div>
        <div class="toolbar-actions action-grid"><button class="btn btn-secondary" type="button" data-action="insight-refresh">${icon("refresh-cw")}重新计算</button><button class="btn btn-primary" type="button" data-action="insight-ask-ai">${icon("bot")}让 AI 参谋研判</button></div>
      </div>
      <div class="stat-grid">
        ${statCard("已建档旅居老人", x.population.total, "人", "users-round", `机构入住 ${x.population.scenes["机构入住"] || 0} · 居家 ${x.population.scenes["居家旅居"] || 0} · 社区 ${x.population.scenes["社区嵌入"] || 0}`)}
        ${statCard("未办结事件", x.events.open, "件", "siren", `${x.events.high_open} 件高风险`, x.events.high_open ? "danger" : "positive")}
        ${statCard("跨市 / 出境行程", `${x.movements.cross_city} / ${x.movements.border.length}`, "条", "earth", x.movements.overdue.length ? `${x.movements.overdue.length} 条超时未归` : "暂无超时", x.movements.overdue.length ? "danger" : "warning")}
        ${statCard("安全设备在线率", x.devices.online_rate ?? "—", "%", "radio", `${x.devices.offline.length} 台离线 · ${x.devices.low_battery.length} 台低电量`, x.devices.offline.length ? "warning" : "positive")}
      </div>
      ${x.weather?.total ? `<div class="notice mt-4 mb-4">${icon("cloud-lightning")}模拟天气预警报平安率 ${x.weather.rate}%（${x.weather.responded}/${x.weather.total}）；未回应 ${x.weather.pending} 位，其中超时待跟进 ${x.weather.overdue} 位、请求帮助 ${x.weather.help} 位。</div>` : ""}
      <section class="panel">
        <header class="panel-header"><div class="section-head-copy"><h3>研判要点</h3><p>点编号可查看原始记录</p></div><span class="status-tag neutral">不调用大模型</span></header>
        <div class="panel-body"><div class="list-stack insight-findings">${x.findings.map((item) => `<div class="list-item"><span class="list-icon ${levelTone[item.level] || "neutral"}">${icon(item.level === "high" ? "circle-alert" : item.level === "medium" ? "triangle-alert" : "info")}</span><div class="list-content"><strong>${escapeHtml(item.text)}</strong><p class="evidence-row">${item.evidence.map(evidenceChip).join("")}</p></div></div>`).join("") || `<div class="empty-state compact">${icon("badge-check")}<strong>暂无需要关注的态势</strong></div>`}</div></div>
      </section>
      <div class="panel-grid equal mt-4">
        <section class="panel">
          <header class="panel-header"><div class="section-head-copy"><h3>人群结构</h3><p>居住场景与客源地</p></div></header>
          <div class="panel-body"><h4 class="mini-heading">居住场景（平台已建档 ${x.population.total} 人）</h4>${insightBars(scenes, x.population.total)}<h4 class="mini-heading">客源地</h4>${insightBars(regions, x.population.total, "alt")}<div class="notice mt-4">${icon("info")}独居 ${x.population.living_alone} 人。比例只按平台已建档的 ${x.population.total} 人计算；机构自报在住 ${x.reconcile ? x.reconcile.reported : x.institutions.reported_residents} 人另列于下方核对表，核对前不计算覆盖率。</div></div>
        </section>
        <section class="panel">
          <header class="panel-header"><div class="section-head-copy"><h3>风险按场景分布</h3></div></header>
          <div class="table-wrap"><table class="data-table"><thead><tr><th>场景</th><th>事件</th><th>未办结</th><th>高风险未办结</th><th>编号</th></tr></thead><tbody>
            ${byScene.map(([key, value]) => `<tr><td class="nowrap"><strong>${escapeHtml(key)}</strong></td><td>${value.total}</td><td>${value.open}</td><td>${value.high_open ? `<span class="status-tag danger">${value.high_open}</span>` : "0"}</td><td class="evidence-row">${value.ids.slice(0, 2).map(evidenceChip).join("")}</td></tr>`).join("")}
          </tbody></table></div>
        </section>
      </div>
      ${x.reconcile ? `<section class="panel mt-4 reconcile-panel">
        <header class="panel-header"><div class="section-head-copy"><h3>建档与机构填报核对</h3><p>${escapeHtml(x.reconcile.note)}</p></div><span class="status-tag ${x.reconcile.pending ? "warning" : "success"}">${x.reconcile.pending ? `${x.reconcile.pending} 家待核对` : "已一致"}</span></header>
        <div class="table-wrap"><table class="data-table"><thead><tr><th>机构</th><th class="num">机构填报在住</th><th class="num">平台已建档</th><th>建档构成</th><th class="num">差额</th><th>核对状态</th></tr></thead><tbody>
          ${x.reconcile.rows.map((row) => `<tr><td><strong>${escapeHtml(row.name)}</strong><small class="meta-text">${escapeHtml(row.city)} · ${escapeHtml(row.id)}</small></td><td class="num">${row.reported}</td><td class="num">${row.registered}</td><td class="nowrap"><small class="meta-text">入住 ${row.scenes["机构入住"]} · 居家 ${row.scenes["居家旅居"]} · 社区 ${row.scenes["社区嵌入"]}</small></td><td class="num">${row.gap}</td><td>${statusTag(row.status === "一致" ? "已核验" : "待核对")}</td></tr>`).join("")}
          <tr class="total-row"><td><strong>合计</strong></td><td class="num"><strong>${x.reconcile.reported}</strong></td><td class="num"><strong>${x.reconcile.registered}</strong></td><td></td><td class="num"><strong>${x.reconcile.gap}</strong></td><td></td></tr>
        </tbody></table></div>
      </section>` : ""}
      <section class="panel mt-4">
        <header class="panel-header"><div class="section-head-copy"><h3>机构服务质量评价</h3><p>按台账逐项扣分，每项附证据编号；投诉同时给出每百位建档老人的发生率，便于不同规模机构比较</p></div><details class="rule-details"><summary>评分规则</summary><p>${escapeHtml(x.quality_rule)}。权重为演示设置，需试点校准。</p>${x.sos?.rule ? `<p>${escapeHtml(x.sos.rule)}</p>` : ""}</details></header>
        <div class="table-wrap"><table class="data-table quality-table"><thead><tr><th>机构</th><th>计算得分</th><th>填报参考分</th><th>扣分依据</th><th>关键指标</th></tr></thead><tbody>
          ${x.quality.map((row) => `<tr><td><strong>${escapeHtml(row.name)}</strong><small class="meta-text">${escapeHtml(row.city)} · ${escapeHtml(row.id)}</small></td><td>${row.sufficient ? `<strong class="quality-score">${row.score}</strong> <span class="status-tag ${row.grade === "需督导" ? "danger" : row.grade === "中" ? "warning" : "success"}">${escapeHtml(row.grade)}</span>` : `<span class="status-tag neutral">样本不足</span><small class="meta-text">${escapeHtml(row.note)}</small>`}</td><td>${escapeHtml(row.reference_score ?? "—")}</td><td>${row.deductions.map((item) => `<div class="deduction"><span>${escapeHtml(item.item)} ×${item.count}</span><b>−${item.points}</b><span class="evidence-row">${item.evidence.slice(0, 3).map(evidenceChip).join("")}</span></div>`).join("") || "—"}</td><td>${Object.entries(row.metrics).map(([key, value]) => `<small class="meta-text">${escapeHtml(key)}：${escapeHtml(value)}</small>`).join("") || "—"}</td></tr>`).join("")}
        </tbody></table></div>
      </section>
    `;
  }

  const pageRenderers = {
    elder: { dashboard: renderElderDashboard, profile: renderElderProfile, check: renderElderCheck, requests: renderElderRequests },
    provider: { dashboard: renderProviderDashboard, care: renderCare, residents: renderProviderResidents, services: renderProviderServices, devices: renderProviderDevices, alerts: renderProviderAlerts },
    regulator: { dashboard: renderRegulatorDashboard, radar: renderRegulatorRadar, advisor: renderRegulatorAdvisor, insight: renderRegulatorInsight, care: renderCare, monitoring: renderRegulatorMonitoring, movements: renderRegulatorMovements, institutions: renderRegulatorInstitutions, events: renderRegulatorEvents }
  };

  function bindPageEvents() {
    const residentQuery = document.getElementById("resident-query");
    if (residentQuery) {
      residentQuery.addEventListener("input", (event) => { state.residentQuery = event.target.value; });
      residentQuery.addEventListener("keydown", (event) => { if (event.key === "Enter") renderPage(); });
      residentQuery.addEventListener("change", renderPage);
    }
    const residentRisk = document.getElementById("resident-risk");
    if (residentRisk) residentRisk.addEventListener("change", (event) => { state.residentRisk = event.target.value; renderPage(); });
    const institutionQuery = document.getElementById("institution-query");
    if (institutionQuery) {
      institutionQuery.addEventListener("input", (event) => { state.institutionQuery = event.target.value; });
      institutionQuery.addEventListener("keydown", (event) => { if (event.key === "Enter") renderPage(); });
      institutionQuery.addEventListener("change", renderPage);
    }
    const eventLevel = document.getElementById("event-level");
    if (eventLevel) eventLevel.addEventListener("change", (event) => { state.eventLevel = event.target.value; renderPage(); });
    const eventStatus = document.getElementById("event-status");
    if (eventStatus) eventStatus.addEventListener("change", (event) => { state.eventStatus = event.target.value; renderPage(); });
    const movementStatus = document.getElementById("movement-status");
    if (movementStatus) movementStatus.addEventListener("change", (event) => { state.movementStatus = event.target.value; renderPage(); });
    const movementConfirm = document.getElementById("movement-confirm");
    if (movementConfirm) movementConfirm.addEventListener("change", (event) => { state.movementConfirm = event.target.value; renderPage(); });
    const providerLevel = document.getElementById("provider-alert-level");
    if (providerLevel) providerLevel.addEventListener("change", (event) => {
      state.eventLevel = event.target.value;
      renderPage();
    });
    const deviceScene = document.getElementById("device-scene");
    if (deviceScene) deviceScene.addEventListener("change", (event) => { state.deviceScene = event.target.value; renderPage(); });
    const checkForm = document.getElementById("daily-check-form");
    if (checkForm) checkForm.addEventListener("submit", submitDailyCheck);
  }

  function submitDailyCheck(event) {
    event.preventDefault();
    const form = new FormData(event.target);
    const missing = DAILY_CHECK_FIELDS.filter(([name, , options]) => !options.includes(String(form.get(name) || ""))).map(([, label]) => label);
    if (missing.length) return showToast("还有问题没有选", `请点一下：${missing.join("、")}`, "warning");
    const entry = {
      date: new Date().toLocaleDateString("sv-SE"),
      sleep: String(form.get("sleep")),
      appetite: String(form.get("appetite")),
      mood: String(form.get("mood")),
      mobility: String(form.get("mobility")),
      note: String(form.get("note") || "").trim().slice(0, 120),
      status: "已完成"
    };
    const previous = state.data.dailyChecks.find((item) => item.date !== entry.date);
    state.data.dailyChecks = [entry, ...state.data.dailyChecks.filter((item) => item.date !== entry.date)];
    state.data.profile.lastCheck = "刚刚";
    saveData("提交老人状态打卡", "daily_check", entry.date);
    // 与服务端 care.daily_check_concern 同一规则：今天有重的异常，或连续两次都有异常，机构会收到关怀提醒
    const odd = checkIsAbnormal;
    const serious = ["较差", "低落", "行动困难"].some((value) => Object.keys(DAILY_CHECK_ABNORMAL).some((key) => entry[key] === value));
    if (odd(entry) && (serious || odd(previous))) showToast("已告诉机构", "今天护理员会来当面看看您；不舒服加重请直接点“一键呼救”。", "success");
    else showToast("今日状态已提交", odd(entry) ? "已记下，明天再打卡时我们会留意变化。" : "今天状态不错，继续保持。");
    renderPage();
  }

  function openHealthScan() {
    openModal({
      title: "摄像头模拟流程（非生理测量）",
      subtitle: "仅做非诊断性风险提示，结果不会替代医生判断",
      body: `
        <div class="notice">${icon("shield-check")}请在光线均匀、本人同意的情况下使用。原始视频默认只在当前设备处理，不上传平台。</div>
        <div class="camera-stage mt-3" id="camera-stage">
          <video id="camera-video" autoplay muted playsinline hidden></video>
          <div class="camera-placeholder" id="camera-placeholder">${icon("scan-face")}<strong>摄像头尚未开启</strong><span>点击下方按钮开始本次筛查</span></div>
          <div class="scan-frame" hidden></div>
        </div>
        <div id="scan-progress-wrap" class="scan-progress" hidden><div class="progress-track"><div id="scan-progress" class="progress-bar" style="width:0%"></div></div><small id="scan-progress-label" class="meta-text">正在分析...</small></div>
        <div id="scan-result" hidden class="mt-3">
          <div class="notice warning">${icon("flask-conical")}原型演示结果：本版尚未接入医疗级 rPPG 算法，以下数值用于展示后续接入后的业务流程，不作为真实测量结果。</div>
          <div class="result-grid mt-3"><div class="result-item"><strong>72</strong><span>演示心率趋势 bpm</span></div><div class="result-item"><strong>16</strong><span>演示呼吸趋势 次/分</span></div><div class="result-item"><strong>轻度</strong><span>演示疲劳风险</span></div></div>
          <div class="notice mt-3">${icon("info")}建议：午后复测血压，保持饮水；若出现持续头晕或胸闷，请联系机构护士。</div>
        </div>
      `,
      footer: `<button class="btn btn-secondary" type="button" data-action="enable-camera">${icon("camera")}开启摄像头</button><button class="btn btn-primary" type="button" data-action="start-scan" disabled>${icon("bot")}查看模拟流程</button>`,
      onOpen: () => {
        const modal = modalRoot.querySelector(".modal");
        modal.dataset.scanReady = "false";
      }
    });
  }

  async function enableCamera() {
    const video = document.getElementById("camera-video");
    const placeholder = document.getElementById("camera-placeholder");
    const frame = modalRoot.querySelector(".scan-frame");
    const start = modalRoot.querySelector('[data-action="start-scan"]');
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("unavailable");
      state.activeStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
      video.srcObject = state.activeStream;
      video.hidden = false;
      placeholder.hidden = true;
      frame.hidden = false;
      start.disabled = false;
      showToast("摄像头已开启", "请保持面部处于取景框内。", "success");
    } catch (error) {
      placeholder.innerHTML = `${icon("scan-face")}<strong>演示模式已就绪</strong><span>当前未开启摄像头权限，可直接进行模拟筛查</span>`;
      refreshIcons();
      start.disabled = false;
      showToast("未取得摄像头权限", "已切换为演示模式，不采集真实视频。", "warning");
    }
  }

  function startHealthScan() {
    const start = modalRoot.querySelector('[data-action="start-scan"]');
    const enable = modalRoot.querySelector('[data-action="enable-camera"]');
    const progressWrap = document.getElementById("scan-progress-wrap");
    const progress = document.getElementById("scan-progress");
    const label = document.getElementById("scan-progress-label");
    const result = document.getElementById("scan-result");
    if (!start || !progressWrap) return;
    start.disabled = true;
    if (enable) enable.disabled = true;
    progressWrap.hidden = false;
    let value = 0;
    const timer = window.setInterval(() => {
      value += 10;
      progress.style.width = `${value}%`;
      label.textContent = value < 100 ? `模拟流程演示 ${value}%` : "模拟流程完成";
      if (value >= 100) {
        window.clearInterval(timer);
        result.hidden = false;
        showToast("模拟流程结束", "显示的是固定样本，不是生理测量结果。", "warning");
      }
    }, 170);
  }

  function openAiVideoAssistant() {
    try { state.aiHistory = JSON.parse(sessionStorage.getItem(AI_HISTORY_KEY) || "[]").slice(-12); }
    catch (error) { state.aiHistory = []; }
    state.lastAiResult = null;
    state.aiProvider = "";
    const opener = `${elderHonorific()}${elderGreeting()}，我是小桂。想出门走走、有人让您交钱，或者遇到不顺心的事，直接跟我说就行。`;
    openModal({
      title: "和小桂视频说话",
      wide: true,
      body: `
        <div class="va">
          <section class="va-call" aria-label="视频对话">
            <div id="va-stage" class="va-stage" data-cam="starting">
              <video id="ai-video" autoplay muted playsinline hidden></video>
              <div id="ai-video-placeholder" class="va-placeholder"><span class="va-face" aria-hidden="true">桂</span><strong>正在打开画面</strong><small>画面只在这台设备上显示，不上传</small></div>
              <div class="va-top"><span class="va-live"><i></i>视频对话 <b id="va-timer">00:00</b></span><span class="va-local">${icon("shield-check")}仅本机显示</span></div>
              <div id="va-xg" class="va-xg" data-state="idle"><span aria-hidden="true">桂</span><small>小桂</small></div>
              <div id="va-caption" class="va-caption" data-who="xg" aria-live="polite"><em>小桂</em><p>${escapeHtml(opener)}</p></div>
            </div>
            <div class="va-controls" aria-label="通话按键">
              <button id="ai-camera-btn" class="va-ctl" type="button" data-action="toggle-ai-camera" aria-pressed="false">${icon("video-off")}<span>开画面</span></button>
              <button id="ai-mic-btn" class="va-ctl va-talk" type="button" data-action="start-ai-speech" aria-label="开始说话">${icon("mic")}<span>按一下说话</span></button>
              <button class="va-ctl" type="button" data-action="speech-toggle" aria-pressed="${autoSpeakEnabled()}" hidden>${speechToggleLabel(true)}</button>
              <button class="va-ctl va-end" type="button" data-action="close-modal" aria-label="结束对话">${icon("phone-off")}<span>结束</span></button>
            </div>
            <p id="speech-status" class="va-status">点“按一下说话”，或者在右边打字</p>
          </section>
          <section class="va-chat" aria-label="对话记录">
            <header class="va-chat-head"><h3>对话记录</h3><p id="ai-api-status" class="api-pill checking"><span></span>正在连接小桂</p></header>
            <div id="ai-chat-log" class="chat-log" aria-live="polite">
              <div class="chat-bubble assistant" data-speech="${escapeHtml(opener)}">${assistantBubbleHtml(opener)}</div>
            </div>
            <form id="ai-chat-form" class="ai-composer">
              <textarea id="ai-dialog-input" rows="2" placeholder="也可以在这里打字" aria-label="输入对话内容" required></textarea>
              <button id="ai-send-btn" class="btn btn-primary" type="submit">${icon("send")}发送</button>
            </form>
          </section>
        </div>
      `,
      onOpen: () => {
        const firstVisit = !state.aiHistory.length;
        state.aiHistory.forEach((item) => {
          let shown = item.content;
          if (item.role === "assistant") { try { shown = JSON.parse(item.content).summary || shown; } catch (error) { /* 旧版对话摘要 */ } }
          if (item.role === "user" || item.role === "assistant") appendAiBubble(item.role, shown);
        });
        // 常问问题放在对话末尾，发出第一句话后收起
        const log = document.getElementById("ai-chat-log");
        if (LOCAL_BACKEND_ENABLED && log) log.insertAdjacentHTML("beforeend", `<div class="ai-suggestions" aria-label="常有人这样问"><span>常有人这样问</span>${ELDER_ASK_EXAMPLES.map((text) => `<button type="button" data-action="ai-suggest" data-text="${escapeHtml(text)}">${escapeHtml(text)}</button>`).join("")}</div>`);
        if (log) log.scrollTop = log.scrollHeight;
        syncSpeakButtons();
        document.getElementById("ai-chat-form").addEventListener("submit", (event) => {
          event.preventDefault();
          sendAiMessage(document.getElementById("ai-dialog-input").value);
        });
        checkAiServiceStatus();
        startCallTimer();
        startAiCamera(true);
        if (firstVisit) speakBubble(log?.querySelector(".chat-bubble.assistant"));  // 像接通视频一样先打个招呼
      }
    });
  }

  function startCallTimer() {
    if (state.callTimer) window.clearInterval(state.callTimer);
    const started = Date.now();
    state.callTimer = window.setInterval(() => {
      const node = document.getElementById("va-timer");
      if (!node) { window.clearInterval(state.callTimer); state.callTimer = null; return; }
      const seconds = Math.floor((Date.now() - started) / 1000);
      node.textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
    }, 1000);
  }

  async function checkAiServiceStatus() {
    const status = document.getElementById("ai-api-status");
    if (!status) return;
    try {
      const response = await fetch("/api/status", { cache: "no-store" });
      if (!response.ok) throw new Error("status_unavailable");
      const data = await response.json();
      if (data.configured) {
        status.className = "api-pill connected";
        status.innerHTML = "<span></span>小桂已就绪 · 查证后给建议";
        status.title = `模型：${data.model}${data.model_adjusted ? "（已纠正模型名）" : ""}`;
      } else {
        status.className = "api-pill fallback";
        status.innerHTML = "<span></span>大模型未连接 · 先按本地规则帮您";
      }
    } catch (error) {
      status.className = "api-pill fallback";
      status.innerHTML = location.hostname.endsWith("github.io")
        ? "<span></span>在线安全分流已启用"
        : "<span></span>请从“启动作品.bat”打开 · 安全分流已启用";
    }
  }

  function showCameraOff(title, detail) {
    const stage = document.getElementById("va-stage");
    const placeholder = document.getElementById("ai-video-placeholder");
    const button = document.getElementById("ai-camera-btn");
    if (stage) stage.dataset.cam = "off";
    if (placeholder) {
      const mode = document.getElementById("va-xg")?.dataset.state;
      placeholder.hidden = false;
      placeholder.dataset.title = "小桂在这儿";
      placeholder.innerHTML = `<span class="va-face" aria-hidden="true">桂</span><strong>${escapeHtml({ listening: "小桂在听您说", thinking: "小桂正在帮您查", speaking: "小桂正在说" }[mode] || "小桂在这儿")}</strong><small>${escapeHtml(title)}：${escapeHtml(detail)}</small>`;
    }
    if (button) {
      button.setAttribute("aria-pressed", "false");
      button.innerHTML = `${icon("video-off")}<span>开画面</span>`;
    }
    refreshIcons();
  }

  async function startAiCamera(quiet = false) {
    const video = document.getElementById("ai-video");
    const placeholder = document.getElementById("ai-video-placeholder");
    if (!video || !placeholder) return;
    if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) {
      showCameraOff("这台设备开不了画面", "可以直接说话或打字，小桂照样帮您");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
      if (!document.getElementById("ai-video")) { stream.getTracks().forEach((track) => track.stop()); return; }  // 对话框已经关了
      state.activeStream = stream;
      video.srcObject = stream;
      video.hidden = false;
      placeholder.hidden = true;
      const stage = document.getElementById("va-stage");
      if (stage) stage.dataset.cam = "on";
      const button = document.getElementById("ai-camera-btn");
      if (button) {
        button.setAttribute("aria-pressed", "true");
        button.innerHTML = `${icon("video")}<span>关画面</span>`;
      }
      refreshIcons();
    } catch (error) {
      showCameraOff("画面没有打开", error && error.name === "NotAllowedError" ? "浏览器没允许用摄像头。可以直接说话或打字" : "没找到摄像头。可以直接说话或打字");
      if (!quiet) showToast("摄像头未开启", "点地址栏的摄像头图标改成“允许”；不开画面也能说话或打字。", "warning");
    }
  }

  function stopAiCamera() {
    if (state.activeStream) {
      state.activeStream.getTracks().forEach((track) => track.stop());
      state.activeStream = null;
    }
    const video = document.getElementById("ai-video");
    if (video) { video.srcObject = null; video.hidden = true; }
    showCameraOff("画面已关闭", "点下面的“开画面”可以重新打开");
  }

  async function toggleAiCamera() {
    if (state.activeStream) stopAiCamera();
    else await startAiCamera(false);
  }

  function isEmbeddedSpeechBrowser() {
    const agent = String(navigator.userAgent || "").toLowerCase();
    return /baidubrowser|baiduboxapp|micromessenger|qqbrowser|mqqbrowser|ucbrowser|quark/.test(agent);
  }

  function speechErrorCopy(errorCode) {
    const embedded = isEmbeddedSpeechBrowser();
    const messages = {
      "not-allowed": ["麦克风权限未开启", CAN_PLACE_CALL ? "请在浏览器网站设置和手机应用权限中允许麦克风。" : "点地址栏里的麦克风或锁形图标，把麦克风改为“允许”后刷新页面；仍不行请打开 Windows 设置 → 隐私和安全性 → 麦克风，开启“允许桌面应用访问麦克风”。也可以直接打字。"],
      "service-not-allowed": ["浏览器禁止了语音服务", embedded ? "请复制网址到系统Chrome或Edge打开。" : "请检查浏览器语音服务和网站权限。"],
      "audio-capture": ["未检测到可用麦克风", CAN_PLACE_CALL ? "请关闭占用麦克风的应用，或检查手机麦克风权限。" : "请插上耳麦或带麦克风的摄像头，并在 Windows 声音设置里选中它；也可以直接打字。"],
      network: ["语音服务连接失败", embedded ? "当前内置浏览器兼容性不足，请用系统Chrome或Edge打开。" : "请检查网络后重试，也可以使用键盘语音输入。"],
      "no-speech": ["暂时没有听清", "请靠近麦克风慢慢说，或直接在输入框中描述问题。"],
      aborted: ["语音识别已停止", "可以再次点击麦克风重试。"],
      "language-not-supported": ["当前浏览器不支持中文识别", "请使用系统Chrome或Edge，或使用键盘语音输入。"],
    };
    return messages[errorCode] || ["语音识别未完成", embedded ? "当前内置浏览器兼容性不足，请用系统Chrome或Edge打开。" : "可以重试，或使用键盘语音输入。"];
  }

  async function startAiSpeech() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const input = document.getElementById("ai-dialog-input");
    const status = document.getElementById("speech-status");
    const button = document.getElementById("ai-mic-btn");
    if (!SpeechRecognition) {
      const detail = isEmbeddedSpeechBrowser()
        ? "当前内置浏览器不支持网页语音，请用系统Chrome或Edge打开，或点击输入框使用键盘麦克风。"
        : "当前浏览器不支持网页语音，请点击输入框使用键盘麦克风。";
      status.textContent = detail;
      showToast("网页语音不可用", detail, "warning");
      input.focus();
      return;
    }

    if (!window.isSecureContext) {
      status.textContent = "麦克风需要通过HTTPS安全网址使用";
      showToast("当前网址不安全", "请通过HTTPS站点或本机localhost打开。", "warning");
      input.focus();
      return;
    }

    if (state.speechRecognition) {
      state.speechRecognition.stop();
      return;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      status.textContent = "当前浏览器无法申请麦克风权限";
      showToast("麦克风不可用", "请使用系统Chrome或Edge，或点击输入框使用键盘麦克风。", "warning");
      input.focus();
      return;
    }

    try {
      const permissionStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      permissionStream.getTracks().forEach((track) => track.stop());
    } catch (error) {
      const code = error && (error.name === "NotAllowedError" || error.name === "SecurityError")
        ? "not-allowed"
        : error && error.name === "NotFoundError"
          ? "audio-capture"
          : "unknown";
      const [title, detail] = speechErrorCopy(code);
      status.textContent = detail;
      showToast(title, detail, "warning");
      input.focus();
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = "zh-CN";
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    state.speechRecognition = recognition;
    button.classList.add("listening");
    button.innerHTML = `${icon("square")}<span>说完了</span>`;
    status.textContent = "正在听，请慢慢说...";
    cancelElderSpeech();
    setXgState("listening");
    setCaption("您", "正在听，请慢慢说…");
    refreshIcons();

    let submitted = false;
    let errorHandled = false;

    recognition.onresult = (event) => {
      let transcript = "";
      for (let index = 0; index < event.results.length; index += 1) {
        transcript += event.results[index][0].transcript;
      }
      transcript = transcript.trim();
      input.value = transcript;
      const finalResult = event.results[event.results.length - 1].isFinal;
      status.textContent = finalResult ? "已转成文字，正在提交..." : `正在识别：${transcript}`;
      if (transcript) setCaption("您", transcript);
      if (finalResult && transcript && !submitted) {
        submitted = true;
        sendAiMessage(transcript);
      }
    };
    recognition.onerror = (event) => {
      errorHandled = true;
      const [title, detail] = speechErrorCopy(String(event.error || "unknown"));
      status.textContent = detail;
      showToast(title, detail, "warning");
      input.focus();
    };
    recognition.onnomatch = () => {
      errorHandled = true;
      const [title, detail] = speechErrorCopy("no-speech");
      status.textContent = detail;
      showToast(title, detail, "warning");
      input.focus();
    };
    recognition.onend = () => {
      state.speechRecognition = null;
      if (document.getElementById("va-xg")?.dataset.state === "listening") setXgState("idle");
      if (button) {
        button.classList.remove("listening");
        button.innerHTML = `${icon("mic")}<span>按一下说话</span>`;
      }
      if (!submitted && !errorHandled && !input.value.trim()) {
        status.textContent = "没有收到语音，请靠近麦克风重试或使用键盘语音输入";
      }
      refreshIcons();
    };
    try {
      recognition.start();
    } catch (error) {
      state.speechRecognition = null;
      button.classList.remove("listening");
      button.innerHTML = `${icon("mic")}<span>按一下说话</span>`;
      const [title, detail] = speechErrorCopy("unknown");
      status.textContent = detail;
      showToast(title, detail, "warning");
      input.focus();
      refreshIcons();
    }
  }

  function assistantBubbleHtml(text) {
    return `<span class="chat-avatar">桂</span><div class="chat-body"><p>${escapeHtml(text)}</p><button class="bubble-speak" type="button" data-action="ai-speak" aria-pressed="false" hidden>${icon("volume-2")}<span>听一遍</span></button></div>`;
  }

  // speech：点“听一遍”时念的内容；有建议卡时连同“现在先做”和电话一起念
  function appendAiBubble(role, content, speech = content) {
    const log = document.getElementById("ai-chat-log");
    if (!log) return null;
    const bubble = document.createElement("div");
    bubble.className = `chat-bubble ${role}`;
    if (role === "assistant") {
      bubble.dataset.speech = speech;
      bubble.innerHTML = assistantBubbleHtml(content);
    } else {
      bubble.innerHTML = `<p>${escapeHtml(content)}</p>`;
    }
    log.appendChild(bubble);
    refreshIcons();
    syncSpeakButtons();
    return bubble;
  }

  // 没有目标时滚到底；有目标时让这条回复的开头停在对话区顶部，老人从第一句读起
  function scrollChatTo(element = null) {
    const log = document.getElementById("ai-chat-log");
    if (!log) return;
    const top = element ? Math.max(0, element.offsetTop - 12) : log.scrollHeight;
    try { log.scrollTo({ top, behavior: "smooth" }); } catch (error) { log.scrollTop = top; }
  }

  function showAiTyping(label = "") {
    document.getElementById("ai-typing")?.remove();
    if (label === null) {
      if (document.getElementById("va-xg")?.dataset.state === "thinking") setXgState("idle");
      return;
    }
    setXgState("thinking");
    if (label) setCaption("小桂", "我帮您查一下，请稍等…");
    const log = document.getElementById("ai-chat-log");
    if (!log) return;
    const bubble = document.createElement("div");
    bubble.id = "ai-typing";
    bubble.className = "chat-bubble assistant typing";
    bubble.innerHTML = `<span class="chat-avatar">桂</span><div class="chat-body"><p><span class="typing-dots" aria-hidden="true"><i></i><i></i><i></i></span>${escapeHtml(label)}</p></div>`;
    log.appendChild(bubble);
    scrollChatTo();
  }

  function aiSpeechText(result) {
    const actions = Array.isArray(result.immediate_actions) ? result.immediate_actions.slice(0, 3) : [];
    const lead = String(result.summary || "").replace(/[。！？；，,.!?\s]+$/, "");
    const steps = actions.map((item) => String(item).replace(/[。；，,.\s]+$/, ""));
    return `${result.urgent ? "请立即拨打120。" : ""}${lead}${steps.length ? `。现在先做：${steps.join("。")}` : ""}。联系电话：${result.phone || ""}`;
  }

  function speakBubble(bubble, text = bubble?.dataset.speech) {
    if (!bubble || !text || !autoSpeakEnabled()) return;
    speakForElder(text, false, bubble.querySelector('[data-action="ai-speak"]'));
  }

  function setAiBusy(busy) {
    const send = document.getElementById("ai-send-btn");
    const input = document.getElementById("ai-dialog-input");
    if (send) {
      send.disabled = busy;
      send.innerHTML = busy ? `${icon("loader-circle", "spin")}正在分析` : `${icon("send")}发送`;
    }
    if (input) input.disabled = busy;
    refreshIcons();
  }

  function getAiLocationContext(message = "") {
    const text = String(message || "").toLowerCase().replace(/\s+/g, "");
    const profile = state.data.profile || {};
    const activeMovement = getMovementLogs().find((log) => log.residentId === profile.id && isMovementActive(log));
    const explicitOutside = /机构外|在外面|外出|景区|景点|海边|公园|车站|路上|商场|街上|旅途中|公交|出租车/.test(text);
    const explicitInside = /机构内|房间|护理楼|康养中心|服务台|宿舍/.test(text);
    if (explicitInside && !explicitOutside) {
      return { scope: "inside", label: `${profile.institution || "旅居机构"} · ${profile.room || "机构内"}`, institution: profile.institution || "旅居机构" };
    }
    if (explicitOutside || activeMovement) {
      return {
        scope: "outside",
        label: activeMovement ? activeMovement.destination : `${profile.stayCity || "当前城市"}机构外当前位置`,
        institution: profile.institution || "旅居机构",
        responsible: activeMovement ? activeMovement.responsible : "机构责任人",
        responsiblePhone: activeMovement ? activeMovement.responsiblePhone : ""
      };
    }
    return { scope: "unknown", label: "位置尚未核实", institution: profile.institution || "旅居机构" };
  }

  function applyAiLocation(result, location) {
    if (!result || !location) return result;
    const next = { ...result };
    const highRisk = next.risk_level === "high" || next.urgent === true;
    if (!highRisk) {
      if (location.scope === "outside" && next.rule_id === "needs_clarification") {
        next.place_route = `当前在${location.label}，先停在安全位置，补充准确位置并联系${location.institution}责任人。`;
      }
      return next;
    }
    if (location.scope === "unknown") {
      next.location_scope = "unknown";
      next.place_route = "位置未核实；出现急症时先向120或110报可辨认的地标，并请机构协助确认。";
      return next;
    }
    const phone = ["safety", "lost"].includes(next.intent) || ["personal_safety", "personal_self_harm", "location_lost"].includes(next.rule_id) ? "110" : "120";
    const existingActions = Array.isArray(next.immediate_actions) ? next.immediate_actions : [];
    const locationAction = location.scope === "outside"
      ? `立即拨打${phone}并打开定位，向接警人员说明${location.label}；同时通知${location.institution}责任人。`
      : `立即拨打${phone}，让${location.institution}值班人员到场并为急救人员引路。`;
    next.immediate_actions = [existingActions[0] || "立即停止活动并保持安全姿势", existingActions[1] || "请身边人陪同", locationAction].slice(0, 3);
    next.place_route = location.scope === "outside"
      ? `当前在${location.label}，先拨打${phone}并报告具体位置；${location.institution}责任人${location.responsible || "将同步跟进"}。`
      : `当前在${location.label}，先拨打${phone}；让机构值班人员到场引导急救。`;
    next.rationale = [...(Array.isArray(next.rationale) ? next.rationale : []), location.scope === "outside" ? "动态台账显示老人当前在机构外，急救或公安应先到现场" : "当前定位为机构内，机构工作人员负责现场协助"].slice(0, 3);
    next.location_scope = location.scope;
    next.location_label = location.label;
    return next;
  }

  async function sendAiMessage(rawMessage) {
    const message = String(rawMessage || "").trim();
    if (!message) return;
    cancelElderSpeech();
    const input = document.getElementById("ai-dialog-input");
    if (input) input.value = "";
    document.querySelector("#ai-chat-log .ai-suggestions")?.remove();
    appendAiBubble("user", message);
    setCaption("您", message);
    scrollChatTo();
    state.aiHistory.push({ role: "user", content: message, at: new Date().toISOString() });
    setAiBusy(true);

    const smallTalk = smallTalkKind(message);
    if (smallTalk) {
      showAiTyping("");
      await new Promise((resolve) => window.setTimeout(resolve, 450));
      showAiTyping(null);
      const reply = smallTalkReply(smallTalk);
      state.aiHistory.push({ role: "assistant", content: JSON.stringify({ summary: reply, intent: "chat" }) });
      sessionStorage.setItem(AI_HISTORY_KEY, JSON.stringify(state.aiHistory.slice(-12)));
      finishChatReply(reply);
      return;
    }
    showAiTyping("小桂正在帮您查");

    const locationContext = getAiLocationContext(message);
    const safetyDecision = applyAiLocation(localAiFallback(message), locationContext);
    state.lastSafetyDecision = safetyDecision;
    let responseData;
    let provider = "DeepSeek";
    let agentRun = null;
    if (safetyDecision.urgent) {
      responseData = safetyDecision;
      provider = `急症安全分流 · ${safetyDecision.rule_label}`;
    } else if (!AI_BACKEND_ENABLED) {
      responseData = safetyDecision;
      provider = `在线安全分流 · ${safetyDecision.rule_label}`;
    } else {
      try {
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), 46000);
        const useAgent = LOCAL_BACKEND_ENABLED && state.role === "elder";
        const response = await fetch(useAgent ? "/api/agent" : "/api/chat", {
          method: "POST",
          headers: authHeaders(true),
          cache: "no-store",
          signal: controller.signal,
          body: JSON.stringify({
            message,
            history: state.aiHistory.slice(0, -1),
            context: {
              current_city: state.data.profile.stayCity,
              institution: state.data.profile.institution,
              age: state.data.profile.age,
              conditions: state.data.profile.conditions,
              allergy: state.data.profile.allergy,
              screening: state.data.profile.screening ? { overall: state.data.profile.screening.overall, dimensions: state.data.profile.screening.dimensions?.map((dimension) => ({ label: dimension.label, level: dimension.level })), missing: state.data.profile.screening.missing || [] } : null,
              events: state.data.events.filter((item) => item.residentId === state.data.profile.id).slice(0, 3).map((item) => ({ category: item.category, level: item.level, status: item.status })),
              movements: getMovementLogs().filter((item) => item.residentId === state.data.profile.id).slice(0, 3).map((item) => ({ type: item.type, status: item.status, destination: item.destination })),
              location_scope: locationContext.scope,
              location_label: locationContext.label,
              responsible: locationContext.responsible || "",
              responsible_phone: locationContext.responsiblePhone || ""
            }
          })
        });
        window.clearTimeout(timeout);
        if (!response.ok) throw new Error("api_unavailable");
        const payload = await response.json();
        // 智能体的"高风险"可能只是路线或消费风险，只有真正的急症（urgent）才改写为急救指引。
        responseData = Array.isArray(payload.trace) && !payload.result?.urgent ? payload.result : applyAiLocation(payload.result, locationContext);
        provider = `${payload.provider} · ${payload.model}`;
        agentRun = Array.isArray(payload.trace) ? { trace: payload.trace, actions: Array.isArray(payload.actions) ? payload.actions : [], elapsed: payload.elapsed_ms || 0 } : null;
        if (riskRank(safetyDecision.risk_level) > riskRank(responseData.risk_level) && safetyDecision.rule_id !== "needs_clarification") {
          responseData = safetyDecision;
          provider = `安全规则优先 · ${safetyDecision.rule_label}`;
        }
      } catch (error) {
        responseData = safetyDecision;
        provider = `本地安全分流 · ${safetyDecision.rule_label}`;
      }
    }

    showAiTyping(null);
    state.aiHistory.push({ role: "assistant", content: JSON.stringify({ summary: responseData.summary, risk_level: responseData.risk_level, immediate_actions: responseData.immediate_actions, intent: responseData.intent }) });
    sessionStorage.setItem(AI_HISTORY_KEY, JSON.stringify(state.aiHistory.slice(-12)));
    // 闲聊、情绪倾诉、没听明白时只回一句话；有具体事情才出建议卡
    const chatOnly = !responseData.urgent && (responseData.mode === "chat" || (!agentRun && responseData.rule_id === "needs_clarification"));
    if (chatOnly) {
      finishChatReply(responseData.summary);
      return;
    }
    state.lastAiResult = responseData;
    state.aiProvider = provider;
    document.getElementById("ai-result-area")?.remove();
    const replyBubble = appendAiBubble("assistant", responseData.summary, aiSpeechText(responseData));
    setCaption("小桂", responseData.summary);
    if (responseData.urgent) {
      // 参考滴滴安全响应机制：识别到急症/呼救不再只给120链接，
      // 平台同步受理并自动回拨、通知值班人员接单（120自呼渠道始终保留）。
      const sosTrigger = responseData.sos || safetyDecision.rule_id === "personal_sos"
        ? "语音呼救（识别到呼救词）"
        : `AI急症分流 · ${responseData.rule_label || safetyDecision.rule_label || "高风险"}`;
      startSosSession(sosTrigger, { transcript: message });
    }
    state.lastAgentRun = agentRun;
    renderAiResult(responseData, provider, agentRun);
    setAiBusy(false);
    scrollChatTo(replyBubble);
    const speechStatus = document.getElementById("speech-status");
    if (speechStatus) speechStatus.textContent = "可以接着说，比如“那我要是已经交了怎么办”";
  }

  function finishChatReply(text) {
    const bubble = appendAiBubble("assistant", text);
    setCaption("小桂", text);
    setAiBusy(false);
    scrollChatTo(bubble);
    speakBubble(bubble);
    const speechStatus = document.getElementById("speech-status");
    if (speechStatus) speechStatus.textContent = "点左边的话筒说话，或者直接打字";
  }

  function localAiFallback(message) {
    if (window.GY_TRIAGE && typeof window.GY_TRIAGE.assess === "function") return window.GY_TRIAGE.assess(message, { age: state.data.profile.age, conditions: state.data.profile.conditions, allergy: state.data.profile.allergy, screening: state.data.profile.screening });
    return { rule_id: "safe_fallback", rule_label: "人工复核", summary: "系统暂时无法判断，请留在安全位置并联系机构工作人员。", immediate_actions: ["不要独自外出", "请工作人员立即到场查看", "出现胸痛或呼吸困难时拨打120"], place_route: "留在当前位置等待工作人员。", price: "以机构和医疗机构公示为准。", phone: "120（出现严重症状时）", risk_level: "medium", escalate: true, urgent: false, rationale: ["安全规则暂不可用，不能自动判为低风险"] };
  }

  function riskRank(level) {
    return { low: 1, medium: 2, high: 3 }[level] || 2;
  }

  const AGENT_STEP_ICONS = { perceive: "ear", plan: "brain", tool: "wrench", decide: "badge-check", guard: "shield-alert", note: "info" };
  const AGENT_TOOL_ICONS = { overview: "layout-dashboard", query_events: "siren", query_institutions: "building-2", query_movements: "map-pinned", query_radar: "radar", query_sos: "phone-call", query_care: "heart-pulse", get_resident_profile: "contact-round", get_current_movement: "map-pinned", assess_route: "route", check_institution: "landmark", search_similar_cases: "files", draft_movement_report: "clipboard-pen", create_ticket: "file-plus-2", notify_family: "phone-forwarded" };

  function agentActionMarkup(action, index) {
    const done = action.done ? " disabled" : "";
    if (action.action === "movement_report") {
      const consent = state.data.profile?.consents?.crossRegion;
      const needConsent = action.type === "跨市行程" && !consent;
      return `<div class="agent-action"><span class="agent-action-icon">${icon("clipboard-pen")}</span><div><strong>外出报备草稿</strong><small>${escapeHtml(action.departAt)} · ${escapeHtml(action.destination)} · ${escapeHtml(action.companion)}</small></div>${needConsent ? `<button class="btn btn-secondary" type="button" data-action="agent-consent">${icon("shield-check")}开启跨区域授权</button>` : ""}<button class="btn btn-primary" type="button" data-action="agent-confirm" data-index="${index}"${done || (needConsent ? " disabled" : "")}>${icon(action.done ? "check" : "send")}${action.done ? "已发给机构" : "确认报备"}</button></div>`;
    }
    if (action.action === "ticket") {
      return `<div class="agent-action"><span class="agent-action-icon">${icon("file-plus-2")}</span><div><strong>${escapeHtml(action.category)}工单</strong><small>建议派给：${escapeHtml(action.suggested_owner)}</small></div><button class="btn btn-primary" type="button" data-action="agent-confirm" data-index="${index}"${done}>${icon(action.done ? "check" : "send")}${action.done ? "已提交" : "确认提交"}</button></div>`;
    }
    if (action.action === "notify_family") {
      return `<div class="agent-action"><span class="agent-action-icon">${icon("phone-forwarded")}</span><div><strong>提醒${escapeHtml(action.to)}</strong><small>${escapeHtml(action.message)}</small></div><button class="btn btn-secondary" type="button" data-action="agent-confirm" data-index="${index}"${done}>${icon(action.done ? "check" : "bell-ring")}${action.done ? "已提醒" : "发送提醒"}</button></div>`;
    }
    return "";
  }

  // 查证过程：进行中逐步展开，完成后收成一行摘要，点击可展开明细
  function agentTraceMarkup(run, collapsed = false) {
    if (!run || !run.trace.length) return "";
    const toolSteps = run.trace.filter((step) => step.kind === "tool");
    const names = [...new Set(toolSteps.map((step) => String(step.title || "").replace(/^(查询|查看)/, "")))].filter(Boolean);
    const meta = `${toolSteps.length ? `查了 ${toolSteps.length} 项` : `${run.trace.length} 步`}${run.elapsed ? ` · ${(run.elapsed / 1000).toFixed(1)} 秒` : ""}`;
    return `<section class="agent-trace${collapsed ? " collapsed" : ""}" aria-label="查证过程">
      <button type="button" class="agent-trace-head" data-action="trace-toggle" aria-expanded="${collapsed ? "false" : "true"}"><span>${icon("list-checks")}${state.role === "elder" ? "小桂的查证过程" : "智能体执行过程"}</span><em>${escapeHtml(names.join("、"))}</em><small>${escapeHtml(meta)}</small>${icon("chevron-down")}</button>
      <ol>${run.trace.map((step, index) => `<li class="agent-step ${escapeHtml(step.kind)}" style="--i:${index}"><span class="agent-step-icon">${icon(AGENT_TOOL_ICONS[step.tool] || AGENT_STEP_ICONS[step.kind] || "dot")}</span><div><strong>${escapeHtml(step.title)}</strong><small>${escapeHtml(step.detail)}</small></div>${step.ms ? `<em>${step.ms} ms</em>` : ""}</li>`).join("")}</ol>
    </section>`;
  }

  function buildAiEvidence(provider = state.aiProvider) {
    const quotes = state.aiHistory.filter((item) => item.role === "user").slice(-3).map((item) => ({
      time: item.at ? new Date(item.at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "本次对话",
      text: String(item.content || "").slice(0, 80)
    }));
    const trace = state.lastAgentRun?.trace || [];
    const movement = getMovementLogs().find((item) => item.residentId === state.data.profile.id && isMovementActive(item));
    // 只有计划中的跨市/出境行程，或老人原话提到了目的地，才算与事件相关；其余只作为“当前所在”参考，不当证据
    const place = String(movement?.destination || "").replace(/[（(].*?[）)]/g, "").split(/[→·\s]/).filter((part) => part.length >= 2);
    const related = movement && (movement.status === "待出发" || /跨市|出境/.test(movement.type || "") || place.some((part) => quotes.some((quote) => quote.text.includes(part))));
    return {
      source: "老人对话主动透露",
      quotes,
      checks: trace.filter((step) => step.kind === "tool").slice(0, 6).map((step) => ({ tool: String(step.tool || "").slice(0, 50), label: String(step.title || "").slice(0, 80), result: String(step.detail || "").slice(0, 200) })),
      rules: trace.filter((step) => ["规则补全", "规则校正意图"].includes(step.title)).slice(0, 3).map((step) => `${step.title}：${step.detail}`.slice(0, 160)),
      movement: movement ? `${related ? "计划行程" : "当前所在（参考）"}：${movement.id} · ${movement.destination || movement.status}`.slice(0, 120) : "",
      matchedAlert: String(state.lastAiResult?.matched_alert?.id || "").slice(0, 40),
      provider: String(provider || "本地规则智能体").slice(0, 60),
      confirmedAt: new Date().toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    };
  }

  function renderAiResult(result, provider, agentRun = null, animate = true) {
    let area = document.getElementById("ai-result-area");
    if (!area) {
      const log = document.getElementById("ai-chat-log");
      if (!log) return;
      area = document.createElement("section");
      area.id = "ai-result-area";
      area.className = "ai-result-area";
      area.setAttribute("aria-label", "小桂的建议");
      log.appendChild(area);
    }
    const actions = Array.isArray(result.immediate_actions) ? result.immediate_actions : [];
    const rationale = Array.isArray(result.rationale) ? result.rationale : [];
    const phone = String(result.phone || "12345");
    const knownPhone = phone.match(/(?:120|110|12315|12345)/);
    const phoneDigits = knownPhone ? knownPhone[0] : "";
    const isUrgent = agentRun ? result.urgent === true : result.risk_level === "high";
    // 家人要钱先核实：电话一格换成档案登记的子女
    const contact = result.contact && result.contact.phone ? result.contact : null;
    const phoneAction = contact
      ? `<button class="btn btn-primary" type="button" data-action="ai-dial" data-number="${escapeHtml(contact.phone)}">${icon("phone")}打给${escapeHtml(contact.name)}核实</button>`
      : phoneDigits
        ? `<a class="btn ${isUrgent ? "btn-danger" : "btn-secondary"}" href="tel:${phoneDigits}">${icon("phone")}拨打 ${escapeHtml(phoneDigits)}</a>`
        : `<button class="btn btn-secondary" type="button" data-action="ai-dial" data-number="${escapeHtml(phone)}">${icon("phone")}联系机构值班</button>`;
    const facts = [
      result.place_route ? `<div class="ai-result-block"><span>${icon("route")}地点 / 路线</span><strong>${escapeHtml(result.place_route)}</strong></div>` : "",
      result.price ? `<div class="ai-result-block"><span>${icon("wallet-cards")}费用</span><strong>${escapeHtml(result.price)}</strong></div>` : "",
      contact
        ? `<div class="ai-result-block phone contact"><span>${icon("phone")}联系电话 · 先打给家人核实</span><strong>${escapeHtml(contact.name)}</strong><small>${escapeHtml(contact.phone)} · 档案里登记的紧急联系人</small></div>`
        : `<div class="ai-result-block phone"><span>${icon("phone")}联系电话</span><strong>${escapeHtml(phone)}</strong></div>`
    ].filter(Boolean);
    area.hidden = false;
    area.classList.toggle("urgent", isUrgent);
    area.classList.toggle("agent", Boolean(agentRun));
    area.classList.toggle("no-anim", !animate);
    area.style.setProperty("--steps", agentRun ? agentRun.trace.length : 0);
    const activeSos = isUrgent ? activeSosFor(state.data.profile.id) : null;
    const sosStrip = activeSos ? `
      <div class="sos-inline">
        <span class="sos-pulse"></span>
        <div><strong>平台应急响应已启动（${escapeHtml(activeSos.id)}）</strong><small><span data-sos-phase="${activeSos.id}">${escapeHtml(sosPhaseText(activeSos))}</span> <b class="sos-countdown" data-sos-countdown="${activeSos.id}">${sosCountdownText(activeSos)}</b> · <span data-sos-callback="${activeSos.id}">${escapeHtml(sosCallbackText(activeSos))}</span></small></div>
        <button class="btn btn-secondary" type="button" data-action="sos-status" data-id="${activeSos.id}">查看响应进度</button>
      </div>` : "";
    const agentActions = agentRun && agentRun.actions.length ? agentRun.actions.map(agentActionMarkup).join("") : "";
    area.innerHTML = `
      ${agentTraceMarkup(agentRun, !animate)}
      ${result.matched_alert ? `<div class="ai-alert-match">${icon("megaphone")}<div><strong>这和${escapeHtml(result.matched_alert.from || "主管部门")}${escapeHtml(result.matched_alert.time || "")}推送的防骗提醒是同一种说法</strong><span>相同的说法：${(result.matched_alert.shared || []).map((clue) => escapeHtml(clue.replace("/", "、"))).join("；")}。您先来问是对的，千万先别交钱。</span></div></div>` : ""}
      ${isUrgent ? `<div class="ai-urgent-banner">${icon("siren")}<strong>情况危急请直接拨打${escapeHtml(phoneDigits || phone)}；平台已同步受理，并通知值班人员回拨确认。</strong></div>${sosStrip}` : ""}
      <section class="ai-steps">
        <div class="ai-steps-head"><span>${icon("list-checks")}现在先做</span>${riskTag(result.risk_level || "low")}</div>
        <ol>${actions.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ol>
      </section>
      <div class="ai-action-grid" style="--cols:${facts.length}">${facts.join("")}</div>
      ${agentActions ? `<div class="agent-actions"><span class="eyebrow">点“确认”才会办，不会自动发出</span>${agentActions}</div>` : ""}
      <div class="ai-result-actions"><div>${phoneAction}${agentActions ? "" : `<button class="btn btn-primary" type="button" data-action="create-event-from-ai">${icon("send")}${isUrgent ? "同步高风险事件" : "生成求助事件"}</button>`}</div></div>
      <p class="ai-dial-hint" hidden></p>
      <footer class="ai-card-foot">
        ${rationale.length ? `<details class="ai-rationale"><summary>为什么这样建议</summary><ul>${rationale.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></details>` : ""}
        <small>${icon("cpu")}结果来源：${escapeHtml(provider)} · ${isUrgent ? "急症先呼救，平台同步留痕" : "AI辅助判断，工作人员会复核"}</small>
      </footer>
    `;
    refreshIcons();
    refreshSpeechControls();
    if (animate && autoSpeakEnabled()) {
      const bubble = area.previousElementSibling?.classList.contains("chat-bubble") ? area.previousElementSibling : null;
      const speech = bubble?.dataset.speech || aiSpeechText(result);
      speechTimer = window.setTimeout(() => {
        speechTimer = null;
        if (document.getElementById("ai-result-area") === area) speakForElder(speech, false, bubble?.querySelector('[data-action="ai-speak"]'));
      }, agentRun ? agentRun.trace.length * 260 + 540 : 450);
    }
    if (animate && agentRun) {
      window.setTimeout(() => {
        const trace = area.querySelector(".agent-trace");
        if (trace && !trace.dataset.touched) { trace.classList.add("collapsed"); trace.querySelector(".agent-trace-head")?.setAttribute("aria-expanded", "false"); }
      }, agentRun.trace.length * 260 + 1500);
    }
  }

  function confirmAgentAction(index) {
    const run = state.lastAgentRun;
    const action = run && run.actions[Number(index)];
    if (!action || action.done) return;
    const profile = state.data.profile;
    if (action.action === "movement_report") {
      if (action.type === "跨市行程" && !profile.consents?.crossRegion) {
        showToast("需要先开启跨区域授权", "跨市行程需要携带必要档案，请先开启授权。", "warning");
        return;
      }
      const id = uniqueRecordId("MV");
      const expectedLabel = new Date(action.expectedReturnAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
      state.data.movementLogs.unshift({ id, residentId: profile.id, resident: profile.name, type: action.type, status: "待出发", risk: action.risk, destination: action.destination, routeAssessment: null, reason: action.reason, departAt: action.departAt, expectedReturn: expectedLabel, expectedReturnAt: action.expectedReturnAt, actualReturn: "--", responsible: "待机构指派", responsiblePhone: "待机构填写", companion: action.companion, source: "AI对话生成报备", institutionStatus: "待核验", regulatorStatus: "待确认", confirmedBy: "--", confirmedAt: "--", eventId: "", timeline: [{ time: "刚刚", text: "老人与守护智能体对话后确认出行意向，智能体生成报备草稿", state: "done" }, { time: "刚刚", text: "等待机构核验路线并指派陪同人员", state: "current" }] });
      state.data.notifications.unshift({ id: Date.now(), title: "AI生成的外出报备待核验", detail: `${profile.name}计划${action.departAt}前往${action.destination}`, time: "刚刚", level: "warning", read: false });
      saveData("智能体生成外出报备", "movement_request", id);
      showToast("已发给机构核验", `${action.destination} · ${action.departAt}，机构确认后生效。`);
    } else if (action.action === "ticket") {
      const eventItem = { id: uniqueRecordId("EV"), residentId: profile.id, resident: profile.name, level: action.level, category: action.category, title: String(action.summary || action.category).slice(0, 40), source: "守护智能体", location: `${profile.institution} · ${profile.room}`, time: "刚刚", status: "待复核", owner: action.suggested_owner, deadline: action.level === "high" ? "优先响应" : "2小时内反馈", summary: action.summary, interceptedBy: action.alert_id || "", action: (state.lastAiResult?.immediate_actions || []).join("；"), rationale: (state.lastAiResult?.rationale || []).slice(0, 3), evidence: buildAiEvidence(), timeline: [{ time: "刚刚", text: action.alert_id ? "老人收到防骗提醒后先来求证，智能体判定与提醒同一话术" : "老人口述，守护智能体核查机构登记与相似案例", state: "done" }, { time: "刚刚", text: "老人确认提交，等待工作人员复核", state: "current" }] };
      state.data.events.unshift(stampNewEvent(eventItem));
      saveData("智能体生成求助工单", "risk_event", eventItem.id);
      showToast("工单已提交", `${eventItem.id} 已进入机构和监管处置队列。`);
    } else if (action.action === "notify_family") {
      state.data.notifications.unshift({ id: Date.now(), title: `已提醒${action.to}`, detail: action.message, time: "刚刚", level: "warning", read: false });
      saveData("智能体提醒紧急联系人", "notification", profile.id);
      showToast(`已生成给${action.to}的提醒`, "演示环境不发送真实短信，正式部署接入短信或电话通知。", "success");
    }
    action.done = true;
    renderAiResult(state.lastAiResult, state.aiProvider, run, false);
  }

  function createEventFromAi() {
    const result = state.lastAiResult;
    if (!result) return;
    const userMessages = state.aiHistory.filter((item) => item.role === "user").slice(-3);
    const intentMap = { health: "健康异常", safety: "人身安全", lost: "失联风险", complaint: "服务投诉", facility: "设施报修", fraud: "涉老诈骗风险", service: "服务请求", medication: "用药关注", emotion: "情绪关怀", consult: "一般咨询" };
    const ruleMap = { medical_cardiorespiratory: "health", medical_neurological: "health", medical_trauma: "health", medical_fall: "health", medical_attention: "health", medication_attention: "medication", personal_self_harm: "safety", personal_safety: "safety", personal_sos: "safety", location_lost: "lost", consumer_dispute: "complaint", fraud_warning: "fraud", emotional_attention: "emotion", daily_service: "service" };
    const intent = ruleMap[state.lastSafetyDecision?.rule_id] || (result.intent && result.intent !== "consult" ? result.intent : "consult");
    const category = intentMap[intent] || "一般咨询";
    const locationContext = getAiLocationContext(userMessages.map((item) => item.content).join("；"));
    const activeMovement = getMovementLogs().find((log) => log.residentId === state.data.profile.id && isMovementActive(log));
    const outside = locationContext.scope === "outside";
    const eventItem = {
      id: uniqueRecordId("EV"),
      residentId: state.data.profile.id,
      resident: state.data.profile.name,
      level: result.risk_level || "medium",
      category,
      title: String(result.summary || "AI视频对话求助").slice(0, 60),
      source: "AI视频对话",
      location: locationContext.label || `${state.data.profile.institution} · ${state.data.profile.room}`,
      time: "刚刚",
      status: "待复核",
      owner: outside && activeMovement ? activeMovement.responsible : "机构值班人员（待人工分流）",
      deadline: result.risk_level === "high" ? "优先响应" : "2小时内反馈",
      summary: userMessages.length ? userMessages.map((item) => item.content).join("；").slice(0, 500) : result.summary,
      action: Array.isArray(result.immediate_actions) ? result.immediate_actions.join("；") : result.summary,
      movementId: outside && activeMovement ? activeMovement.id : "",
      locationScope: locationContext.scope,
      rationale: Array.isArray(result.rationale) ? result.rationale.slice(0, 3) : [],
      evidence: buildAiEvidence(),
      timeline: [{ time: "刚刚", text: `老人完成AI视频对话（${outside ? "机构外" : "机构内"}）`, state: "done" }, { time: "刚刚", text: "AI生成行动卡并提交人工复核", state: "current" }]
    };
    state.data.events.unshift(stampNewEvent(eventItem));
    saveData("AI对话生成求助事件", "risk_event", eventItem.id);
    const button = modalRoot.querySelector('[data-action="create-event-from-ai"]');
    if (button) {
      button.disabled = true;
      button.innerHTML = `${icon("check")}事件已生成`;
      refreshIcons();
    }
    showToast("求助事件已生成", `${eventItem.id} 已进入机构和监管处置队列。`);
  }

  function openEmergencyReport() {
    openModal({
      title: "求助与维权",
      subtitle: "提交后同时发给机构和监管部门，生成一件可以查进度的事",
      body: `
        <form id="emergency-form" class="form-grid">
          <fieldset class="full report-types"><legend>遇到了什么事（点一下选择）</legend>${Object.entries(REPORT_ROUTES).map(([value, route], index) => `<label class="report-type${route.danger ? " danger" : ""}"><input type="radio" name="category" value="${escapeHtml(value)}"${index === 0 ? " checked" : ""} required><span class="report-type-icon">${icon(route.icon)}</span><span>${escapeHtml(route.label)}</span></label>`).join("")}</fieldset>
          <div id="report-route" class="full report-route" aria-live="polite"></div>
          <label class="full"><span>在哪里</span><span class="input-wrap"><i data-lucide="map-pin" aria-hidden="true"></i><input id="emergency-location" name="location" value="北海银龄康养中心" required><button class="icon-btn inline-icon" type="button" data-action="locate" aria-label="获取位置" title="获取位置">${icon("crosshair")}</button></span></label>
          <label class="full"><span>事情经过</span><textarea id="emergency-description" class="form-control" name="description" placeholder="可以直接说话，也可以简单写下发生了什么" required></textarea></label>
          <div class="full"><div class="filter-row"><button id="voice-btn" class="btn btn-secondary" type="button" data-action="record-voice">${icon("mic")}点击语音输入</button><label class="btn btn-secondary btn-file">${icon("paperclip")}添加照片/视频<input id="evidence-file" type="file" accept="image/*,video/*" hidden></label><span id="evidence-name" class="meta-text"></span></div></div>
        </form>
      `,
      footer: `<button class="btn btn-secondary" type="button" data-action="close-modal">取消</button><button class="btn btn-report" type="submit" form="emergency-form">${icon("send")}提交求助</button>`,
      onOpen: () => {
        const form = document.getElementById("emergency-form");
        form.addEventListener("submit", submitEmergency);
        const showRoute = () => {
          const route = REPORT_ROUTES[form.querySelector("input[name='category']:checked")?.value] || REPORT_ROUTES["服务投诉"];
          document.getElementById("report-route").innerHTML = `${icon(route.danger ? "siren" : "send")}<div><strong>提交后发给：${escapeHtml(route.owner)}</strong><span>同时抄送监管部门 · ${escapeHtml(route.deadline)} · 电话 ${escapeHtml(route.phone)}</span>${route.danger ? `<em>会同时发出一键呼救，马上通知值班人员</em>` : ""}</div>`;
          refreshIcons();
        };
        form.querySelectorAll("input[name='category']").forEach((radio) => radio.addEventListener("change", showRoute));
        showRoute();
        const file = document.getElementById("evidence-file");
        file.addEventListener("change", () => { document.getElementById("evidence-name").textContent = file.files[0] ? file.files[0].name : ""; });
      }
    });
  }

  function locateEmergency() {
    const location = document.getElementById("emergency-location");
    if (!location) return;
    if (!navigator.geolocation) {
      location.value = "北海银滩景区（演示定位）";
      return showToast("已使用演示定位", "实际接入时可读取手机定位。", "warning");
    }
    navigator.geolocation.getCurrentPosition(
      (position) => { location.value = `北海市 · ${position.coords.latitude.toFixed(4)}, ${position.coords.longitude.toFixed(4)}`; showToast("位置已获取", "提交时会随事件卡发送。", "success"); },
      () => { location.value = "北海银滩景区（演示定位）"; showToast("定位权限未开启", "已使用演示位置。", "warning"); },
      { timeout: 3000 }
    );
  }

  async function recordVoice() {
    const button = document.getElementById("voice-btn");
    if (!button) return;
    if (state.voiceRecorder) { state.voiceRecorder.stop(); return; }
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
      showToast("当前浏览器不支持语音转写", "请手动填写求助描述，或使用支持语音识别的浏览器。", "warning");
      return;
    }
    try {
      const recognition = new Recognition();
      recognition.lang = "zh-CN";
      recognition.interimResults = true;
      recognition.continuous = false;
      const field = document.getElementById("emergency-description");
      const before = field.value.trim();
      state.voiceRecorder = recognition;
      recognition.onresult = (event) => {
        const transcript = Array.from(event.results).map((result) => result[0].transcript).join("").trim();
        if (transcript) field.value = [before, transcript].filter(Boolean).join("，");
        if (event.results[event.results.length - 1].isFinal && transcript) showToast("语音已转写", "请核对文字后再提交。", "success");
      };
      recognition.onerror = (event) => showToast("语音识别失败", `识别服务返回：${event.error}；请手动输入。`, "warning");
      recognition.onend = () => { state.voiceRecorder = null; if (button.isConnected) { button.innerHTML = `${icon("mic")}点击说话`; refreshIcons(); } };
      recognition.start();
      button.innerHTML = `${icon("square")}正在识别，点击结束`;
      refreshIcons();
      showToast("正在听取语音", "浏览器语音服务可能联网；识别文字会显示在描述框，请核对。", "warning");
    } catch (error) {
      state.voiceRecorder = null;
      showToast("语音服务暂不可用", "请手动填写求助描述。", "warning");
    }
  }

  // 求助与维权的去向：谁负责、多久反馈、打哪个电话（人身安全、迷路会同时启动呼救）
  const REPORT_ROUTES = {
    "服务投诉": { icon: "message-square-warning", label: "服务不满意（态度、饭菜、护理）", owner: "北海银龄康养中心（民政部门督办）", deadline: "2 小时内反馈", phone: "机构值班电话" },
    "消费纠纷": { icon: "wallet-cards", label: "多收费、退款、强制购物", owner: "北海市市场监管部门", deadline: "1 个工作日内反馈", phone: "12315" },
    "涉老诈骗风险": { icon: "shield-alert", label: "有人让我交钱、要验证码", owner: "北海市公安联络组（机构先核实）", deadline: "优先处理", phone: "110", level: "high" },
    "设施报修": { icon: "wrench", label: "房间设施坏了", owner: "北海银龄康养中心", deadline: "当天处理", phone: "机构值班电话" },
    "健康异常": { icon: "heart-pulse", label: "身体不舒服", owner: "北海银龄康养中心医护", deadline: "30 分钟内到场", phone: "机构值班电话" },
    "人身安全": { icon: "siren", label: "有人跟着我、威胁我", owner: "属地应急联络组", deadline: "马上响应", phone: "110", danger: true },
    "失联风险": { icon: "map-pinned", label: "迷路了、找不到回去的路", owner: "属地应急联络组", deadline: "马上响应", phone: "110", danger: true }
  };

  function submitEmergency(event) {
    event.preventDefault();
    const formData = new FormData(event.target);
    const description = String(formData.get("description") || "").trim();
    const category = String(formData.get("category") || "服务投诉");
    const location = String(formData.get("location") || "北海银龄康养中心");
    const route = REPORT_ROUTES[category] || REPORT_ROUTES["服务投诉"];
    const isDanger = Boolean(route.danger);
    const eventItem = {
      id: uniqueRecordId("EV"),
      residentId: state.data.profile.id,
      resident: state.data.profile.name,
      level: isDanger || route.level === "high" ? "high" : "medium",
      category,
      title: description.length > 23 ? `${description.slice(0, 23)}…` : description,
      source: "老人上报",
      location,
      time: "刚刚",
      status: "待复核",
      owner: route.owner,
      deadline: route.deadline,
      summary: description || "老人通过求助入口提交了一条事件。",
      action: isDanger ? "请保持当前位置，优先联系紧急联系人并等待人工回拨。" : "责任单位将在时限内核验并反馈处理结果。",
      timeline: [{ time: "刚刚", text: "老人提交语音/文字事件", state: "done" }, { time: "刚刚", text: "系统生成结构化事件卡", state: "current" }]
    };
    state.data.events.unshift(stampNewEvent(eventItem));
    saveData("提交老人求助事件", "risk_event", eventItem.id);
    closeModal();
    if (isDanger) {
      startSosSession(`求助上报 · ${category}`, { transcript: description, location, linkedEventId: eventItem.id, openStatus: true });
    } else {
      showActionCard(eventItem);
    }
    renderPage();
  }

  function showActionCard(eventItem) {
    openModal({
      title: "已提交，机构和监管部门都收到了",
      subtitle: `事件编号 ${eventItem.id} · 可以在“办理进度”里看办到哪一步`,
      body: `<div class="action-card ${eventItem.level === "high" ? "danger" : "warning"}"><h3>${escapeHtml(eventItem.title)}</h3><p>${escapeHtml(eventItem.action)}</p></div><div class="profile-grid mt-4"><div class="data-field"><span>负责单位</span><strong>${escapeHtml(eventItem.owner)}</strong></div><div class="data-field"><span>多久反馈</span><strong>${escapeHtml(eventItem.deadline)}</strong></div><div class="data-field"><span>发生地点</span><strong>${escapeHtml(eventItem.location)}</strong></div><div class="data-field"><span>下一步</span><strong>工作人员核实后会联系您</strong></div></div>`,
      footer: `<button class="btn btn-secondary" type="button" data-action="close-modal">关闭</button>${eventCallButton(eventItem)}`
    });
  }

  function getEvent(id) {
    return state.data.events.find((event) => event.id === id);
  }

  // ===================== 平台应急响应闭环（安心应答） =====================
  // 触发（语音喊救命 / 一键呼救 / AI急症分流）→ 自动回拨确认 → 值班人员30秒内接单
  // → 超时自动通知机构负责人与紧急联系人 → 再超时升级监管端应急联动 → 处置闭环全程留痕

  function getSosSessions() {
    if (!Array.isArray(state.data.sosSessions)) state.data.sosSessions = [];
    return state.data.sosSessions;
  }

  function getSos(id) {
    return getSosSessions().find((session) => session.id === id);
  }

  function activeSosFor(residentId) {
    return getSosSessions().find((session) => session.residentId === residentId && SOS_ACTIVE_STATUSES.has(session.status));
  }

  function sosClock() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  }

  function sosElapsedSeconds(session) {
    if (!session.createdAt) return 0;
    return Math.max(0, Math.floor((Date.now() - session.createdAt) / 1000));
  }

  function pushSosTimeline(session, text, stateFlag = "current") {
    (session.timeline || (session.timeline = [])).forEach((item) => { if (item.state === "current") item.state = "done"; });
    session.timeline.push({ time: sosClock(), text, state: stateFlag });
  }

  function sosDutyPhone(session) {
    const duty = (session.contacts || []).find((contact) => /值班|夜班/.test(contact.role || ""));
    return duty && duty.phone ? duty.phone : currentDutyStaff().phone || "";
  }

  function sosStatusLabel(session) {
    if (session.status === "waiting") {
      if (session.escalation >= 3) return "监管联动中";
      if (session.escalation >= 2) return "站内提醒负责人与家属";
      return "响应中·待接单";
    }
    if (session.status === "claimed") return "已接单·处置中";
    if (session.status === "resolved_safe") return "已确认安全";
    if (session.status === "resolved_handled") return "处置完成";
    if (session.status === "resolved_dispatched") return "已联动120/110";
    if (session.status === "cancelled") return "本人取消·已留痕";
    return session.status;
  }

  function sosStatusTag(session) {
    const label = sosStatusLabel(session);
    const cls = SOS_ACTIVE_STATUSES.has(session.status) ? (session.status === "claimed" ? "warning" : "danger") : session.status === "cancelled" ? "neutral" : "success";
    return `<span class="status-tag ${cls}">${escapeHtml(label)}</span>`;
  }

  function sosPhaseText(session) {
    if (session.status === "claimed") return `值班员${session.claimedBy || ""}已接单（响应用时${session.responseSeconds != null ? `${session.responseSeconds}秒` : "—"}）`;
    if (session.status !== "waiting") return sosStatusLabel(session);
    if (session.escalation >= 3) return "监管端应急联动中 · 已等待";
    if (session.escalation >= 2) return "站内提醒负责人与家属 · 监管联动倒计时";
    return "值班人员接单倒计时";
  }

  function sosCountdownText(session) {
    const elapsed = sosElapsedSeconds(session);
    if (session.status !== "waiting") return "";
    if (session.escalation >= 3) {
      const pad = (value) => String(value).padStart(2, "0");
      return `${pad(Math.floor(elapsed / 60))}:${pad(elapsed % 60)}`;
    }
    const deadline = session.escalation >= 2 ? SOS_CONFIG.regulatorEscalateSeconds : SOS_CONFIG.claimSlaSeconds;
    return `${Math.max(0, deadline - elapsed)}秒`;
  }

  function sosCallbackText(session) {
    const callback = session.callback || {};
    // 演示环境没有真实电话：自动回拨是模拟流程，界面上写明，避免老人一直等一个不会来的电话
    if (callback.status === "dialing") return `模拟回拨中（第${callback.attempts || 1}次）`;
    if (callback.status === "ringing") return `模拟回拨响铃（第${callback.attempts || 1}次），值班人员会人工联系`;
    if (callback.status === "answered_danger") return "回拨已接通 · 确认存在危险";
    if (callback.status === "answered_safe") return "回拨已接通 · 本人确认安全";
    if (callback.status === "no_answer") return "回拨未接通 · 已升级通知";
    return "等待值班人员联系";
  }

  const SOS_SYNC = { pollMs: 2000, channel: "guiyang-sos-channel", leaderKey: "guiyang-sos-leader", leaseMs: 3000 };
  const SOS_TAB_ID = `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  /* 多窗口/多设备下只允许一个标签页推进状态机，其余标签页只渲染倒计时，避免重复升级与重复留痕。 */
  function isSosLeader() {
    try {
      const now = Date.now();
      const raw = localStorage.getItem(SOS_SYNC.leaderKey);
      const current = raw ? JSON.parse(raw) : null;
      if (!current || !current.id || now - Number(current.at || 0) > SOS_SYNC.leaseMs || current.id === SOS_TAB_ID) {
        localStorage.setItem(SOS_SYNC.leaderKey, JSON.stringify({ id: SOS_TAB_ID, at: now }));
        return true;
      }
      return false;
    } catch (error) {
      return true;
    }
  }

  /* 桌面浏览器没有电话应用，点 tel: 链接会弹出系统"选择应用"窗口。
     这里只在能拨号的设备上放行，其余情况改为展示号码并留痕。 */
  const CAN_PLACE_CALL = (() => {
    const ua = navigator.userAgent || "";
    if (/Android|iPhone|iPad|iPod|HarmonyOS|Windows Phone|Mobile/i.test(ua)) return true;
    return typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
  })();

  function copyText(value) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(value).then(() => true).catch(() => false);
    }
    try {
      const helper = document.createElement("textarea");
      helper.value = value;
      helper.setAttribute("readonly", "readonly");
      helper.style.position = "fixed";
      helper.style.opacity = "0";
      document.body.appendChild(helper);
      helper.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(helper);
      return Promise.resolve(ok);
    } catch (error) {
      return Promise.resolve(false);
    }
  }

  function recordSelfDial(number) {
    if (state.role !== "elder") return;
    const digits = String(number).replace(/\D/g, "");
    if (digits !== "120" && digits !== "110") return;
    const session = activeSosFor(state.data.profile.id);
    if (!session) return;
    session.selfDial = session.selfDial || {};
    if (session.selfDial[digits]) return;
    session.selfDial[digits] = sosClock();
    pushSosTimeline(session, `本人从平台入口拨打${digits}，平台响应同步进行`);
    saveSos("本人自行拨打急救电话", session.id);
  }

  function openDialModal(number, label = "") {
    const digits = String(number || "").trim();
    const masked = /\*/.test(digits);
    const returnSos = modalRoot.querySelector("[data-sos-modal]");
    const returnId = returnSos ? returnSos.dataset.sosModal : "";
    const emergency = /^1(20|10|19)$/.test(digits.replace(/\D/g, ""));
    openModal({
      title: emergency ? `拨打${escapeHtml(digits)}` : "拨打电话",
      subtitle: label ? escapeHtml(label) : "当前设备无法直接拨号",
      body: `
        <div class="dial-panel">
          <p class="dial-hint">${icon("smartphone")}电脑浏览器没有电话应用，无法直接呼出。请用手机拨打下面的号码；在手机上打开本页面时，点击按钮会直接进入拨号界面。</p>
          <div class="dial-number" role="text" aria-label="号码 ${escapeHtml(digits)}">${escapeHtml(digits)}</div>
          ${masked ? `<p class="dial-note">${icon("shield")}演示环境号码已脱敏，正式部署时由平台按权限下发真实号码。</p>` : ""}
          ${emergency ? `<p class="dial-note">${icon("siren")}情况危急请立即拨打，平台的呼救响应会同步继续进行，不会因为您自行拨打而中断。</p>` : ""}
        </div>
      `,
      footer: `${masked ? "" : `<button class="btn btn-primary" type="button" data-action="dial-copy" data-number="${escapeHtml(digits)}">${icon("copy")}复制号码</button>`}${returnId ? `<button class="btn btn-secondary" type="button" data-action="sos-status" data-id="${returnId}">返回呼救进度</button>` : ""}<button class="btn btn-secondary" type="button" data-action="close-modal">关闭</button>`
    });
  }

  document.addEventListener("click", (event) => {
    const link = event.target.closest('a[href^="tel:"]');
    if (!link) return;
    const number = decodeURIComponent(link.getAttribute("href").slice(4)).trim();
    recordSelfDial(number);
    if (CAN_PLACE_CALL) return;
    event.preventDefault();
    openDialModal(number, link.dataset.dialLabel || "");
  }, true);

  function dutyRoster() {
    return Array.isArray(state.data.dutyRoster) && state.data.dutyRoster.length
      ? state.data.dutyRoster
      : [{ shift: "白班", from: 0, to: 24, name: "值班人员", phone: "", title: "机构值班员" }];
  }

  /* 按当前时段取值班人，跨零点的夜班用 from > to 表示。 */
  function currentDutyStaff(at = new Date()) {
    const hour = at.getHours();
    const roster = dutyRoster();
    return roster.find((shift) => {
      const from = Number(shift.from);
      const to = Number(shift.to);
      return from <= to ? hour >= from && hour < to : hour >= from || hour < to;
    }) || roster[0];
  }

  function stampSos(session) {
    if (session) session.updatedAtMs = Date.now();
    return session;
  }

  function mergeSosSessions(incoming) {
    if (!Array.isArray(incoming) || !incoming.length) return { changed: false, arrived: [], claimed: [] };
    const local = getSosSessions();
    const index = new Map(local.map((item) => [item.id, item]));
    const arrived = [];
    const claimed = [];
    let changed = false;
    incoming.forEach((remote) => {
      if (!remote || !remote.id) return;
      const mine = index.get(remote.id);
      if (!mine) {
        local.unshift(remote);
        index.set(remote.id, remote);
        changed = true;
        if (SOS_ACTIVE_STATUSES.has(remote.status)) arrived.push(remote);
        return;
      }
      const remoteStamp = Number(remote.updatedAtMs || 0);
      const localStamp = Number(mine.updatedAtMs || 0);
      if (remoteStamp <= localStamp) return;
      const wasWaiting = mine.status === "waiting";
      Object.keys(mine).forEach((key) => { if (!(key in remote)) delete mine[key]; });
      Object.assign(mine, remote);
      changed = true;
      if (wasWaiting && remote.status === "claimed") claimed.push(mine);
    });
    if (changed) {
      local.sort((a, b) => Number(b.updatedAtMs || 0) - Number(a.updatedAtMs || 0));
      state.data.sosSessions = local;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.data));
    }
    return { changed, arrived, claimed };
  }

  function playSosChime(pattern = [880, 660]) {
    if (state.sos.muted) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      state.sos.audio = state.sos.audio || new Ctx();
      const ctx = state.sos.audio;
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
      pattern.forEach((frequency, order) => {
        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();
        const startAt = ctx.currentTime + order * 0.28;
        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(frequency, startAt);
        gain.gain.setValueAtTime(0.0001, startAt);
        gain.gain.exponentialRampToValueAtTime(0.16, startAt + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.24);
        oscillator.connect(gain).connect(ctx.destination);
        oscillator.start(startAt);
        oscillator.stop(startAt + 0.26);
      });
    } catch (error) {
      /* 静音失败不影响主流程 */
    }
  }

  function flashSosTitle(text) {
    if (state.sos.titleTimer) return;
    const original = document.title;
    let on = true;
    state.sos.titleTimer = window.setInterval(() => {
      const stillActive = getSosSessions().some((item) => SOS_ACTIVE_STATUSES.has(item.status));
      if (!stillActive || !document.hidden) {
        window.clearInterval(state.sos.titleTimer);
        state.sos.titleTimer = null;
        document.title = original;
        return;
      }
      document.title = on ? text : original;
      on = !on;
    }, 900);
  }

  function announceIncomingSos(sessions) {
    const fresh = sessions.filter((item) => item && !state.sos.alerted.has(item.id));
    if (!fresh.length) return;
    fresh.forEach((item) => state.sos.alerted.add(item.id));
    if (state.role !== "provider" && state.role !== "regulator") return;
    playSosChime([880, 660, 880]);
    flashSosTitle("【应急呼救】待接单");
    const first = fresh[0];
    showToast(
      fresh.length > 1 ? `${fresh.length}条新呼救待接单` : "新的应急呼救",
      `${escapeHtml(first.resident || "旅居老人")} · ${escapeHtml(first.trigger || "一键呼救")}，请在${SOS_CONFIG.claimSlaSeconds}秒内接单。`,
      "danger"
    );
  }

  function announceClaimedSos(sessions) {
    if (state.role !== "elder") return;
    const mine = sessions.filter((item) => item && item.residentId === state.data.profile.id);
    if (!mine.length) return;
    playSosChime([660, 880]);
    showToast("工作人员已接单", `${escapeHtml(mine[0].claimedBy || "值班人员")}正在赶来，请留在原地并保持电话畅通。`, "success");
  }

  function applySosUpdate(sessions) {
    const result = mergeSosSessions(sessions);
    if (!result.changed) return false;
    announceIncomingSos(result.arrived);
    announceClaimedSos(result.claimed);
    refreshSosUi();
    return true;
  }

  function broadcastSos(sessions) {
    if (!state.sos.channel || !sessions.length) return;
    try {
      state.sos.channel.postMessage({ type: "sos-update", from: SOS_TAB_ID, sessions });
    } catch (error) {
      /* 频道不可用时退回轮询 */
    }
  }

  function initSosChannel() {
    if (state.sos.channel || typeof window.BroadcastChannel !== "function") return;
    try {
      state.sos.channel = new BroadcastChannel(SOS_SYNC.channel);
      state.sos.channel.onmessage = (event) => {
        const payload = event.data;
        if (!payload || payload.type !== "sos-update" || payload.from === SOS_TAB_ID) return;
        applySosUpdate(payload.sessions || []);
      };
    } catch (error) {
      state.sos.channel = null;
    }
  }

  function pushSosSession(session, action) {
    if (!state.backend.enabled || !session) return Promise.resolve(false);
    const account = state.role && state.data.accounts[state.role] ? state.data.accounts[state.role] : null;
    return fetch("/api/sos", {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({
        session,
        audit: {
          actor_role: state.role || "system",
          actor_name: account ? account.name : "系统",
          action: action || "更新应急呼救工单",
          entity_type: "sos_session",
          entity_id: session.id,
          detail: { status: session.status, escalation: session.escalation }
        }
      })
    }).then((response) => {
      if (!response.ok) throw Object.assign(new Error("sos_write_failed"), { status: response.status });
      return response.json();
    }).then((payload) => {
      state.sos.revision = payload.revision;
      state.sos.pending.delete(session.id);
      return true;
    }).catch((error) => {
      if (error && error.status >= 400 && error.status < 500 && error.status !== 401) {
        // 服务器在线但不接受这次改动（例如工单已被他人接单或已经办结）：不再反复补传，改为以服务器上的记录为准
        state.sos.pending.delete(session.id);
        const local = getSos(session.id);
        if (local) local.updatedAtMs = 0;
        state.sos.revision = -1;
        showToast("工单状态已变化", "服务器上的记录已更新（例如已被他人接单或已经办结），页面将同步为最新状态。", "warning");
        window.setTimeout(pollSosLedger, 200);
        return false;
      }
      /* 离线期间先留在本地队列，恢复联网后由轮询补传，保证留痕不丢。 */
      state.sos.pending.add(session.id);
      return false;
    });
  }

  function flushPendingSos() {
    if (!state.sos.pending.size) return;
    Array.from(state.sos.pending).forEach((id) => {
      const session = getSos(id);
      if (!session) {
        state.sos.pending.delete(id);
        return;
      }
      pushSosSession(session, "补传离线期间的呼救留痕");
    });
  }

  async function pollSosLedger() {
    if (!state.backend.enabled || !state.role || state.sos.polling) return;
    state.sos.polling = true;
    try {
      const response = await fetch(`/api/sos?since=${state.sos.revision}`, { cache: "no-store", headers: authHeaders() });
      if (!response.ok) throw new Error("sos_read_failed");
      const payload = await response.json();
      state.sos.revision = payload.revision;
      if (payload.changed) applySosUpdate(payload.sessions || []);
      flushPendingSos();
    } catch (error) {
      /* 离线时继续用本地副本与广播频道 */
    } finally {
      state.sos.polling = false;
    }
  }

  function saveSos(action, sessionIds) {
    const ids = String(sessionIds || "").split("、").map((item) => item.trim()).filter(Boolean);
    const targets = ids.map((id) => getSos(id)).filter(Boolean);
    targets.forEach(stampSos);
    broadcastSos(targets);
    const result = saveData(action, "sos_session", sessionIds);
    targets.forEach((session) => pushSosSession(session, action));
    return result;
  }

  function ensureSosSync() {
    initSosChannel();
    if (state.sos.syncTimer || !state.backend.enabled) return;
    state.sos.syncTimer = window.setInterval(pollSosLedger, SOS_SYNC.pollMs);
    pollSosLedger();
  }

  function stopSosSync() {
    if (state.sos.syncTimer) {
      window.clearInterval(state.sos.syncTimer);
      state.sos.syncTimer = null;
    }
    if (state.sos.titleTimer) {
      window.clearInterval(state.sos.titleTimer);
      state.sos.titleTimer = null;
    }
  }

  function ensureSosTicker() {
    if (state.sosTicker) return;
    state.sosTicker = window.setInterval(() => {
      // 连接本地服务时，模拟回拨推进和超时升级都由服务器后台值守执行，本页只显示；离线演示才由本页推进
      if (!state.backend.enabled && isSosLeader()) progressSosSessions();
      updateSosCountdowns();
    }, 1000);
  }

  function updateSosCountdowns() {
    getSosSessions().forEach((session) => {
      document.querySelectorAll(`[data-sos-countdown="${session.id}"]`).forEach((node) => { node.textContent = sosCountdownText(session); });
      document.querySelectorAll(`[data-sos-phase="${session.id}"]`).forEach((node) => { node.textContent = sosPhaseText(session); });
      document.querySelectorAll(`[data-sos-callback="${session.id}"]`).forEach((node) => { node.textContent = sosCallbackText(session); });
    });
  }

  function sosEscalateLevel2(session) {
    session.escalation = 2;
    session.notified = session.notified || {};
    session.notified.manager = true;
    session.notified.family = true;
    const family = (session.contacts || []).find((contact) => contact.role === "紧急联系人");
    pushSosTimeline(session, `超${SOS_CONFIG.claimSlaSeconds}秒未接单：已在站内生成机构负责人和紧急联系人通知提醒，电话需人工联系${family ? family.name : ""}`);
  }

  function sosEscalateLevel3(session) {
    session.escalation = 3;
    session.notified = session.notified || {};
    session.notified.regulator = true;
    ensureSosLinkedEvent(session);
    pushSosTimeline(session, "超时未接单：已在监管端生成联动工单和最小档案摘要，外部调度由授权人员确认");
  }

  function progressSosSessions() {
    const now = Date.now();
    let changedIds = [];
    getSosSessions().forEach((session) => {
      if (!SOS_ACTIVE_STATUSES.has(session.status)) return;
      let changed = false;
      const callback = session.callback || (session.callback = { status: "dialing", attempts: 1, startedAt: now });
      if (callback.status === "dialing" && now - (callback.startedAt || now) >= 3000) {
        callback.status = "ringing";
        pushSosTimeline(session, `模拟回拨已进入响铃阶段（第${callback.attempts}次），等待接听`);
        changed = true;
      } else if (callback.status === "ringing" && now - (callback.startedAt || now) >= SOS_CONFIG.callbackRingSeconds * 1000) {
        if ((callback.attempts || 1) < SOS_CONFIG.maxCallbackAttempts) {
          callback.attempts = (callback.attempts || 1) + 1;
          callback.status = "dialing";
          callback.startedAt = now;
          pushSosTimeline(session, `第${callback.attempts - 1}次回拨未接通，自动发起第${callback.attempts}次回拨`);
        } else {
          callback.status = "no_answer";
          pushSosTimeline(session, `${SOS_CONFIG.maxCallbackAttempts}次自动回拨均未接通`);
          if (session.status === "waiting" && session.escalation < 2) sosEscalateLevel2(session);
        }
        changed = true;
      }
      if (session.status === "waiting") {
        const elapsed = sosElapsedSeconds(session);
        if (elapsed >= SOS_CONFIG.claimSlaSeconds && session.escalation < 2) {
          sosEscalateLevel2(session);
          changed = true;
        }
        if (elapsed >= SOS_CONFIG.regulatorEscalateSeconds && session.escalation < 3) {
          sosEscalateLevel3(session);
          changed = true;
        }
      }
      if (changed) changedIds.push(session.id);
    });
    if (changedIds.length) {
      saveSos("应急呼救状态推进", changedIds.join("、"));
      refreshSosUi();
    }
  }

  function refreshSosUi() {
    if (state.role) renderPage();
    const statusModal = modalRoot.querySelector("[data-sos-modal]");
    if (statusModal) openSosStatusModal(statusModal.dataset.sosModal);
    const detailModal = modalRoot.querySelector("[data-sos-detail]");
    if (detailModal) openSosDetailModal(detailModal.dataset.sosDetail);
  }

  function ensureSosLinkedEvent(session) {
    if (session.linkedEventId) {
      const existing = getEvent(session.linkedEventId);
      if (existing) return existing;
    }
    const isHealth = /急症|健康|分流|跌倒|血压/.test(session.trigger || "");
    const isHome = /燃气|烟感|烟雾/.test(session.trigger || "");
    const eventItem = {
      id: uniqueRecordId("EV"),
      residentId: session.residentId,
      resident: session.resident,
      level: "high",
      category: isHealth ? "健康异常" : isHome ? "居家安全" : "人身安全",
      title: `应急呼救联动：${session.trigger}`,
      source: "应急呼救升级",
      location: session.location,
      time: "刚刚",
      status: "处置中",
      owner: "属地应急联络组",
      deadline: "优先响应",
      summary: `${session.trigger}触发（${session.transcript ? `原话：${session.transcript}` : "无语音转写"}），平台响应升级为跨部门联动处置。`,
      action: "生成位置与最小照护摘要供监管人员核验；外部联动需授权人员确认。",
      timeline: [
        { time: "刚刚", text: `呼救工单 ${session.id} 升级联动`, state: "done" },
        { time: "刚刚", text: "属地应急联络组接收", state: "current" }
      ]
    };
    state.data.events.unshift(stampNewEvent(eventItem));
    session.linkedEventId = eventItem.id;
    return eventItem;
  }

  function closeSosLinkedEvent(session, note) {
    if (!session.linkedEventId) return;
    const eventItem = getEvent(session.linkedEventId);
    if (!eventItem || eventItem.status === "已办结") return;
    eventItem.status = "已办结";
    eventItem.closedAt = Date.now();  // 连接服务器时以服务器写入的办结时间为准
    (eventItem.timeline || (eventItem.timeline = [])).forEach((item) => { if (item.state === "current") item.state = "done"; });
    eventItem.timeline.push({ time: "刚刚", text: note, state: "done" });
  }

  function startSosSession(trigger, options = {}) {
    const duty = currentDutyStaff();
    const profile = state.data.profile;
    const existing = activeSosFor(profile.id);
    if (existing) {
      showToast("已有响应中的呼救", `${existing.id} 正在处理，无需重复发出。`, "warning");
      if (options.openStatus) openSosStatusModal(existing.id);
      return existing;
    }
    const movement = getMovementLogs().find((log) => log.residentId === profile.id && isMovementActive(log));
    const now = new Date();
    const session = {
      id: uniqueRecordId("SOS"),
      residentId: profile.id,
      resident: profile.name,
      residentPhone: profile.phone || "",
      institution: profile.institution,
      location: options.location || (movement ? `机构外 · ${movement.destination}` : `${profile.institution} · ${profile.room}`),
      trigger,
      transcript: options.transcript || "",
      riskLevel: "high",
      status: "waiting",
      escalation: 1,
      createdAt: Date.now(),
      createdLabel: `今日 ${sosClock().slice(0, 5)}`,
      resolvedLabel: "",
      callback: { status: "dialing", attempts: 1, startedAt: Date.now() },
      claimedBy: "",
      responseSeconds: null,
      notified: { manager: false, family: false, regulator: false },
      dutyShift: `${duty.shift} · ${duty.name}`,
      contacts: [
        { role: duty.title || "机构值班员", name: duty.name, phone: duty.phone, shift: duty.shift },
        { role: "机构负责人", name: "黄志强", phone: "137****2214" },
        { role: "紧急联系人", name: profile.emergencyName || "家属", phone: profile.emergencyPhone || "" }
      ],
      linkedEventId: options.linkedEventId || "",
      timeline: [
        { time: sosClock(), text: `触发呼救（${trigger}${options.transcript ? `：“${options.transcript.slice(0, 30)}”` : ""}）`, state: "done" },
        { time: sosClock(), text: "平台受理，开始自动回拨并推送值班响应队列", state: "current" }
      ]
    };
    getSosSessions().unshift(session);
    ensureSosTicker();
    saveSos("触发应急呼救", session.id);
    showToast("呼救已发出", "平台已生成站内响应工单；原型回拨为模拟流程，情况危急请直接拨打120或110。", "warning");
    if (state.role) renderPage();
    if (options.openStatus) openSosStatusModal(session.id);
    return session;
  }

  function openSosLauncher() {
    const active = activeSosFor(state.data.profile.id);
    if (active) return openSosStatusModal(active.id);
    if (state.sosLaunchTimer) { window.clearInterval(state.sosLaunchTimer); state.sosLaunchTimer = null; }
    let remain = SOS_CONFIG.launchCountdownSeconds;
    openModal({
      title: "即将发出紧急呼救",
      subtitle: "误触可在倒计时内取消，不会留下呼救记录",
      body: `
        <div class="sos-launch">
          <div class="sos-launch-count"><strong id="sos-launch-count">${remain}</strong><span>秒后自动发出</span></div>
          <p>发出后：机构值班人员马上收到呼救，须在<b>${SOS_CONFIG.claimSlaSeconds}秒内接单</b>并联系您（<b>${escapeHtml(state.data.profile.phone || "本人电话")}</b>）；超时会在站内提醒机构负责人和紧急联系人<b>${escapeHtml(state.data.profile.emergencyName || "家属")}</b>，再超时升级监管端应急联动。</p>
          <p class="meta-text">演示环境中的自动回拨为模拟流程，不会真的拨打电话。</p>
          <div class="notice">${icon("phone-call")}情况危急时不必等待，请直接拨打120。</div>
        </div>
      `,
      footer: `<button class="btn btn-secondary" type="button" data-action="sos-abort-launch">我按错了，取消</button><a class="btn btn-secondary" href="tel:120">${icon("phone")}直接拨打120</a><button class="btn btn-danger" type="button" data-action="sos-send-now">${icon("siren")}立即发出</button>`,
      onOpen: () => {
        state.sosLaunchTimer = window.setInterval(() => {
          remain -= 1;
          const counter = document.getElementById("sos-launch-count");
          if (!counter) { window.clearInterval(state.sosLaunchTimer); state.sosLaunchTimer = null; return; }
          counter.textContent = String(Math.max(0, remain));
          if (remain <= 0) {
            window.clearInterval(state.sosLaunchTimer);
            state.sosLaunchTimer = null;
            startSosSession("一键呼救", { openStatus: true });
          }
        }, 1000);
      }
    });
  }

  function abortSosLaunch() {
    if (state.sosLaunchTimer) { window.clearInterval(state.sosLaunchTimer); state.sosLaunchTimer = null; }
    closeModal();
    showToast("呼救已取消", "本次未发出呼救，不会通知任何人。", "success");
  }

  function sosLaunchNow() {
    if (state.sosLaunchTimer) { window.clearInterval(state.sosLaunchTimer); state.sosLaunchTimer = null; }
    startSosSession("一键呼救", { openStatus: true });
  }

  function renderSosStages(session) {
    const callback = session.callback || {};
    const resolved = !SOS_ACTIVE_STATUSES.has(session.status);
    const stageState = (done, current) => (done ? "done" : current ? "current" : "");
    const callbackDone = ["answered_danger", "answered_safe", "no_answer"].includes(callback.status);
    const claimedDone = Boolean(session.claimedBy) || resolved;
    const stages = [
      { text: "平台受理呼救", state: "done", note: session.createdLabel },
      { text: "自动回拨确认", state: stageState(callbackDone, !callbackDone), note: sosCallbackText(session) },
      { text: `值班人员接单（SLA ${SOS_CONFIG.claimSlaSeconds}秒）`, state: stageState(claimedDone, callbackDone && !claimedDone), note: session.claimedBy ? `值班员 ${session.claimedBy} · 用时${session.responseSeconds != null ? `${session.responseSeconds}秒` : "—"}` : session.escalation >= 2 ? "超时已升级通知" : "等待接单" },
      { text: "处置闭环", state: stageState(resolved, claimedDone && !resolved), note: resolved ? `${sosStatusLabel(session)} · ${session.resolvedLabel || ""}` : "处置中" }
    ];
    return `<div class="timeline sos-stage-list">${stages.map((stage) => `<div class="timeline-item ${stage.state}"><span class="timeline-dot"></span><div class="timeline-copy"><strong>${escapeHtml(stage.text)}</strong><span>${escapeHtml(stage.note || "")}</span></div></div>`).join("")}</div>`;
  }

  function openSosStatusModal(id) {
    const session = getSos(id);
    if (!session) return;
    const active = SOS_ACTIVE_STATUSES.has(session.status);
    const notified = session.notified || {};
    openModal({
      title: active ? "平台正在响应您的呼救" : "本次呼救已闭环",
      subtitle: `${session.id} · ${session.trigger} · ${session.createdLabel}`,
      body: `
        <div data-sos-modal="${session.id}">
          <div class="sos-status-head ${active ? "" : "settled"}">
            ${active ? '<span class="sos-pulse"></span>' : icon("badge-check")}
            <div><strong>${escapeHtml(active ? "工作人员正在赶来，请留在原地" : sosStatusLabel(session))}</strong><small>发生位置：${escapeHtml(session.location)}</small></div>
            ${sosStatusTag(session)}
          </div>
          ${active && session.status === "waiting" ? `<div class="sos-count-line"><span data-sos-phase="${session.id}">${escapeHtml(sosPhaseText(session))}</span><strong class="sos-countdown" data-sos-countdown="${session.id}">${sosCountdownText(session)}</strong></div>` : ""}
          <div class="sos-callback-line">${icon("phone-call")}<span data-sos-callback="${session.id}">${escapeHtml(sosCallbackText(session))}</span></div>
          ${session.claimedBy ? `<div class="sos-claimed-card">${icon("user-round-check")}<div><strong>值班员 ${escapeHtml(session.claimedBy)} 已接单</strong><small>响应用时 ${session.responseSeconds != null ? `${session.responseSeconds}秒` : "—"} · 正在电话确认并派人到场</small></div><button class="btn btn-secondary" type="button" data-action="dial" data-number="${escapeHtml(sosDutyPhone(session))}" data-label="值班员 ${escapeHtml(session.claimedBy)}">${icon("phone")}回拨值班员</button></div>` : ""}
          ${renderSosStages(session)}
          <div class="profile-grid sos-contact-grid">
            ${(session.contacts || []).map((contact) => {
              const informed = (contact.role === "机构负责人" && notified.manager) || (contact.role === "紧急联系人" && notified.family) || contact.role === "机构值班员";
              return `<div class="data-field"><span>${escapeHtml(contact.role)}${informed ? ' · <b class="sos-informed">站内提醒</b>' : ""}</span><strong>${escapeHtml(contact.name)} ${escapeHtml(contact.phone || "")}</strong></div>`;
            }).join("")}
          </div>
          <div class="notice">${icon("shield-check")}响应全程留痕，可供监管核查；误触取消不追责，记录仅用于安全复盘。</div>
        </div>
      `,
      footer: `<a class="btn btn-danger" href="tel:120">${icon("phone")}拨打120</a>${active ? `<button class="btn btn-secondary" type="button" data-action="sos-cancel" data-id="${session.id}">我已安全，取消呼救</button>` : ""}<button class="btn btn-secondary" type="button" data-action="close-modal">关闭</button>`
    });
  }

  function confirmCancelSos(id) {
    const session = getSos(id);
    if (!session || !SOS_ACTIVE_STATUSES.has(session.status)) return;
    openModal({
      title: "确认您现在安全吗？",
      subtitle: `${session.id} · 取消后平台停止派人`,
      body: `<div class="sos-cancel-confirm">${icon("heart-handshake")}<p>如果只是误触或情况已缓解，点击“确认安全”即可取消本次呼救。<br>记录会完整保留（误触不追责），值班人员仍可能电话回访确认。</p></div>`,
      footer: `<button class="btn btn-secondary" type="button" data-action="sos-status" data-id="${session.id}">返回响应页</button><button class="btn btn-danger" type="button" data-action="sos-cancel-confirm" data-id="${session.id}">${icon("check")}确认安全并取消</button>`
    });
  }

  function cancelSos(id) {
    const session = getSos(id);
    if (!session || !SOS_ACTIVE_STATUSES.has(session.status)) return;
    session.status = "cancelled";
    session.resolvedLabel = `今日 ${sosClock().slice(0, 5)}`;
    pushSosTimeline(session, "本人确认安全并主动取消（系统留痕，误触不追责）", "done");
    closeSosLinkedEvent(session, "本人确认安全，联动事件关闭");
    saveSos("本人取消应急呼救", session.id);
    closeModal();
    showToast("呼救已取消", "记录已留痕，值班人员可能电话回访确认您的安全。", "success");
    if (state.role) renderPage();
  }

  function claimSos(id) {
    const session = getSos(id);
    if (!session || session.status !== "waiting") return;
    const account = state.data.accounts[state.role];
    const duty = currentDutyStaff();
    session.status = "claimed";
    session.claimedBy = account ? account.name : duty.name;
    session.claimedShift = duty.shift;
    session.responseSeconds = sosElapsedSeconds(session);
    pushSosTimeline(session, `${duty.shift}值班员${session.claimedBy}已接单（响应用时${session.responseSeconds}秒），正在电话确认并派人到场`);
    saveSos("值班人员接单应急呼救", session.id);
    showToast("已接单", `${session.id} · 请先电话确认，再安排人员到场。`, "success");
    refreshSosUi();
  }

  function openSosCallbackModal(id) {
    const session = getSos(id);
    if (!session) return;
    openModal({
      title: "记录回拨确认结果",
      subtitle: `${session.id} · ${session.resident} · ${session.residentPhone}`,
      body: `
        <div class="sos-callback-options">
          <button class="sos-outcome-btn danger" type="button" data-action="sos-callback-outcome" data-id="${session.id}" data-outcome="answered_danger">${icon("siren")}<span><strong>接通 · 确认危险</strong><small>保持通话安抚，立即派人到场</small></span></button>
          <button class="sos-outcome-btn success" type="button" data-action="sos-callback-outcome" data-id="${session.id}" data-outcome="answered_safe">${icon("badge-check")}<span><strong>接通 · 本人确认安全</strong><small>误触或已缓解，办结并留痕</small></span></button>
          <button class="sos-outcome-btn warning" type="button" data-action="sos-callback-outcome" data-id="${session.id}" data-outcome="no_answer">${icon("phone-missed")}<span><strong>未接通</strong><small>立即通知负责人与紧急联系人并派人查看</small></span></button>
        </div>
      `,
      footer: `<button class="btn btn-secondary" type="button" data-action="close-modal">返回</button>`
    });
  }

  function recordSosCallback(id, outcome) {
    const session = getSos(id);
    if (!session) return;
    session.callback = session.callback || { attempts: 1 };
    session.callback.status = outcome;
    const account = state.data.accounts[state.role];
    const operator = account ? account.name : "值班人员";
    if (outcome === "answered_safe") {
      pushSosTimeline(session, `回拨接通：本人确认安全（${operator}电话核实）`, "done");
      session.status = "resolved_safe";
      session.resolvedLabel = `今日 ${sosClock().slice(0, 5)}`;
      closeSosLinkedEvent(session, "电话核实本人安全，联动事件关闭");
      showToast("已确认安全并办结", `${session.id} 已留痕关闭。`, "success");
    } else if (outcome === "answered_danger") {
      if (session.status === "waiting") {
        session.status = "claimed";
        session.claimedBy = operator;
        session.responseSeconds = sosElapsedSeconds(session);
      }
      pushSosTimeline(session, "回拨接通：确认存在危险，保持通话并立即派人到场");
      ensureSosLinkedEvent(session);
      showToast("已确认危险", "请保持通话安抚老人，人员立即出发。", "warning");
    } else {
      pushSosTimeline(session, `人工回拨未接通（${operator}）`);
      if (session.status === "waiting" && session.escalation < 2) sosEscalateLevel2(session);
      showToast("回拨未接通", "已生成机构负责人和紧急联系人站内提醒；请值班人员立即电话联系并到现场查看。", "warning");
    }
    saveSos("记录呼救回拨结果", session.id);
    closeModal();
    refreshSosUi();
  }

  function resolveSos(id, mode) {
    const session = getSos(id);
    if (!session || !SOS_ACTIVE_STATUSES.has(session.status)) return;
    session.resolvedLabel = `今日 ${sosClock().slice(0, 5)}`;
    if (mode === "dispatched") {
      session.escalation = Math.max(session.escalation, 3);
      session.notified = session.notified || {};
      session.notified.regulator = true;
      ensureSosLinkedEvent(session);
      session.status = "resolved_dispatched";
      pushSosTimeline(session, "已联动120/110：推送位置、健康档案摘要与责任人信息", "done");
      showToast("已联动120/110", "联动事件保持处置中，等待属地反馈闭环。", "warning");
    } else if (mode === "safe") {
      session.status = "resolved_safe";
      pushSosTimeline(session, "值班员确认本人安全，办结留痕", "done");
      closeSosLinkedEvent(session, "值班员确认本人安全，联动事件关闭");
      showToast("已确认安全办结", `${session.id} 全程记录已留痕。`, "success");
    } else {
      session.status = "resolved_handled";
      pushSosTimeline(session, "工作人员到场处置完成，结果已回填动态台账", "done");
      closeSosLinkedEvent(session, "现场处置完成，联动事件办结");
      showToast("处置完成", `${session.id} 已闭环，响应记录可供监管核查。`, "success");
    }
    saveSos("应急呼救处置闭环", session.id);
    refreshSosUi();
  }

  function escalateSosNow(id) {
    const session = getSos(id);
    if (!session || !SOS_ACTIVE_STATUSES.has(session.status) || session.escalation >= 3) return;
    sosEscalateLevel3(session);
    pushSosTimeline(session, `${state.role === "regulator" ? "监管端" : "机构端"}手动升级应急联动调度`);
    saveSos("手动升级应急联动", session.id);
    showToast("已升级应急联动", "监管端已生成联动建议；请授权人员确认并通过真实渠道联系属地。", "warning");
    refreshSosUi();
  }

  function sosStats() {
    const sessions = getSosSessions();
    const claims = sessions.filter((session) => typeof session.responseSeconds === "number");
    const avgClaim = claims.length ? Math.round(claims.reduce((sum, session) => sum + session.responseSeconds, 0) / claims.length) : null;
    const outcomes = sessions.filter((session) => ["answered_danger", "answered_safe", "no_answer"].includes((session.callback || {}).status));
    const answered = outcomes.filter((session) => String((session.callback || {}).status).startsWith("answered")).length;
    const sla = sosSlaSummary(sessions);
    return {
      total: sessions.length,
      active: sessions.filter((session) => SOS_ACTIVE_STATUSES.has(session.status)).length,
      avgClaim,
      answerRate: outcomes.length ? Math.round((answered / outcomes.length) * 100) : null,
      escalated: sessions.filter((session) => session.escalation >= 3).length,
      falseTouch: sessions.filter((session) => sosOutcome(session) === "excluded").length,
      sla
    };
  }

  // 达标率连同分母一起显示：例如“1/3 按时（33%）”，不把只统计已接单的比例当作整体达标率
  function sosRateText(sla, compact = false) {
    if (!sla.assessed) return compact ? "—" : "暂无已到考核时点的工单";
    return compact ? `${sla.overallRate}%` : `${sla.on_time}/${sla.assessed} 按时（${sla.overallRate}%）`;
  }

  /* 监管口径：按机构聚合真实呼救留痕，形成可考核的响应时效排行。 */
  function institutionSosStats() {
    const sessions = getSosSessions();
    const grouped = new Map();
    sessions.forEach((session) => {
      const name = session.institution || "未归属机构";
      if (!grouped.has(name)) grouped.set(name, []);
      grouped.get(name).push(session);
    });
    const rows = (state.data.institutions || []).map((institution) => {
      const own = grouped.get(institution.name) || [];
      grouped.delete(institution.name);
      const claims = own.filter((session) => typeof session.responseSeconds === "number");
      const avg = claims.length ? Math.round(claims.reduce((sum, session) => sum + session.responseSeconds, 0) / claims.length) : null;
      const sla = sosSlaSummary(own);
      return {
        name: institution.name,
        city: institution.city,
        total: own.length,
        avg,
        breached: sla.late + sla.missed,
        missed: sla.missed,
        active: own.filter((session) => SOS_ACTIVE_STATUSES.has(session.status)).length,
        declared: institution.response || "—",
        compliance: sla.overallRate,
        sla
      };
    });
    grouped.forEach((own, name) => {
      const claims = own.filter((session) => typeof session.responseSeconds === "number");
      const sla = sosSlaSummary(own);
      rows.push({
        name,
        city: "—",
        total: own.length,
        avg: claims.length ? Math.round(claims.reduce((sum, session) => sum + session.responseSeconds, 0) / claims.length) : null,
        breached: sla.late + sla.missed,
        missed: sla.missed,
        active: own.filter((session) => SOS_ACTIVE_STATUSES.has(session.status)).length,
        declared: "—",
        compliance: sla.overallRate,
        sla
      });
    });
    return rows.sort((a, b) => {
      if (a.total !== b.total) return b.total - a.total;
      if (a.avg === null) return 1;
      if (b.avg === null) return -1;
      return a.avg - b.avg;
    });
  }

  function renderSosRankingPanel() {
    const rows = institutionSosStats().filter((row) => row.total > 0);
    if (!rows.length) {
      return `<section class="panel"><header class="panel-header"><div class="section-head-copy"><h3>机构应急响应时效排行</h3><p>数据来源：呼救工单留痕</p></div></header><div class="panel-body"><p class="empty-hint">暂无呼救留痕，触发一次呼救后即可生成机构响应时效排行。</p></div></section>`;
    }
    return `<section class="panel sos-rank-panel">
      <header class="panel-header"><div class="section-head-copy"><h3>机构应急响应时效排行</h3><p>按真实呼救留痕聚合 · 接单时限 ${SOS_CONFIG.claimSlaSeconds} 秒 · 达标率分母含超时未接单</p></div><span class="status-tag ${rows.some((row) => row.breached) ? "warning" : "success"}">${rows.length}家有呼救记录</span></header>
      <div class="panel-body"><div class="sos-rank-table" role="table" aria-label="机构应急响应时效排行">
        <div class="sos-rank-row head" role="row"><span role="columnheader">机构</span><span role="columnheader">呼救量</span><span role="columnheader">平均接单</span><span role="columnheader">整体达标</span><span role="columnheader">超时 / 未接单</span></div>
        ${rows.map((row) => `<div class="sos-rank-row ${row.breached ? "warn" : ""}" role="row">
          <span role="cell"><strong>${escapeHtml(row.name)}</strong><small>${escapeHtml(row.city)}${row.active ? ` · ${row.active}条响应中` : ""}</small></span>
          <span role="cell">${row.total}</span>
          <span role="cell" class="sos-rank-metric">${row.avg != null ? `${row.avg}秒` : "—"}</span>
          <span role="cell" title="按时接单 ÷（按时 + 超时后接单 + 超时未接单）；时限内本人取消不计入">${row.compliance != null ? `${row.sla.on_time}/${row.sla.assessed}（${row.compliance}%）` : "—"}</span>
          <span role="cell">${row.breached ? `<span class="status-tag ${row.missed ? "danger" : "warning"}">${row.breached}次${row.missed ? ` · 未接单${row.missed}` : ""}</span>` : `<span class="status-tag success">0次</span>`}</span>
        </div>`).join("")}
      </div>
      </div>
    </section>`;
  }

  function toggleSosMute() {
    state.sos.muted = !state.sos.muted;
    if (!state.sos.muted) playSosChime([660]);
    showToast(state.sos.muted ? "已关闭呼救提示音" : "已开启呼救提示音", state.sos.muted ? "队列仍会实时刷新，仅不再播放提示音。" : "新的呼救工单将伴随提示音提醒。", state.sos.muted ? "warning" : "success");
    refreshSosUi();
  }

  function sosQueueActions(session, role) {
    if (!SOS_ACTIVE_STATUSES.has(session.status)) return `<button class="text-btn" type="button" data-action="sos-detail" data-id="${session.id}">查看留痕${icon("arrow-right")}</button>`;
    if (role === "regulator") {
      const escalate = session.escalation >= 3 ? `<span class="status-tag danger">联动中</span>` : `<button class="btn btn-danger" type="button" data-action="sos-escalate" data-id="${session.id}">${icon("radio-tower")}立即联动调度</button>`;
      return `${escalate}<button class="btn btn-secondary" type="button" data-action="sos-detail" data-id="${session.id}">详情</button>`;
    }
    if (session.status === "waiting") {
      return `<button class="btn btn-primary" type="button" data-action="sos-claim" data-id="${session.id}">${icon("hand")}接单</button><button class="btn btn-secondary" type="button" data-action="sos-callback" data-id="${session.id}">${icon("phone-call")}记录回拨结果</button><button class="btn btn-secondary" type="button" data-action="sos-detail" data-id="${session.id}">详情</button>`;
    }
    return `<button class="btn btn-secondary" type="button" data-action="sos-callback" data-id="${session.id}">${icon("phone-call")}记录回拨结果</button><button class="btn btn-primary" type="button" data-action="sos-resolve" data-id="${session.id}" data-mode="handled">${icon("check-check")}到场处置完成</button><button class="btn btn-secondary" type="button" data-action="sos-resolve" data-id="${session.id}" data-mode="safe">确认安全办结</button><button class="btn btn-danger" type="button" data-action="sos-resolve" data-id="${session.id}" data-mode="dispatched">${icon("siren")}联动120/110</button>`;
  }

  function renderSosQueuePanel(role, options = {}) {
    const sessions = getSosSessions();
    if (!sessions.length && !options.always) return "";
    const active = sessions.filter((session) => SOS_ACTIVE_STATUSES.has(session.status));
    const recent = sessions.filter((session) => !SOS_ACTIVE_STATUSES.has(session.status)).slice(0, 3);
    const stats = sosStats();
    return `
      <section class="panel sos-queue-panel" aria-live="polite" aria-relevant="additions">
        <div class="panel-header">
          <div class="section-head-copy"><h3>应急呼救（安心应答）</h3><p>${SOS_CONFIG.claimSlaSeconds} 秒内接单 · 超 ${SOS_CONFIG.regulatorEscalateSeconds} 秒升级监管联动${state.backend.enabled ? " · 超时升级由服务器后台值守执行，关闭页面也照常推进" : " · 离线演示：由本页计时"}</p></div>
          <div class="sos-queue-head-actions">
            ${active.length ? `<span class="status-tag danger">${active.length}条响应中</span>` : `<span class="status-tag neutral">当前无呼救</span>`}
            <button class="icon-btn" type="button" data-action="sos-mute" aria-pressed="${state.sos.muted}" title="${state.sos.muted ? "开启提示音" : "关闭提示音"}" aria-label="${state.sos.muted ? "开启呼救提示音" : "关闭呼救提示音"}">${icon(state.sos.muted ? "bell-off" : "bell-ring")}</button>
          </div>
        </div>
        <div class="panel-body">
          ${active.map((session) => `
            <div class="sos-queue-item level-${session.escalation}">
              <div class="sos-queue-main"><span class="sos-pulse"></span><div><strong>${escapeHtml(session.id)} · ${escapeHtml(session.resident)}</strong><small>${escapeHtml(session.trigger)} · ${escapeHtml(session.createdLabel)} · ${escapeHtml(session.location)}</small>${session.transcript ? `<small class="sos-transcript">“${escapeHtml(session.transcript)}”</small>` : ""}</div>${sosStatusTag(session)}</div>
              <div class="sos-queue-meta"><span data-sos-phase="${session.id}">${escapeHtml(sosPhaseText(session))}</span><strong class="sos-countdown" data-sos-countdown="${session.id}">${sosCountdownText(session)}</strong><span class="sos-callback-chip" data-sos-callback="${session.id}">${escapeHtml(sosCallbackText(session))}</span></div>
              <div class="sos-queue-actions">${sosQueueActions(session, role)}</div>
            </div>
          `).join("") || `<p class="sos-idle">${icon("shield-check")}当前没有进行中的呼救。有人呼救时这里会响铃，并开始 ${SOS_CONFIG.claimSlaSeconds} 秒接单倒计时。</p>`}
          ${recent.length ? `<div class="sos-recent"><span class="eyebrow">近期呼救留痕</span>${recent.map((session) => `<button class="sos-recent-row" type="button" data-action="sos-detail" data-id="${session.id}"><strong>${escapeHtml(session.id)}</strong><span>${escapeHtml(session.resident)} · ${escapeHtml(session.trigger)}</span>${sosStatusTag(session)}<span class="sos-recent-metric">${typeof session.responseSeconds === "number" ? `接单${session.responseSeconds}秒` : "—"}</span>${icon("arrow-right")}</button>`).join("")}</div>` : ""}
          ${role === "regulator" ? `<div class="quality-metrics sos-metrics"><div><strong>${sosRateText(stats.sla, true)}</strong><span>整体达标（${stats.sla.on_time}/${stats.sla.assessed}）</span></div><div><strong>${stats.avgClaim != null ? `${stats.avgClaim}秒` : "—"}</strong><span>平均接单时长</span></div><div><strong class="${stats.sla.missed ? "tone-high" : ""}">${stats.sla.missed}</strong><span>超时未接单</span></div><div><strong>${stats.escalated}</strong><span>升级联动次数</span></div></div>` : ""}
        </div>
      </section>
    `;
  }

  function openSosDetailModal(id) {
    const session = getSos(id);
    if (!session) return;
    const notified = session.notified || {};
    openModal({
      title: `呼救工单 ${session.id}`,
      subtitle: `${session.resident} · ${session.trigger} · ${session.createdLabel}`,
      wide: true,
      body: `
        <div data-sos-detail="${session.id}" class="panel-grid equal">
          <div>
            <div class="action-card ${SOS_ACTIVE_STATUSES.has(session.status) ? "danger" : ""}"><h3>${sosStatusTag(session)} ${escapeHtml(session.resident)}</h3><p>${escapeHtml(session.transcript ? `原话：“${session.transcript}”` : session.deviceId ? `安全设备自动告警（${session.deviceId}），无语音。` : "无语音转写，来自按键触发。")}</p></div>
            <div class="profile-grid mt-4">
              <div class="data-field"><span>发生位置</span><strong>${escapeHtml(session.location)}</strong></div>
              <div class="data-field"><span>本人电话</span><strong>${escapeHtml(session.residentPhone || "—")}</strong></div>
              <div class="data-field"><span>回拨状态</span><strong data-sos-callback="${session.id}">${escapeHtml(sosCallbackText(session))}</strong></div>
              <div class="data-field"><span>响应阶段</span><strong data-sos-phase="${session.id}">${escapeHtml(sosPhaseText(session))}</strong></div>
              ${(session.contacts || []).map((contact) => {
                const informed = (contact.role === "机构负责人" && notified.manager) || (contact.role === "紧急联系人" && notified.family) || contact.role === "机构值班员";
                return `<div class="data-field"><span>${escapeHtml(contact.role)}${informed ? ' · <b class="sos-informed">站内提醒</b>' : ""}</span><strong>${escapeHtml(contact.name)} ${escapeHtml(contact.phone || "")}</strong></div>`;
              }).join("")}
              ${session.linkedEventId ? `<div class="data-field"><span>联动事件</span><strong>${escapeHtml(session.linkedEventId)}</strong></div>` : ""}
            </div>
            <div class="notice mt-4">${icon("shield-check")}接单时长、回拨结果与升级链路全程留痕，计入机构响应时效考核。</div>
          </div>
          <div class="section-head-copy"><h3>响应留痕时间线</h3><div class="timeline">${(session.timeline || []).map((item) => `<div class="timeline-item ${item.state}"><span class="timeline-dot"></span><div class="timeline-copy"><strong>${escapeHtml(item.text)}</strong><span>${escapeHtml(item.time)}</span></div></div>`).join("")}</div></div>
        </div>
      `,
      footer: `${state.role !== "elder" ? `<div class="sos-queue-actions">${sosQueueActions(session, state.role)}</div>` : ""}<button class="btn btn-secondary" type="button" data-action="close-modal">关闭</button>`
    });
  }

  function sosBandHtml() {
    const profile = state.data.profile;
    const active = activeSosFor(profile.id);
    if (active) {
      return `
        <section class="sos-live-banner" role="button" tabindex="0" data-action="sos-status" data-id="${active.id}" aria-label="平台正在响应您的呼救，回车查看进度">
          <span class="sos-pulse"></span>
          <div aria-live="polite" aria-atomic="true"><strong>平台正在响应您的呼救</strong><small class="sos-live-id">工单 ${escapeHtml(active.id)}</small><small><span data-sos-phase="${active.id}">${escapeHtml(sosPhaseText(active))}</span> <b class="sos-countdown" data-sos-countdown="${active.id}">${sosCountdownText(active)}</b> · <span data-sos-callback="${active.id}">${escapeHtml(sosCallbackText(active))}</span></small></div>
          <span class="btn btn-secondary">查看进度</span>
        </section>
        <a class="btn btn-danger sos-direct" href="tel:120">${icon("phone")}直接拨打120</a>
      `;
    }
    return `
      <section class="sos-band" aria-label="紧急呼救">
        <button class="sos-big-btn" type="button" data-action="sos-press" aria-label="一键呼救，按下后有${SOS_CONFIG.launchCountdownSeconds}秒确认时间，可随时取消">
          <span class="sos-big-icon">${icon("siren")}</span>
          <span><strong>一键呼救</strong><small>遇到危险按这里，马上通知值班人员</small></span>
        </button>
        <a class="btn btn-danger sos-direct" href="tel:120">${icon("phone")}直接拨打120</a>
      </section>
    `;
  }
  // ===================== 平台应急响应闭环 · 结束 =====================

  // 演示指引：“一位北海旅居老人的一天”，每一步写清用哪个身份、做什么、给评委看什么
  const DEMO_PROGRESS_KEY = "gy-demo-progress";
  const DEMO_STEPS = [
    { time: "上午", role: "elder", title: "老人问小桂：能不能去爬山", do: "老人端首页点“按一下，开始说话”，说或点“明天想去巴马长寿村爬山”。", show: "小桂先查档案、动向、路线，再建议改走平缓步道，并生成外出报备草稿；点“确认报备”。" },
    { time: "上午", role: "provider", title: "机构收到报备，核验责任人", do: "机构端 → 动态台账，找到刚才的“待核验”报备。", show: "报备带着 AI 的路线评估进入机构台账，责任人、返回时间一目了然。" },
    { time: "下午", role: "elder", title: "有人让老人先交定金", do: "老人端说“有个养生基地让我今天交一万块定金”，点“确认提交”；再追问“那我要是已经交了怎么办？”。最后再点“儿子说住院了，要我转他1000”。", show: "先稳住“今天先别交”，电话固定 110；追问后第一条建议是报警和银行止付，工单自动带上证据链。儿子要钱这句不会一上来就让报警：先让老人打儿子平时的号码核实，并请儿子回电——AI 分得清“家人真要钱”和“有人冒充”。" },
    { time: "下午", role: "regulator", title: "监管端发现同类骗局", do: "监管端 → 类案雷达（几秒内会弹出“第 4 位老人报告了相似话术”），点新个案“查看证据链”，再点“导出证据材料”。", show: "不同老人的上报按相似手法自动归成一类，每条都能追到老人原话、查证过程和确认时间；是否同一主体由人工核实，归错的个案可以一键移出；一键推送防骗提醒。" },
    { time: "傍晚", role: "regulator", title: "台风来了，一键报平安", do: "监管总览点“发布天气预警”，选北海；切到老人端，横幅会自动朗读，点“我很安全”；机构端给另一位老人代报。", show: "受影响老人按“正在外出 > 独居 > 高风险”排序；报平安率实时变化，超时未回应自动升级、一键督办。" },
    { time: "夜里", role: "provider", title: "居家老人夜里摔倒", do: "机构端 → 安全设备，吴秀珍的“跌倒监测雷达”点“模拟告警”。", show: "设备告警直接生成呼救工单，响铃并开始 30 秒接单倒计时，同时通知社区网格员。" },
    { time: "第二天", role: "regulator", title: "主管部门看全局", do: "监管端 → 运行态势研判，点“让 AI 参谋研判”。", show: "AI 参谋把这一天的事件、类案、报平安和机构评分串起来，给出带证据编号的督办建议。" }
  ];

  // 评审 5 分钟路线：从监管结果进入，同一件事贯穿三端；时间为建议安排
  const DEMO_QUICK = [
    { slot: "0:00–0:40", role: "regulator", text: "监管总览：谁超时、哪些风险待处理、哪类问题反复出现；点开一个待处置类案。" },
    { slot: "0:40–2:00", role: "elder", text: "老人说“有个养生基地让我今天交一万块定金”，看小桂查证，再点“确认提交”，记下事件编号。" },
    { slot: "2:00–3:00", role: "regulator", text: "类案雷达弹出“第 4 位老人报告了相似话术”，打开同一编号的证据链，推送提醒、移交督办。" },
    { slot: "3:00–4:15", role: "provider", text: "设备模拟告警 → 机构接单；也可以关掉所有页面，约 80 秒后再打开，看后台值守已完成升级并留痕。" },
    { slot: "4:15–5:00", role: "regulator", text: "态势研判与建档核对：说明哪些是合成样本、哪些已实现、哪些待试点接入。" }
  ];

  function demoProgress() {
    try { return JSON.parse(localStorage.getItem(DEMO_PROGRESS_KEY) || "[]"); } catch (error) { return []; }
  }

  function demoGuideBody() {
    const done = new Set(demoProgress());
    const roleName = { elder: "老人端", provider: "机构端", regulator: "监管端" };
    return `<div class="demo-guide">
      <p class="demo-guide-intro">建议开两个浏览器窗口，左边监管端或机构端，右边老人端。演示前双击“重置演示数据.bat”恢复初始数据（样本日期会对齐到当天）。</p>
      <section class="demo-quick"><strong>${icon("timer")}评审 5 分钟路线（建议）</strong><ol>${DEMO_QUICK.map((item) => `<li><span class="demo-time">${item.slot}</span><span class="demo-role role-${item.role}">${roleName[item.role]}</span><p>${escapeHtml(item.text)}</p></li>`).join("")}</ol></section>
      <p class="demo-guide-intro"><b>完整路线：一位北海旅居老人的一天</b></p>
      <ol class="demo-steps">${DEMO_STEPS.map((step, index) => `<li class="${done.has(index) ? "done" : ""}">
        <button class="demo-check" type="button" data-action="demo-step" data-index="${index}" aria-pressed="${done.has(index)}" aria-label="标记第 ${index + 1} 步${done.has(index) ? "未完成" : "已完成"}">${done.has(index) ? icon("check") : index + 1}</button>
        <div class="demo-step-copy">
          <div class="demo-step-head"><span class="demo-time">${step.time}</span><strong>${escapeHtml(step.title)}</strong><span class="demo-role role-${step.role}">${roleName[step.role]}</span></div>
          <p><b>操作</b>${escapeHtml(step.do)}</p>
          <p><b>讲解</b>${escapeHtml(step.show)}</p>
        </div>
        ${state.role !== step.role ? `<button class="text-btn" type="button" data-action="demo-open-role" data-role="${step.role}">新窗口打开${roleName[step.role]}${icon("external-link")}</button>` : `<span class="demo-here">当前身份</span>`}
      </li>`).join("")}</ol>
    </div>`;
  }

  function openDemoGuide() {
    const total = DEMO_STEPS.length;
    const done = demoProgress().length;
    openModal({
      title: "演示指引 · 一位北海旅居老人的一天",
      subtitle: `共 ${total} 步，已完成 ${done} 步；进度只保存在本浏览器`,
      wide: true,
      body: demoGuideBody(),
      footer: `<button class="btn btn-ghost" type="button" data-action="demo-reset">${icon("rotate-ccw")}清空进度</button><button class="btn btn-primary" type="button" data-action="close-modal">开始演示</button>`
    });
  }

  function toggleDemoStep(index) {
    const set = new Set(demoProgress());
    set.has(index) ? set.delete(index) : set.add(index);
    try { localStorage.setItem(DEMO_PROGRESS_KEY, JSON.stringify([...set])); } catch (error) { /* 进度只是便利功能 */ }
    const body = modalRoot.querySelector(".demo-guide");
    if (body) { body.outerHTML = demoGuideBody(); refreshIcons(); }
    const subtitle = modalRoot.querySelector(".modal-header p");
    if (subtitle) subtitle.textContent = `共 ${DEMO_STEPS.length} 步，已完成 ${set.size} 步；进度只保存在本浏览器`;
  }

  // 证据链导出：把老人原话、系统查证过程和确认时间整理成可移交的文本材料
  function saveTextFile(filename, lines) {
    const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  function evidenceChainLines(event, index) {
    const evidence = event.evidence || {};
    const lines = [
      `${index}. ${event.id}  ${event.title}`,
      `   老人：${event.resident}（${event.residentId}）   上报时间：${event.time}   当前状态：${event.status}`,
      `   信息来源：${evidence.source || event.source || "老人上报"}${evidence.provider ? ` · ${evidence.provider}` : ""}`
    ];
    if (evidence.quotes?.length) {
      lines.push("   老人原话：");
      evidence.quotes.forEach((quote) => lines.push(`     “${quote.text}”${quote.time ? `（${quote.time}）` : ""}`));
    } else {
      lines.push(`   上报内容：${event.summary || event.title}`);
    }
    if (evidence.checks?.length) {
      lines.push("   系统查证：");
      evidence.checks.forEach((check) => lines.push(`     - ${check.label}：${check.result}`));
    }
    if (evidence.rules?.length) evidence.rules.forEach((rule) => lines.push(`   规则补充：${rule}`));
    if (evidence.movement) lines.push(`   动向：${evidence.movement}`);
    if (evidence.matchedAlert) lines.push(`   命中已推送的防骗提醒：${evidence.matchedAlert}`);
    if (evidence.confirmedAt) lines.push(`   老人确认提交：${evidence.confirmedAt}`);
    lines.push(`   建议处置：${event.action || "由承办人员核实"}`);
    return lines;
  }

  function exportEvidenceMaterial(title, subtitleLines, events, filename) {
    const who = state.data.accounts?.[state.role];
    const lines = [
      title,
      ...subtitleLines,
      `导出时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`,
      `导出人：${who ? `${who.name}（${who.org}）` : roleMeta[state.role]?.label || ""}`,
      "",
      "个案证据链",
      "",
      ...events.flatMap((event, index) => [...evidenceChainLines(event, index + 1), ""]),
      "说明",
      "1. 本材料由平台根据老人主动上报、系统查证记录和老人确认记录自动汇总，只作核查线索，不作为违法认定依据。",
      "2. 材料含老人个人信息，仅限承办人员核查使用，不得对外公开。",
      "3. 演示环境中的老人、机构和事件均为合成数据。"
    ];
    saveTextFile(filename, lines);
    showToast("证据材料已导出", `共 ${events.length} 件个案，已下载文本文件。`);
  }

  function exportClusterEvidence(id) {
    const cluster = (state.radar?.clusters || []).find((item) => item.id === id);
    if (!cluster) return;
    const report = cluster.report || {};
    const events = cluster.members.map((member) => getEvent(member.id)).filter(Boolean);
    exportEvidenceMaterial(`${cluster.kind === "fraud" ? "涉老诈骗" : "消费纠纷"}类案证据材料（供移交核查）`, [
      `类案：${report.title || cluster.id}（${cluster.id}）`,
      `涉及老人：${cluster.residents.join("、")}（${cluster.residents.length} 位，${cluster.count} 件）`,
      `共同线索：${(cluster.clues || []).join("、")}`,
      `研判：${report.judgement || ""}`,
      `建议措施：${(report.actions || []).join("；")}`
    ], events, `类案证据材料_${cluster.id}.txt`);
  }

  function exportEventEvidence(id) {
    const event = getEvent(id);
    if (!event) return;
    exportEvidenceMaterial("个案证据材料", [`事件：${event.title}（${event.id}）`, `类别：${event.category} · 风险：${riskLabel(event.level)} · 责任单位：${event.owner || "待指派"}`], [event], `个案证据材料_${event.id}.txt`);
  }

  function openEventDetail(id) {
    const event = getEvent(id);
    if (!event) return;
    const canHandle = state.role !== "elder" && event.status !== "已办结";
    const evidence = event.evidence && typeof event.evidence === "object" ? event.evidence : null;
    const evidenceSteps = evidence ? [
      ...(evidence.quotes || []).map((quote) => ({ time: quote.time, text: `老人原话：${quote.text}` })),
      ...(evidence.checks || []).map((check) => ({ time: "AI查证", text: `${check.label}：${check.result}` })),
      ...(evidence.rules || []).map((rule) => ({ time: "规则兜底", text: rule })),
      { time: evidence.confirmedAt || "待确认", text: "老人确认提交" }
    ] : [];
    openModal({
      title: event.title,
      subtitle: `${event.id} · ${event.category} · ${eventTimeText(event)}`,
      wide: true,
      body: `
        <div class="panel-grid equal">
          <div>
            <div class="action-card ${event.level === "high" ? "danger" : event.level === "medium" ? "warning" : ""}"><h3>${riskTag(event.level)} ${escapeHtml(event.resident)}</h3><p>${escapeHtml(event.summary)}</p></div>
            <div class="profile-grid mt-4"><div class="data-field"><span>发生地点</span><strong>${escapeHtml(event.location)}</strong></div><div class="data-field"><span>来源</span><strong>${escapeHtml(event.source)}</strong></div><div class="data-field"><span>责任单位</span><strong>${escapeHtml(event.owner)}</strong></div><div class="data-field"><span>处置时限</span><strong>${slaTag(event)}</strong><small class="meta-text">${escapeHtml([event.deadline ? `承诺：${event.deadline}` : "", event.dueAt ? `截止 ${friendlyTime(event.dueAt)}` : "", event.closedAt ? `办结 ${friendlyTime(event.closedAt)}` : "", event.reopenCount ? `重新打开 ${event.reopenCount} 次` : ""].filter(Boolean).join(" · "))}</small></div>${event.followUp ? `<div class="data-field"><span>回访结果</span><strong>${escapeHtml(event.followUp.result)}</strong>${event.followUp.note ? `<small class="meta-text">${escapeHtml(event.followUp.note)}</small>` : ""}</div>` : ""}${event.movementId ? `<div class="data-field"><span>关联动向</span><strong>${escapeHtml(event.movementId)} · ${event.locationScope === "outside" ? "机构外" : "机构内"}</strong></div>` : ""}</div>
            <div class="notice mt-4">${icon("list-checks")}建议动作：${escapeHtml(event.action)}</div>
            ${Array.isArray(event.rationale) && event.rationale.length ? `<div class="notice mt-2">${icon("file-check-2")}判断依据：${event.rationale.map((item) => escapeHtml(item)).join("；")}</div>` : ""}
            <section class="panel mt-4"><header class="panel-header"><div class="section-head-copy"><h3>对话证据链</h3><p>${escapeHtml(evidence?.source || "老人上报（无对话记录）")}${evidence?.provider ? ` · ${escapeHtml(evidence.provider)}` : ""}</p></div></header><div class="panel-body">${evidence ? `<div class="timeline">${evidenceSteps.map((step) => `<div class="timeline-item done"><span class="timeline-dot"></span><div class="timeline-copy"><strong>${escapeHtml(step.text)}</strong><span>${escapeHtml(step.time)}</span></div></div>`).join("")}</div>${evidence.movement ? `<p class="meta-text">${/^(计划行程|当前所在)/.test(evidence.movement) ? "" : "关联动向："}${escapeHtml(evidence.movement)}</p>` : ""}${evidence.matchedAlert ? `<p class="meta-text">命中防骗提醒：${escapeHtml(evidence.matchedAlert)}</p>` : ""}` : `<p class="meta-text">来源：老人上报（无对话记录）</p>`}</div></section>
          </div>
          <div class="section-head-copy"><h3>处置时间线</h3><div class="timeline">${(event.timeline || []).map((item) => `<div class="timeline-item ${item.state}"><span class="timeline-dot"></span><div class="timeline-copy"><strong>${escapeHtml(item.text)}</strong><span>${escapeHtml(item.time)}</span></div></div>`).join("")}</div></div>
        </div>
      `,
      footer: `${state.role !== "elder" ? `<button class="btn btn-ghost" type="button" data-action="event-export" data-id="${event.id}">${icon("file-down")}导出证据链</button>` : ""}${canHandle ? `<button class="btn btn-primary" type="button" data-action="handle-event" data-id="${event.id}">${icon("check-check")}更新处置结果</button>` : ""}<button class="btn btn-secondary" type="button" data-action="close-modal">关闭</button>`
    });
  }

  const HANDLE_NOTE_CHIPS = ["已电话联系老人核实情况", "已转交责任单位并告知老人", "已到现场查看并处置", "处置完成，已回访老人"];
  const FOLLOW_UP_OPTIONS = ["已回访，老人认可", "已回访，老人不认可", "无法联系到老人", "无需回访"];

  function openHandleEvent(id) {
    const event = getEvent(id);
    if (!event) return;
    const closed = event.status === "已办结";
    const sla = eventSla(event);
    const owners = [...new Set([event.owner, "北海银龄康养中心", "北海市卫健部门", "北海市市场监管部门", "北海市公安联络组", "12345政务服务便民热线"].filter(Boolean))];
    openModal({
      title: closed ? "查看或重新打开事件" : "更新处置结果",
      subtitle: `${event.id} · ${event.resident} · ${event.title}`,
      body: `<form id="event-handle-form" class="form-grid">
        <div class="full handle-sla"><span>处置时限</span>${slaTag(event)}<small>${escapeHtml([event.deadline ? `承诺：${event.deadline}` : "", event.dueAt ? `截止 ${friendlyTime(event.dueAt)}` : "", event.closedAt ? `办结 ${friendlyTime(event.closedAt)}` : ""].filter(Boolean).join(" · "))}${sla.state === "legacy" ? "（旧记录无服务器时间）" : ""}</small></div>
        <label><span>当前处置状态</span><select class="form-control" name="status">${["待复核", "处置中", "已转派", "已办结"].map((status) => `<option${event.status === status ? " selected" : ""}>${status}</option>`).join("")}</select></label>
        <label><span>责任单位</span><select class="form-control" name="owner">${owners.map((owner) => `<option>${escapeHtml(owner)}</option>`).join("")}</select></label>
        <label class="full"><span>${closed ? "重新打开的原因" : "处置说明"}</span><textarea class="form-control" name="note" required minlength="4" maxlength="200" placeholder="${closed ? "改回处理中视为重新打开，请写明原因" : "写清已采取的动作、联系结果或下一步计划（办结时必填）"}"></textarea>
          <span class="note-chips" aria-label="常用说明">${HANDLE_NOTE_CHIPS.map((text) => `<button type="button" class="chip" data-action="note-chip" data-text="${escapeHtml(text)}">${escapeHtml(text)}</button>`).join("")}</span></label>
        <label class="full follow-up-field"${closed ? "" : " hidden"}><span>回访老人</span><select class="form-control" name="followUp"><option value="">请选择回访结果</option>${FOLLOW_UP_OPTIONS.map((item) => `<option>${item}</option>`).join("")}</select><small>办结前确认老人对处置结果是否认可；老人不认可时不能办结</small></label>
        <div class="full notice">${icon("shield-check")}办结时间由服务器记录，按时或超时按承诺时限自动判定；更新备注、转派不会重置截止时间。</div>
      </form>`,
      footer: `<button class="btn btn-secondary" type="button" data-action="close-modal">取消</button><button class="btn btn-primary" type="submit" form="event-handle-form">${icon("save")}保存处置</button>`,
      onOpen: () => {
        const form = document.getElementById("event-handle-form");
        const follow = form.querySelector(".follow-up-field");
        const sync = () => { follow.hidden = form.elements.status.value !== "已办结"; form.elements.followUp.required = !follow.hidden; };
        form.elements.status.addEventListener("change", sync);
        sync();
        form.addEventListener("submit", (formEvent) => submitEventHandling(formEvent, id));
      }
    });
  }

  function submitEventHandling(formEvent, id) {
    formEvent.preventDefault();
    const event = getEvent(id);
    if (!event) return;
    const form = new FormData(formEvent.target);
    const status = String(form.get("status"));
    const note = String(form.get("note") || "").trim();
    const followUp = String(form.get("followUp") || "");
    const previous = event.status;
    if (note.length < 4) return showToast("请写明处置说明", "至少写清做了什么、结果如何。", "warning");
    if (status === "已办结" && !followUp) return showToast("请选择回访结果", "办结前需确认老人对处置结果是否认可。", "warning");
    if (status === "已办结" && followUp === "已回访，老人不认可") return showToast("老人不认可，暂不能办结", "请继续处置，或改为“处置中”并写明下一步。", "warning");
    event.status = status;
    event.owner = String(form.get("owner"));
    event.timeline = event.timeline || [];
    event.timeline.forEach((item) => { if (item.state === "current") item.state = "done"; });
    event.timeline.push({ time: "刚刚", text: note, state: status === "已办结" ? "done" : "current" });
    if (status === "已办结" && previous !== "已办结") {
      event.closedAt = Date.now();  // 连接服务器时改为服务器时间
      event.followUp = { result: followUp, note: "" };
    }
    if (previous === "已办结" && status !== "已办结") {
      delete event.closedAt;
      event.reopenCount = (event.reopenCount || 0) + 1;
    }
    saveData(previous === "已办结" && status !== "已办结" ? "重新打开事件" : "更新事件处置结果", "risk_event", event.id);
    closeModal();
    const sla = eventSla(event);
    showToast(status === "已办结" ? (sla.state === "closed_late" ? "事件已办结（超时）" : "事件已办结") : previous === "已办结" ? "事件已重新打开" : previous === status ? "处置记录已保存" : "处置结果已更新",
      status === "已办结" ? `${event.id} ${sla.text}，回访：${followUp}` : previous === status ? `${event.id} 状态仍为${status}，截止时间不变（${sla.text}）` : `${event.id} 已从${previous}更新为${status}，截止时间不变`);
    renderPage();
  }

  function openResidentDetail(id) {
    const resident = state.data.residents.find((item) => item.id === id);
    if (!resident) return;
    const service = state.data.serviceLogs.filter((item) => item.residentId === id).slice(0, 3);
    const events = state.data.events.filter((item) => item.residentId === id).slice(0, 3);
    openModal({
      title: `${resident.name}的动态档案`,
      subtitle: resident.id,
      wide: true,
      body: `<div class="panel-grid equal"><div><div class="profile-grid"><div class="data-field"><span>年龄 / 来源</span><strong>${resident.age}岁 · ${escapeHtml(resident.source)}</strong></div><div class="data-field"><span>房间</span><strong>${escapeHtml(resident.room)}</strong></div><div class="data-field"><span>入住时间</span><strong>${escapeHtml(resident.checkIn)}</strong></div><div class="data-field"><span>数据新鲜度</span><strong>${escapeHtml(resident.fresh)}</strong></div><div class="data-field"><span>居住方式</span><strong>${escapeHtml(resident.scene || "机构入住")}${resident.livingAlone ? " · 独居" : ""}</strong></div><div class="data-field"><span>紧急联系人</span><strong>${resident.emergencyName ? `${escapeHtml(resident.emergencyName)} · ${escapeHtml(resident.emergencyPhone || "未登记电话")}` : "未登记"}</strong></div></div><div class="notice mt-4">${icon("database")}档案字段来源可追溯，机构端仅展示当前照护所需字段。</div></div><div class="section-head-copy"><h3>当前风险</h3>${riskTag(resident.screening ? resident.screening.overall : resident.risk)}<p class="meta-text">综合入住状态、服务记录、本人打卡和事件变化生成。高风险与缺项结果必须由工作人员确认。</p></div></div>${screeningSummary(resident.screening)}<section class="panel mt-4"><header class="panel-header"><div class="section-head-copy"><h3>近期服务与事件</h3></div></header><div class="panel-body"><div class="list-stack">${service.map((item) => `<div class="list-item"><span class="list-icon">${icon("clipboard-list")}</span><div class="list-content"><strong>${escapeHtml(item.type)} · ${escapeHtml(item.result)}</strong><p>${escapeHtml(item.staff)} · ${escapeHtml(item.time)}</p></div></div>`).join("")}${events.map((item) => `<div class="list-item"><span class="list-icon ${item.level === "high" ? "danger" : "warning"}">${icon("siren")}</span><div class="list-content"><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.time)} · ${escapeHtml(item.status)}</p></div></div>`).join("")}</div></div></section>`,
      footer: `<button class="btn btn-primary" type="button" data-action="record-service" data-resident="${resident.id}">${icon("plus")}记录服务</button><button class="btn btn-secondary" type="button" data-action="close-modal">关闭</button>`
    });
  }

  function openScreeningReview(id) {
    const resident = state.data.residents.find((item) => item.id === id);
    if (!resident || !resident.screening) return;
    const screening = resident.screening;
    openModal({
      title: `${resident.name} · 身心快筛复核`,
      subtitle: `${resident.id} · ${screening.source} · ${screening.updatedAt}`,
      wide: true,
      body: `<div class="review-banner ${screening.overall === "high" ? "danger" : "warning"}"><div><span class="eyebrow">系统建议</span><h3>${riskLabel(screening.overall)} · 数据完整度 ${Math.round((screening.dataCompleteness ?? (5 - (screening.missing || []).length) / 5) * 100)}%</h3><p>本结果由可观察项和规则引擎生成，不是医学诊断。</p></div>${screeningStatusTag(screening)}</div><div class="review-evidence-grid">${screening.dimensions.map((dimension) => `<article class="evidence-item"><div class="evidence-item-head"><strong>${escapeHtml(dimension.label)}</strong><span class="status-tag ${dimension.level === "high" ? "danger" : dimension.level === "medium" ? "warning" : dimension.level === "unknown" ? "neutral" : "success"}">${escapeHtml(dimension.value)}</span></div><p>${icon("quote")}证据：${escapeHtml(dimension.evidence)}</p><small>来源：${escapeHtml(screening.source)}</small></article>`).join("")}</div>${screening.missing && screening.missing.length ? `<div class="notice warning mt-4">${icon("triangle-alert")}缺项：${screening.missing.map(escapeHtml).join("、")}。缺项未补齐前，系统不会自动升级或判为稳定。</div>` : ""}<label class="full review-note-field"><span>人工复核备注</span><textarea id="screening-review-note" class="form-control" placeholder="记录现场观察、补录结果或冲突说明">${screening.reviewStatus === "已确认" ? "已完成现场观察，与系统建议一致。" : "已核对原始记录，建议按系统提示安排回访。"}</textarea></label>`,
      footer: `<button class="btn btn-secondary" type="button" data-action="close-modal">稍后处理</button><button class="btn btn-primary" type="button" data-action="confirm-screening" data-id="${resident.id}">${icon("check-check")}确认并写入台账</button>`,
    });
  }

  function confirmScreening(id) {
    const resident = state.data.residents.find((item) => item.id === id);
    if (!resident || !resident.screening) return;
    const note = document.getElementById("screening-review-note");
    resident.screening.reviewRequired = false;
    resident.screening.reviewStatus = "已确认";
    resident.screening.reviewNote = note ? note.value.trim() : "已完成人工复核。";
    resident.screening.reviewedAt = "刚刚";
    resident.risk = resident.screening.overall;
    if (resident.id === state.data.profile.id) {
      state.data.profile.screening = resident.screening;
      state.data.profile.risk = resident.risk;
    }
    saveData("确认身心快筛结果", "resident_screening", resident.id);
    closeModal();
    showToast("快筛结果已确认", `${resident.name}的证据链和人工备注已写入动态台账。`);
    renderPage();
  }

  function getMovement(id) {
    return getMovementLogs().find((log) => log.id === id);
  }

  function openMovementReport() {
    const activeIds = activeMovementResidentIds();
    const availableResidents = state.data.residents.filter((resident) => !activeIds.has(resident.id));
    const defaultDue = new Date(Date.now() + 2 * 60 * 60 * 1000);
    defaultDue.setSeconds(0, 0);
    const defaultDueValue = new Date(defaultDue.getTime() - defaultDue.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    openModal({
      title: "新增外出与行程报备",
      subtitle: "离开机构前必须明确去向、返回计划和机构责任人",
      wide: true,
      body: `<form id="movement-report-form" class="form-grid"><label><span>旅居老人</span><select class="form-control" name="residentId" required>${availableResidents.map((resident) => `<option value="${resident.id}">${escapeHtml(resident.name)} · ${escapeHtml(resident.room)}</option>`).join("")}</select><small>已有进行中外出记录的老人需先完成返回核验</small></label><label><span>动向类型</span><select class="form-control" name="type" required><option>临时外出</option><option>集体活动</option><option>外出就医</option><option>康复活动</option><option>探亲访友</option><option>跨市行程</option><option>出境行程</option><option>离住返程</option></select></label><label class="full"><span>目的地</span><input class="form-control" name="destination" placeholder="例如：北海银滩景区东门 / 北海站→南宁东站" required></label><div class="full notice" id="route-risk-preview" aria-live="polite">填写目的地后生成场所风险提示；资料未核验时不判为低风险。</div><label class="full"><span>外出事由</span><textarea class="form-control" name="reason" placeholder="说明外出目的、活动安排或就医需求" required></textarea></label><label><span>出发时间</span><input class="form-control" name="departAt" value="今日 ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}" required></label><label><span>预计返回</span><input class="form-control" type="datetime-local" name="expectedReturnAt" value="${defaultDueValue}" required><small>系统会按此时间自动生成超时未归风险事件</small></label><label><span>机构责任人</span><input class="form-control" name="responsible" value="工作人员 周敏" placeholder="姓名与岗位" required></label><label><span>责任人联系电话</span><input class="form-control" name="responsiblePhone" placeholder="用于异常情况快速联络" required></label><label><span>陪同方式</span><input class="form-control" name="companion" placeholder="本人外出 / 家属接送 / 机构陪同" required></label><label><span>初始关注等级</span><select class="form-control" name="risk"><option value="low">常规</option><option value="medium">需关注</option><option value="high">高风险</option></select></label><div class="full notice">${icon("shield-check")}提交后同步进入监管端待确认队列。跨市行程和离住返程必须先取得跨区域档案复用授权；监管确认只核验报备与责任链，机构仍承担现场跟进和按时返回核验责任。</div></form>`,
      footer: `<button class="btn btn-secondary" type="button" data-action="close-modal">取消</button><button class="btn btn-primary" type="submit" form="movement-report-form">${icon("send")}提交报备</button>`,
      onOpen: () => {
        const form = document.getElementById("movement-report-form");
        form.addEventListener("submit", submitMovementReport);
        let timer;
        const preview = async () => {
          const residentId = form.elements.residentId.value;
          const destination = form.elements.destination.value.trim();
          if (!destination) return;
          const result = await assessDestination(residentId, destination);
          if (form.isConnected && form.elements.destination.value.trim() === destination) {
            state.routeAssessment = { residentId, destination, result };
            document.getElementById("route-risk-preview").innerHTML = routeRiskMarkup(result);
          }
        };
        form.elements.destination.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(preview, 320); });
        form.elements.residentId.addEventListener("change", preview);
      }
    });
  }

  async function submitMovementReport(formEvent) {
    formEvent.preventDefault();
    const form = new FormData(formEvent.target);
    const resident = state.data.residents.find((item) => item.id === form.get("residentId"));
    if (!resident) return;
    const movementType = String(form.get("type"));
    const profile = state.data.profile || {};
    if (["跨市行程", "出境行程", "离住返程"].includes(movementType) && resident.id === profile.id && !profile.consents?.crossRegion) {
      showToast("需要先取得跨区域授权", "请到“我的档案 > 数据授权”开启跨区域档案复用后再提交。", "warning");
      return;
    }
    const destination = String(form.get("destination"));
    const routeAssessment = state.routeAssessment?.residentId === resident.id && state.routeAssessment?.destination === destination ? state.routeAssessment.result : await assessDestination(resident.id, destination);
    const id = uniqueRecordId("MV");
    const expectedReturnAt = String(form.get("expectedReturnAt") || "");
    const expectedReturnLabel = expectedReturnAt ? new Date(expectedReturnAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "未设置";
    const log = {
      id,
      residentId: resident.id,
      resident: resident.name,
      type: movementType,
      status: String(form.get("departAt")).includes("明日") ? "待出发" : movementType === "外出就医" ? "就医中" : "外出中",
      risk: String(form.get("risk")),
      destination,
      routeAssessment,
      reason: String(form.get("reason")),
      departAt: String(form.get("departAt")),
      expectedReturn: expectedReturnLabel,
      expectedReturnAt,
      actualReturn: "--",
      responsible: String(form.get("responsible")),
      responsiblePhone: String(form.get("responsiblePhone")),
      companion: String(form.get("companion")),
      source: "机构外出报备",
      ...(movementType === "出境行程" || routeAssessment?.border === "cross" ? { crossCity: true, border: true, borderCheck: { passport: "待核实", insurance: "待核实", roaming: "待核实", agency: "待核实" } } : {}),
      institutionStatus: "已核验",
      regulatorStatus: "待确认",
      confirmedBy: "--",
      confirmedAt: "--",
      eventId: "",
      timeline: [{ time: "刚刚", text: "机构核验去向、责任人与返回计划", state: "done" }, { time: "刚刚", text: "监管端已进入待确认队列", state: "current" }]
    };
    state.data.movementLogs.unshift(log);
    resident.fresh = "刚刚";
    state.data.notifications.unshift({ id: Date.now(), title: "新动向待监管确认", detail: `${resident.name}前往${log.destination}，责任人${log.responsible}`, time: "刚刚", level: "warning", read: false });
    saveData("新增旅居外出报备", "movement", log.id);
    closeModal();
    showToast("外出报备已提交", `${resident.name}的去向和责任链已同步监管端。`);
    renderPage();
  }

  function openMovementDetail(id) {
    const log = getMovement(id);
    if (!log) return;
    const eventAction = log.eventId ? `<button class="btn btn-secondary" type="button" data-action="event-detail" data-id="${log.eventId}">${icon("siren")}查看关联事件</button>` : "";
    const confirmAction = state.role === "regulator" && log.regulatorStatus === "待确认" ? `<button class="btn btn-primary" type="button" data-action="movement-confirm" data-id="${log.id}">${icon("badge-check")}监管确认</button>` : "";
    const returnAction = state.role === "provider" && isMovementActive(log) ? `<button class="btn btn-primary" type="button" data-action="movement-return" data-id="${log.id}">${icon("log-in")}确认安全返回</button>` : "";
    openModal({
      title: `${log.resident} · ${log.type}`,
      subtitle: `${log.id} · ${log.source}`,
      wide: true,
      body: `<div class="movement-detail-head ${log.status === "超时未归" ? "danger" : ""}"><div><span class="eyebrow">当前动向</span><h3>${escapeHtml(log.destination)}</h3><p>${escapeHtml(log.reason)}</p><p>场所风险：${escapeHtml(routeRiskLabel(log.routeAssessment))}</p></div>${statusTag(log.status)}</div><div class="profile-grid mt-4"><div class="data-field"><span>出发 / 预计返回</span><strong>${escapeHtml(log.departAt)} / ${escapeHtml(log.expectedReturn)}</strong></div><div class="data-field"><span>实际返回</span><strong>${escapeHtml(log.actualReturn)}</strong></div><div class="data-field"><span>机构责任人</span><strong>${escapeHtml(log.responsible)} · ${escapeHtml(log.responsiblePhone)}</strong></div><div class="data-field"><span>陪同与交接</span><strong>${escapeHtml(log.companion)}</strong></div><div class="data-field"><span>机构核验</span><strong>${escapeHtml(log.institutionStatus)}</strong></div><div class="data-field"><span>监管确认</span><strong>${escapeHtml(log.regulatorStatus)} · ${escapeHtml(log.confirmedBy || "--")}</strong></div></div><div class="notice warning mt-4">${routeRiskMarkup(log.routeAssessment)}</div><section class="movement-timeline"><h3>动向时间线</h3><div class="timeline">${(log.timeline || []).map((item) => `<div class="timeline-item ${item.state}"><span class="timeline-dot"></span><div class="timeline-copy"><strong>${escapeHtml(item.text)}</strong><span>${escapeHtml(item.time)}</span></div></div>`).join("")}</div></section>`,
      footer: `<button class="btn btn-secondary" type="button" data-action="close-modal">关闭</button>${eventAction}${returnAction}${confirmAction}`
    });
  }

  function openMovementConfirmation(id) {
    const log = getMovement(id);
    if (!log) return;
    openModal({
      title: "监管确认旅居动向",
      subtitle: `${log.id} · ${log.resident} · ${log.destination}`,
      body: `<form id="movement-confirm-form" class="form-grid"><label><span>确认结果</span><select class="form-control" name="result"><option>已确认</option><option>重点跟进</option></select></label><label><span>确认人员</span><input class="form-control" name="confirmedBy" value="陈科长 · 自治区民政主管部门" required></label><label class="full"><span>核验备注</span><textarea class="form-control" name="note" required>已核验目的地、预计返回时间、机构责任人及联系电话，责任链完整。</textarea></label><div class="full notice">${icon("info")}若去向、返回时间或责任人信息不完整，应选择“重点跟进”，并由机构补齐后再确认。</div></form>`,
      footer: `<button class="btn btn-secondary" type="button" data-action="close-modal">取消</button><button class="btn btn-primary" type="submit" form="movement-confirm-form">${icon("badge-check")}完成确认</button>`,
      onOpen: () => document.getElementById("movement-confirm-form").addEventListener("submit", (event) => submitMovementConfirmation(event, id))
    });
  }

  function submitMovementConfirmation(formEvent, id) {
    formEvent.preventDefault();
    const log = getMovement(id);
    if (!log) return;
    const form = new FormData(formEvent.target);
    log.regulatorStatus = String(form.get("result"));
    log.confirmedBy = String(form.get("confirmedBy"));
    log.confirmedAt = "刚刚";
    log.confirmationNote = String(form.get("note"));
    log.timeline = log.timeline || [];
    log.timeline.push({ time: "刚刚", text: `${log.regulatorStatus}：${log.confirmationNote}`, state: log.regulatorStatus === "已确认" ? "done" : "current" });
    saveData("监管确认旅居动向", "movement", log.id);
    closeModal();
    renderNav();
    renderPage();
    showToast("动向确认已完成", `${log.resident}的外出责任链已由监管端留痕。`);
  }

  function openMovementReturn(id) {
    const log = getMovement(id);
    if (!log) return;
    openModal({
      title: "确认老人安全返回",
      subtitle: `${log.id} · ${log.resident} · 原计划${log.expectedReturn}`,
      body: `<form id="movement-return-form" class="form-grid"><label><span>实际返回时间</span><input class="form-control" name="actualReturn" value="刚刚" required></label><label><span>核验人员</span><input class="form-control" name="checker" value="工作人员 周敏" required></label><label class="full"><span>返回情况</span><textarea class="form-control" name="note" required>已当面确认老人安全返回，身体及情绪状态无明显异常。</textarea></label></form>`,
      footer: `<button class="btn btn-secondary" type="button" data-action="close-modal">取消</button><button class="btn btn-primary" type="submit" form="movement-return-form">${icon("check-check")}确认返回</button>`,
      onOpen: () => document.getElementById("movement-return-form").addEventListener("submit", (event) => submitMovementReturn(event, id))
    });
  }

  function submitMovementReturn(formEvent, id) {
    formEvent.preventDefault();
    const log = getMovement(id);
    if (!log) return;
    const form = new FormData(formEvent.target);
    log.status = "已返回";
    log.actualReturn = String(form.get("actualReturn"));
    log.institutionStatus = "已核验";
    log.timeline = log.timeline || [];
    log.timeline.push({ time: "刚刚", text: `${form.get("checker")}确认返回：${form.get("note")}`, state: "done" });
    const resident = state.data.residents.find((item) => item.id === log.residentId);
    if (resident) resident.fresh = "刚刚";
    if (log.eventId) {
      const linkedEvent = getEvent(log.eventId);
      if (linkedEvent && linkedEvent.status !== "已办结") {
        linkedEvent.status = "待复核";
        linkedEvent.timeline = linkedEvent.timeline || [];
        linkedEvent.timeline.push({ time: "刚刚", text: "机构确认老人已安全返回，等待监管复核", state: "current" });
      }
    }
    saveData("确认老人安全返回", "movement", log.id);
    closeModal();
    renderPage();
    showToast("返回状态已核验", `${log.resident}已回到机构，相关预警同步更新。`);
  }

  function openRecordService(residentId = "") {
    openModal({
      title: "记录一次服务",
      subtitle: "完成后将写入老人动态台账，并参与机构质量统计",
      body: `<form id="service-form" class="form-grid"><label><span>老人</span><select class="form-control" name="residentId" required>${state.data.residents.map((resident) => `<option value="${resident.id}" ${resident.id === residentId ? "selected" : ""}>${escapeHtml(resident.name)} · ${escapeHtml(resident.room)}</option>`).join("")}</select></label><label><span>服务类型</span><select class="form-control" name="type" required><option>血压测量</option><option>用药提醒</option><option>早餐送餐</option><option>康复训练</option><option>夜间巡查</option><option>行程协助</option></select></label><label><span>执行人员</span><input class="form-control" name="staff" value="周敏 · 机构工作人员" required></label><label><span>服务时间</span><input class="form-control" name="time" value="今日 ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}" required></label><label class="full"><span>服务结果</span><textarea class="form-control" name="result" required placeholder="记录完成情况、测量值或需要跟进的事项"></textarea></label></form>`,
      footer: `<button class="btn btn-secondary" type="button" data-action="close-modal">取消</button><button class="btn btn-primary" type="submit" form="service-form">${icon("save")}保存记录</button>`,
      onOpen: () => document.getElementById("service-form").addEventListener("submit", submitService)
    });
  }

  function submitService(formEvent) {
    formEvent.preventDefault();
    const form = new FormData(formEvent.target);
    const resident = state.data.residents.find((item) => item.id === form.get("residentId"));
    const serviceRecord = { id: uniqueRecordId("SV"), residentId: resident.id, resident: resident.name, type: String(form.get("type")), staff: String(form.get("staff")), time: String(form.get("time")), result: String(form.get("result")), status: "已记录" };
    state.data.serviceLogs.unshift(serviceRecord);
    resident.fresh = "刚刚";
    saveData("新增机构服务记录", "service", serviceRecord.id);
    closeModal();
    showToast("服务记录已保存", `${resident.name}的动态台账已更新。`);
    renderPage();
  }

  function openRegisterResident() {
    openModal({
      title: "办理旅居入住",
      subtitle: "完成身份核验后生成跨机构可复用的OneID档案",
      body: `<form id="register-form" class="form-grid"><label><span>姓名</span><input class="form-control" name="name" placeholder="请输入老人姓名" required></label><label><span>年龄</span><input class="form-control" name="age" type="number" min="55" max="110" placeholder="例如 68" required></label><label><span>来源地</span><input class="form-control" name="source" placeholder="例如 湖南长沙" required></label><label><span>房间</span><input class="form-control" name="room" placeholder="例如 颐养楼 205" required></label><label class="full"><span>紧急联系人电话</span><input class="form-control" name="contact" placeholder="用于紧急联络和离住交接" required></label><div class="full notice">${icon("shield-check")}仅采集当前照护所需字段；身份证、健康信息和跨区域共享需在老人端完成本人授权。</div></form>`,
      footer: `<button class="btn btn-secondary" type="button" data-action="close-modal">取消</button><button class="btn btn-primary" type="submit" form="register-form">${icon("user-check")}生成档案</button>`,
      onOpen: () => document.getElementById("register-form").addEventListener("submit", submitResident)
    });
  }

  function submitResident(formEvent) {
    formEvent.preventDefault();
    const form = new FormData(formEvent.target);
    const name = String(form.get("name"));
    const id = uniqueRecordId("GX-LJ");
    state.data.residents.unshift({ id, name, age: Number(form.get("age")), source: String(form.get("source")), room: String(form.get("room")), checkIn: "今日", risk: "low", fresh: "刚刚", status: "在住" });
    saveData("办理旅居入住", "resident", id);
    closeModal();
    showToast("入住档案已生成", `${name}已进入机构动态台账。`);
    renderPage();
  }

  function openEditProfile() {
    const p = state.data.profile;
    openModal({
      title: "更新个人资料",
      subtitle: "更新后会保留修改人和时间",
      body: `<form id="profile-form" class="form-grid"><label><span>本人电话</span><input class="form-control" name="phone" value="${escapeHtml(p.phone)}"></label><label><span>紧急联系人</span><input class="form-control" name="emergencyName" value="${escapeHtml(p.emergencyName)}"></label><label class="full"><span>紧急联系人电话</span><input class="form-control" name="emergencyPhone" value="${escapeHtml(p.emergencyPhone)}"></label><div class="full notice">${icon("lock-keyhole")}保存后仅更新联系方式字段，不会改变健康风险判断。</div></form>`,
      footer: `<button class="btn btn-secondary" type="button" data-action="close-modal">取消</button><button class="btn btn-primary" type="submit" form="profile-form">${icon("save")}保存资料</button>`,
      onOpen: () => document.getElementById("profile-form").addEventListener("submit", (formEvent) => { formEvent.preventDefault(); const form = new FormData(formEvent.target); p.phone = String(form.get("phone")); p.emergencyName = String(form.get("emergencyName")); p.emergencyPhone = String(form.get("emergencyPhone")); p.lastCheck = "刚刚"; saveData("更新老人联系资料", "resident", p.id); closeModal(); showToast("资料已更新", "紧急联络信息已写入档案。"); renderPage(); })
    });
  }

  function openInstitutionDetail(id) {
    const institution = state.data.institutions.find((item) => item.id === id);
    if (!institution) return;
    openModal({
      title: institution.name,
      subtitle: `${institution.city} · ${institution.id}`,
      body: `<div class="stat-grid stat-grid-compact">${statCard("质量评分", institution.score, "分", "medal", "综合服务表现", "positive")}${statCard("事件闭环率", institution.closure, "%", "circle-check", "近30日", institution.closure >= 93 ? "positive" : "warning")}${statCard("平均响应", institution.response, "", "timer", "目标≤30分钟", "positive")}${statCard("待处理预警", institution.alerts, "条", "siren", institution.alerts > 3 ? "建议督办" : "正常", institution.alerts > 3 ? "warning" : "positive")}</div><div class="notice">${icon("info")}本表质量分与参考响应来自脱敏演示样本，尚未接入可核验的真实考核；呼救接单时效另由应急工单自动采集。</div>`,
      footer: `<button class="btn btn-secondary" type="button" data-action="close-modal">关闭</button>`
    });
  }

  function openNotifications() {
    const notifications = notificationItems();
    const unread = notifications.filter((item) => !item.read);
    openModal({
      title: "通知中心",
      subtitle: unread.length ? `${unread.length}条未读通知` : "暂无未读通知",
      body: `<div class="list-stack">${notifications.map((item) => `<div class="list-item"><span class="list-icon ${item.level === "danger" ? "danger" : item.level === "warning" ? "warning" : ""}">${icon(item.level === "danger" ? "siren" : item.level === "warning" ? "file-warning" : "info")}</span><div class="list-content"><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.detail)}</p></div><span class="list-side">${escapeHtml(item.time)}</span></div>`).join("") || `<div class="empty-state">暂无进行中事项</div>`}</div>`,
      footer: `<button class="btn btn-primary" type="button" data-action="read-notifications">${icon("check-check")}全部标记已读</button><button class="btn btn-secondary" type="button" data-action="close-modal">关闭</button>`
    });
  }

  function openProfileMenu() {
    const account = state.data.accounts[state.role];
    const dataEnvironment = state.backend.connected ? "SQLite业务数据库" : state.backend.enabled ? "浏览器后备数据" : "在线独立数据版";
    const databaseNotice = state.backend.connected
      ? `${icon("database")}业务数据已写入SQLite规范化表，并保留角色、时间、动作和对象审计记录。`
      : `${icon("database")}当前使用浏览器独立数据；通过“启动作品.bat”运行本地完整服务后会自动连接SQLite。`;
    openModal({
      title: account.name,
      subtitle: account.org,
      body: `<div class="profile-grid"><div class="data-field"><span>当前角色</span><strong>${roleMeta[state.role].label}</strong></div><div class="data-field"><span>数据环境</span><strong>${dataEnvironment}</strong></div><div class="data-field"><span>最近同步</span><strong>${escapeHtml(state.backend.lastSync)}</strong></div><div class="data-field"><span>权限范围</span><strong>${state.role === "elder" ? "本人档案与求助记录" : state.role === "provider" ? "本机构老人、服务及动向记录" : "样本监测、动向确认与事件督办"}</strong></div></div><div class="notice mt-4">${databaseNotice}</div>`,
      footer: `${state.role === "regulator" && state.backend.connected ? `<button class="btn btn-secondary" type="button" data-action="view-audit">${icon("history")}查看操作审计</button>` : ""}${!state.backend.enabled ? `<button class="btn btn-secondary" type="button" data-action="reset-demo">${icon("rotate-ccw")}恢复初始数据</button>` : ""}<button class="btn btn-primary" type="button" data-action="close-modal">关闭</button>`
    });
  }

  async function openAuditLog() {
    if (!state.backend.connected) {
      showToast("数据库未连接", "请通过启动作品.bat运行本地完整服务。", "warning");
      return;
    }
    try {
      const response = await fetch("/api/audit?limit=30", { cache: "no-store", headers: authHeaders() });
      if (!response.ok) throw new Error("audit_unavailable");
      const payload = await response.json();
      const logs = Array.isArray(payload.logs) ? payload.logs : [];
      const counts = payload.database && payload.database.counts ? payload.database.counts : {};
      const auditCount = counts.audit_logs ? counts.audit_logs.count : logs.length;
      openModal({
        title: "数据库操作审计",
        subtitle: `SQLite · 共${auditCount}条留痕 · 最近${logs.length}条`,
        wide: true,
        body: `<div class="profile-grid"><div class="data-field"><span>老人档案</span><strong>${counts.residents ? counts.residents.count : 0}条</strong></div><div class="data-field"><span>旅居动向</span><strong>${counts.movement_records ? counts.movement_records.count : 0}条</strong></div><div class="data-field"><span>服务记录</span><strong>${counts.service_records ? counts.service_records.count : 0}条</strong></div><div class="data-field"><span>风险事件</span><strong>${counts.risk_events ? counts.risk_events.count : 0}条</strong></div></div><section class="panel mt-4"><div class="panel-header"><div class="section-head-copy"><h3>最近操作记录</h3></div><span class="status-tag success">不可由业务页面修改</span></div><div class="table-wrap"><table class="data-table"><thead><tr><th>时间</th><th>操作者</th><th>业务动作</th><th>对象类型</th><th>对象编号</th></tr></thead><tbody>${logs.length ? logs.map((log) => `<tr><td>${escapeHtml(new Date(log.occurred_at).toLocaleString("zh-CN", { hour12: false }))}</td><td><div class="cell-copy"><strong>${escapeHtml(log.actor_name)}</strong><small>${escapeHtml(roleMeta[log.actor_role] ? roleMeta[log.actor_role].label : log.actor_role)}</small></div></td><td><strong>${escapeHtml(log.action)}</strong></td><td>${escapeHtml(log.entity_type)}</td><td>${escapeHtml(log.entity_id || "--")}</td></tr>`).join("") : `<tr><td colspan="5"><div class="empty-state">${icon("history")}<strong>暂无操作记录</strong></div></td></tr>`}</tbody></table></div></section><div class="notice mt-4">${icon("shield-check")}审计日志用于责任追溯；正式部署时将增加日志保留期限、分级查询权限和异地备份。</div>`,
        footer: `<button class="btn btn-primary" type="button" data-action="close-modal">关闭</button>`
      });
    } catch (error) {
      showToast("审计记录读取失败", "SQLite服务暂时不可用，请稍后重试。", "danger");
    }
  }

  function exportReport() {
    const rows = ["事件编号,老人,类别,风险,状态,责任单位,时间", ...state.data.events.map((item) => [item.id, item.resident, item.category, riskLabel(item.level), item.status, item.owner, item.time].map((value) => `"${String(value).replaceAll('"', '""')}"`).join(","))];
    const blob = new Blob(["\ufeff" + rows.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `旅居养老事件清单_${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
    showToast("事件清单已导出", "CSV文件已下载到浏览器默认下载目录。", "success");
  }

  function exportMovements() {
    const rows = ["动向编号,老人,动向类型,当前状态,目的地,事由,出发时间,预计返回,实际返回,机构责任人,联系电话,机构核验,监管确认", ...getMovementLogs().map((log) => [log.id, log.resident, log.type, log.status, log.destination, log.reason, log.departAt, log.expectedReturn, log.actualReturn, log.responsible, log.responsiblePhone, log.institutionStatus, log.regulatorStatus].map((value) => `"${String(value).replaceAll('"', '""')}"`).join(","))];
    const blob = new Blob(["\ufeff" + rows.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `旅居老人动向台账_${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
    showToast("动向台账已导出", "去向、责任人与确认状态已生成CSV文件。", "success");
  }

  document.querySelectorAll(".role-option").forEach((button) => button.addEventListener("click", () => setSelectedRole(button.dataset.role)));
  document.getElementById("toggle-password").addEventListener("click", () => {
    const isPassword = loginPassword.type === "password";
    loginPassword.type = isPassword ? "text" : "password";
    document.getElementById("toggle-password").setAttribute("aria-label", isPassword ? "隐藏密码" : "显示密码");
  });
  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const account = state.data.accounts[state.selectedRole];
    if (loginAccount.value.trim() !== account.account) {
      loginError.textContent = "账号或身份不正确。";
      loginError.hidden = false;
      return;
    }
    if (state.backend.enabled) {
      try {
        const response = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role: state.selectedRole, account: account.account, password: loginPassword.value }) });
        if (!response.ok) throw new Error("invalid_credentials");
        const payload = await response.json();
        sessionStorage.setItem(TOKEN_KEY, payload.token);
        if (!await syncFromBackend()) throw new Error("state_unavailable");
      } catch (error) {
        sessionStorage.removeItem(TOKEN_KEY);
        loginError.textContent = "账号或密码错误，或本地服务不可用。";
        loginError.hidden = false;
        return;
      }
    }
    loginError.hidden = true;
    login(state.selectedRole);
  });

  document.addEventListener("click", (event) => {
    const pageButton = event.target.closest("[data-page]");
    if (pageButton && state.role) {
      navigate(pageButton.dataset.page);
      return;
    }
    const actionButton = event.target.closest("[data-action]");
    if (!actionButton) return;
    const action = actionButton.dataset.action;
    if (action === "close-modal") closeModal();
    if (action === "note-chip") { const field = actionButton.closest("form")?.elements.note; if (field) { field.value = [field.value.trim(), actionButton.dataset.text].filter(Boolean).join("；"); field.focus(); } }
    if (action === "open-sidebar") openSidebar();
    if (action === "ai-video") openAiVideoAssistant();
    if (action === "trace-toggle") { const trace = actionButton.closest(".agent-trace"); if (trace) { trace.dataset.touched = "1"; const collapsed = trace.classList.toggle("collapsed"); actionButton.setAttribute("aria-expanded", collapsed ? "false" : "true"); } }
    if (action === "ai-ask") { const text = actionButton.dataset.text || ""; openAiVideoAssistant(); window.setTimeout(() => { if (text && !document.getElementById("ai-send-btn")?.disabled) sendAiMessage(text); }, 350); }
    if (action === "weather-publish") openWeatherPublish();
    if (action === "weather-safe") submitWeatherCheckin(actionButton.dataset.id, state.data.profile.id, "safe");
    if (action === "weather-help") submitWeatherCheckin(actionButton.dataset.id, state.data.profile.id, "help");
    if (action === "weather-provider-safe") submitWeatherCheckin(actionButton.dataset.alert, actionButton.dataset.resident, "safe");
    if (action === "weather-followup") superviseWeatherCheckin(actionButton.dataset.id);
    if (action === "weather-resolve") weatherAction("resolve", { alertId: actionButton.dataset.id }).then(() => showToast("预警已解除", "对应报平安任务已归档。", "success")).catch(() => showToast("解除失败", "请检查本地服务后重试。", "warning"));
    if (action === "toggle-ai-camera") toggleAiCamera();
    if (action === "start-ai-speech") startAiSpeech();
    if (action === "ai-speak") {
      const wasSpeaking = actionButton.classList.contains("speaking");
      cancelElderSpeech();
      const text = actionButton.closest(".chat-bubble")?.dataset.speech || "";
      if (!wasSpeaking && text) speakForElder(text, true, actionButton);
    }
    if (action === "speech-toggle") {
      const enabled = !autoSpeakEnabled();
      try { localStorage.setItem(AUTO_SPEAK_KEY, enabled ? "on" : "off"); } catch (error) { /* Private mode may block storage. */ }
      if (!enabled) cancelElderSpeech();
      document.querySelectorAll('[data-action="speech-toggle"]').forEach((button) => { button.setAttribute("aria-pressed", String(enabled)); button.innerHTML = speechToggleLabel(button.classList.contains("va-ctl")); });
      refreshIcons();
    }
    if (action === "create-event-from-ai") createEventFromAi();
    if (action === "agent-confirm") confirmAgentAction(actionButton.dataset.index);
    if (action === "radar-broadcast") radarBroadcast(actionButton.dataset.id);
    if (action === "radar-transfer") radarTransfer(actionButton.dataset.id);
    if (action === "radar-export") exportClusterEvidence(actionButton.dataset.id);
    if (action === "radar-exclude") openRadarExclude(actionButton.dataset.id, actionButton.dataset.cluster);
    if (action === "radar-restore") { saveRadarReview({ eventId: actionButton.dataset.id, decision: "restore" }, "类案人工纠错：撤销移出"); showToast("已撤销移出", "该个案重新参与类案归并。"); }
    if (action === "demo-guide") openDemoGuide();
    if (action === "demo-step") toggleDemoStep(Number(actionButton.dataset.index));
    if (action === "demo-reset") { try { localStorage.removeItem(DEMO_PROGRESS_KEY); } catch (error) { /* 忽略 */ } openDemoGuide(); }
    if (action === "demo-open-role") window.open(`${location.pathname}?role=${encodeURIComponent(actionButton.dataset.role)}`, "_blank", "noopener");
    if (action === "event-export") exportEventEvidence(actionButton.dataset.id);
    if (action === "advisor-ask") askAdvisor(document.getElementById("advisor-input")?.value);
    if (action === "advisor-suggest") askAdvisor(actionButton.dataset.text);
    if (action === "advisor-brief") downloadAdvisorBrief(actionButton.dataset.index);
    if (action === "advisor-copy") copyAdvisorDraft(actionButton.dataset.index);
    if (action === "care-task") createCareTask(actionButton.dataset.id);
    if (action === "care-refresh") loadCare(true);
    if (action === "device-alarm") simulateDeviceAlarm(actionButton.dataset.id);
    if (action === "insight-refresh") { state.insight = null; state.insightError = ""; renderPage(); loadInsight(true); }
    if (action === "insight-ask-ai") { navigate("advisor"); askAdvisor("请研判当前旅居养老运行态势和机构服务质量，指出最需要督办的问题"); }
    if (action === "radar-alert-open") { document.querySelector(".radar-alert")?.remove(); navigate("radar"); }
    if (action === "radar-alert-close") document.querySelector(".radar-alert")?.remove();
    if (action === "radar-refresh") { state.radar = null; renderPage(); loadRadar(true); }
    if (action === "ai-suggest" && !document.getElementById("ai-send-btn")?.disabled) sendAiMessage(actionButton.dataset.text || "");
    if (action === "agent-consent") { state.data.profile.consents.crossRegion = true; saveData("开启跨区域档案复用授权", "consent", "crossRegion"); showToast("已开启跨区域授权", "可随时在“我的档案”中撤回。"); renderAiResult(state.lastAiResult, state.aiProvider, state.lastAgentRun, false); }
    if (action === "health-scan") openHealthScan();
    if (action === "screening-check") openScreeningCheck();
    if (action === "screening-review") openScreeningReview(actionButton.dataset.id);
    if (action === "confirm-screening") confirmScreening(actionButton.dataset.id);
    if (action === "enable-camera") enableCamera();
    if (action === "start-scan") startHealthScan();
    if (action === "emergency-report") openEmergencyReport();
    if (action === "sos-press") openSosLauncher();
    if (action === "sos-send-now") sosLaunchNow();
    if (action === "sos-abort-launch") abortSosLaunch();
    if (action === "sos-status") openSosStatusModal(actionButton.dataset.id);
    if (action === "sos-detail") openSosDetailModal(actionButton.dataset.id);
    if (action === "sos-cancel") confirmCancelSos(actionButton.dataset.id);
    if (action === "sos-cancel-confirm") cancelSos(actionButton.dataset.id);
    if (action === "sos-claim") claimSos(actionButton.dataset.id);
    if (action === "sos-callback") openSosCallbackModal(actionButton.dataset.id);
    if (action === "sos-callback-outcome") recordSosCallback(actionButton.dataset.id, actionButton.dataset.outcome);
    if (action === "sos-resolve") resolveSos(actionButton.dataset.id, actionButton.dataset.mode);
    if (action === "sos-escalate") escalateSosNow(actionButton.dataset.id);
    if (action === "sos-mute") toggleSosMute();
    if (action === "dial") openDialModal(actionButton.dataset.number, actionButton.dataset.label || "");
    if (action === "ai-dial") {
      // 对话里不弹拨号窗（会盖掉对话）：手机上真实号码直接拨，其余在卡片里展开号码
      const number = actionButton.dataset.number || "";
      const hint = actionButton.closest(".ai-result-area")?.querySelector(".ai-dial-hint");
      if (CAN_PLACE_CALL && !/\*/.test(number)) window.location.href = `tel:${number.replace(/[^\d+]/g, "")}`;
      else if (hint) {
        hint.hidden = false;
        hint.innerHTML = `${icon("smartphone")}<span>请用手机拨打 <b>${escapeHtml(number)}</b>${/\*/.test(number) ? "（演示号码已脱敏，正式使用时按权限显示完整号码）" : ""}</span>`;
        refreshIcons();
      }
    }
    if (action === "dial-copy") {
      copyText(actionButton.dataset.number || "").then((ok) => {
        showToast(ok ? "号码已复制" : "复制失败", ok ? `${actionButton.dataset.number} 已复制到剪贴板。` : "请手动记下号码后用手机拨打。", ok ? "success" : "warning");
      });
    }
    if (action === "locate") locateEmergency();
    if (action === "record-voice") recordVoice();
    if (action === "event-detail") openEventDetail(actionButton.dataset.id);
    if (action === "handle-event") openHandleEvent(actionButton.dataset.id);
    if (action === "resident-detail") openResidentDetail(actionButton.dataset.id);
    if (action === "institution-detail") openInstitutionDetail(actionButton.dataset.id);
    if (action === "movement-report") openMovementReport();
    if (action === "movement-detail") openMovementDetail(actionButton.dataset.id);
    if (action === "movement-confirm") openMovementConfirmation(actionButton.dataset.id);
    if (action === "movement-return") openMovementReturn(actionButton.dataset.id);
    if (action === "record-service") openRecordService(actionButton.dataset.resident || "");
    if (action === "register-resident") openRegisterResident();
    if (action === "edit-profile") openEditProfile();
    if (action === "refresh-data") refreshCurrentData();
    if (action === "view-audit") openAuditLog();
    if (action === "export-report") exportReport();
    if (action === "export-movements") exportMovements();
    if (action === "read-notifications") { sessionStorage.setItem(READ_NOTICES_KEY, JSON.stringify(notificationItems().map((item) => item.id))); closeModal(); renderShell(); showToast("已标记当前通知为已读"); }
    if (action === "reset-demo") { if (state.backend.enabled) { showToast("本地服务未提供页面重置", "请在受控测试环境重新初始化数据库。", "warning"); return; } state.data = cloneSeed(); closeModal(); renderShell(); }
  });

  document.addEventListener("change", (event) => {
    const consent = event.target.closest("[data-consent]");
    if (!consent) return;
    state.data.profile.consents[consent.dataset.consent] = consent.checked;
    saveData("更新数据授权", "consent", consent.dataset.consent);
    showToast(consent.checked ? "授权已开启" : "授权已撤回", "后续数据使用范围会按授权状态更新。");
  });

  /* role="button" 的非按钮元素不会把回车/空格合成为点击，这里补齐键盘可达性。 */
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") return;
    const target = event.target.closest('[data-action][role="button"]');
    if (!target) return;
    event.preventDefault();
    target.click();
  });

  document.getElementById("logout-btn").addEventListener("click", logout);
  document.getElementById("notification-btn").addEventListener("click", openNotifications);
  document.getElementById("profile-btn").addEventListener("click", openProfileMenu);
  document.getElementById("menu-toggle").addEventListener("click", openSidebar);
  sidebarScrim.addEventListener("click", closeSidebar);
  document.getElementById("global-search").addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    const query = event.target.value.trim();
    if (!query) return;
    if (state.role === "provider") { state.residentQuery = query; navigate("residents"); }
    if (state.role === "regulator") { state.institutionQuery = query; navigate("institutions"); }
  });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && modalRoot.innerHTML) closeModal(); });
  document.addEventListener("keydown", (event) => { if (event.key === "Enter" && event.target?.id === "advisor-input" && !event.isComposing) { event.preventDefault(); askAdvisor(event.target.value); } });

  async function initializeApp() {
    renderLoginStats();
    ensureSosTicker();
    const session = sessionStorage.getItem(SESSION_KEY);
    let authorized = !state.backend.enabled;
    if (state.backend.enabled && sessionStorage.getItem(TOKEN_KEY)) {
      try {
        const response = await fetch("/api/me", { headers: authHeaders() });
        const payload = await response.json();
        authorized = response.ok && payload.actor?.role === session;
        if (authorized) authorized = await syncFromBackend();
      } catch (error) { authorized = false; }
    }
    if (session && roleMeta[session] && authorized) {
      state.role = session;
      loginView.hidden = true;
      appView.hidden = false;
      renderShell();
      ensureSosSync();
      ensureMovementMonitor();
      if (state.backend.enabled) stateSyncTimer = window.setInterval(pollBusinessState, 5000);
    } else {
      sessionStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(SESSION_KEY);
      const wanted = new URLSearchParams(location.search).get("role");
      setSelectedRole(roleMeta[wanted] ? wanted : "elder");
      refreshIcons();
    }
  }

  initializeApp();
})();
