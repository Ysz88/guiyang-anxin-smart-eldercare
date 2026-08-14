(function () {
  "use strict";

  const STORAGE_KEY = "guiyang-v1-data";
  const SESSION_KEY = "guiyang-v1-session";

  const roleMeta = {
    elder: {
      label: "老人端",
      eyebrow: "我的旅居服务",
      userType: "旅居老人",
      search: false,
      nav: [
        { id: "dashboard", label: "首页", icon: "house" },
        { id: "profile", label: "我的档案", icon: "contact-round" },
        { id: "check", label: "状态打卡", icon: "heart-pulse" },
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
        { id: "residents", label: "在住老人", icon: "users-round" },
        { id: "services", label: "动态台账", icon: "route" },
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
      check: "状态打卡",
      requests: "求助进度"
    },
    provider: {
      dashboard: "机构工作台",
      residents: "在住老人",
      services: "旅居动态台账",
      alerts: "预警处置"
    },
    regulator: {
      dashboard: "监管总览",
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
    institutionQuery: "",
    activeStream: null,
    voiceRecorder: null,
    voiceStream: null,
    speechRecognition: null,
    aiHistory: [],
    lastAiResult: null,
    aiProvider: ""
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

  function cloneSeed() {
    return JSON.parse(JSON.stringify(window.GY_DATA));
  }

  function loadData() {
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

  function saveData() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.data));
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
    if (["健康异常", "健康提醒"].includes(event.category)) return "120";
    if (["人身安全", "失联风险"].includes(event.category)) return "110";
    if (event.category === "服务投诉") return "12315";
    return "12345";
  }

  function statusClass(status) {
    if (["已办结", "已完成", "正常", "在住", "已记录", "已返回", "已确认", "已核验"].includes(status)) return "success";
    if (["处置中", "待复核", "已转派", "关注", "外出中", "就医中", "待出发", "待确认", "重点跟进"].includes(status)) return "warning";
    if (["超时", "紧急", "超时未归"].includes(status)) return "danger";
    return "neutral";
  }

  function statusTag(status) {
    return `<span class="status-tag ${statusClass(status)}">${escapeHtml(status)}</span>`;
  }

  function riskTag(risk) {
    return `<span class="risk-tag ${risk}">${riskLabel(risk)}</span>`;
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
      <div class="screening-summary-head"><div><span class="eyebrow">五维身心快筛</span><h3>${riskLabel(screening.overall)} · 置信度 ${Math.round((screening.confidence || 0) * 100)}%</h3></div>${screeningStatusTag(screening)}</div>
      <div class="dimension-grid">${dimensions.map(dimensionTag).join("")}</div>
      <div class="screening-meta"><span>${icon("database")}来源：${escapeHtml(screening.source || "未标注")}</span><span>${icon("clock-3")}更新：${escapeHtml(screening.updatedAt || "未标注")}</span>${screening.missing && screening.missing.length ? `<span class="screening-missing">${icon("triangle-alert")}缺项：${screening.missing.map(escapeHtml).join("、")}</span>` : ""}</div>
      ${!compact && screening.carePlan ? `<div class="care-plan"><strong>${icon("hand-heart")}照护计划</strong><span>${escapeHtml(screening.carePlan)}</span></div>` : ""}
    </div>`;
  }

  function showToast(title, detail = "", type = "success") {
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
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
    loginPassword.value = "123456";
    demoAccountText.textContent = `演示账号：${account.account} / 123456`;
    loginError.hidden = true;
    refreshIcons();
  }

  function login(role) {
    state.role = role;
    state.page = "dashboard";
    sessionStorage.setItem(SESSION_KEY, role);
    loginView.hidden = true;
    appView.hidden = false;
    renderShell();
    window.scrollTo({ top: 0, behavior: "auto" });
  }

  function logout() {
    closeModal();
    sessionStorage.removeItem(SESSION_KEY);
    state.role = null;
    appView.hidden = true;
    loginView.hidden = false;
    setSelectedRole(state.selectedRole);
    window.scrollTo({ top: 0, behavior: "auto" });
  }

  function renderShell() {
    const meta = roleMeta[state.role];
    const account = state.data.accounts[state.role];
    document.getElementById("role-badge").textContent = meta.label;
    document.getElementById("page-eyebrow").textContent = meta.eyebrow;
    document.getElementById("user-name").textContent = account.name;
    document.getElementById("user-org").textContent = account.org;
    document.getElementById("user-avatar").textContent = account.avatar;
    document.getElementById("global-search-wrap").hidden = !meta.search;
    renderNav();
    renderPage();
    window.scrollTo({ top: 0, behavior: "auto" });
  }

  function renderNav() {
    const items = roleMeta[state.role].nav;
    sideNav.innerHTML = items.map((item) => {
      const count = item.id === "movements" ? (state.data.movementLogs || []).filter((log) => log.regulatorStatus === "待确认").length : item.count;
      return `
      <button class="nav-item ${item.id === state.page ? "active" : ""}" type="button" data-page="${item.id}">
        ${icon(item.icon)}<span>${item.label}</span>${count ? `<span class="nav-count">${count}</span>` : ""}
      </button>
    `;
    }).join("");
    mobileNav.innerHTML = items.map((item) => `
      <button class="${item.id === state.page ? "active" : ""}" type="button" data-page="${item.id}">
        ${icon(item.icon)}<span>${item.label}</span>
      </button>
    `).join("");
    mobileNav.style.setProperty("--nav-items", items.length);
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
    const renderer = pageRenderers[state.role][state.page];
    mainContent.innerHTML = renderer ? renderer() : renderNotFound();
    bindPageEvents();
    refreshIcons();
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
        <td>${escapeHtml(event.resident)}</td>
        <td>${riskTag(event.level)}</td>
        <td>${statusTag(event.status)}</td>
        <td><div class="cell-copy"><strong>${escapeHtml(event.owner)}</strong><small>${escapeHtml(event.deadline)}</small></div></td>
        <td>
          <button class="text-btn" type="button" data-action="${role === "elder" ? "event-detail" : "handle-event"}" data-id="${event.id}">
            ${role === "elder" ? "查看进度" : event.status === "已办结" ? "查看" : "处理"}${icon("arrow-right")}
          </button>
        </td>
      </tr>
    `).join("");
  }

  function getMovementLogs() {
    return Array.isArray(state.data.movementLogs) ? state.data.movementLogs : [];
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
          <td><div class="cell-copy movement-destination"><strong>${escapeHtml(log.destination)}</strong><small>${escapeHtml(log.reason)}</small></div></td>
          <td><div class="cell-copy"><strong>${escapeHtml(log.departAt)}</strong><small>预计返回：${escapeHtml(log.expectedReturn)}</small></div></td>
          <td><div class="cell-copy"><strong>${escapeHtml(log.responsible)}</strong><small>${escapeHtml(log.responsiblePhone)} · ${escapeHtml(log.companion)}</small></div></td>
          <td><div class="confirmation-stack"><span><small>机构</small>${statusTag(log.institutionStatus)}</span><span><small>监管</small>${statusTag(log.regulatorStatus)}</span></div></td>
          <td><div class="table-actions">${primaryAction}${role === "provider" && isMovementActive(log) ? `<button class="text-btn" type="button" data-action="movement-return" data-id="${log.id}">确认返回</button>` : ""}</div></td>
        </tr>
      `;
    }).join("");
  }

  function renderElderDashboard() {
    const p = state.data.profile;
    const elderEvents = state.data.events.filter((event) => event.residentId === p.id);
    const activeEvent = elderEvents.find((event) => event.status !== "已办结");
    const screening = p.screening;
    return `
      <section class="welcome-band">
        <div><h2>李阿姨，上午好</h2><p>${escapeHtml(p.institution)} · ${escapeHtml(p.room)}</p></div>
        <div class="welcome-status">
          <span><strong>${riskLabel(p.risk)}</strong><small>当前状态</small></span>
          <span><strong>${p.completeness}%</strong><small>档案完整度</small></span>
          <span><strong>${escapeHtml(p.lastCheck)}</strong><small>最近更新</small></span>
        </div>
      </section>

      <div class="quick-grid" aria-label="常用服务">
        <button class="quick-action" type="button" data-page="check">
          <span class="quick-icon">${icon("clipboard-check")}</span><span><strong>状态打卡</strong><small>睡眠、饮食与活动情况</small></span>
        </button>
        <button class="quick-action featured" type="button" data-action="ai-video">
          <span class="quick-icon">${icon("video")}</span><span><strong>AI视频助手</strong><small>面对面说清需求，获得行动卡</small></span>
        </button>
        <button class="quick-action danger" type="button" data-action="emergency-report">
          <span class="quick-icon">${icon("siren")}</span><span><strong>求助与维权</strong><small>语音、照片快速上报</small></span>
        </button>
        <button class="quick-action" type="button" data-page="requests">
          <span class="quick-icon">${icon("route")}</span><span><strong>查看办理进度</strong><small>${elderEvents.length}条事件记录</small></span>
        </button>
      </div>

      <section class="focus-panel elder-focus-panel">
        <div class="focus-copy"><span class="eyebrow">今天先看这里</span><h2>身心状态快筛</h2><p>五个简单维度，帮助机构更早发现睡眠、情绪、跌倒和生活能力变化。</p><div class="focus-actions"><button class="btn btn-primary" type="button" data-action="screening-check">${icon("clipboard-check")}完成今日快筛</button><button class="text-btn" type="button" data-page="profile">查看我的证据记录${icon("arrow-right")}</button></div></div>
        <div class="focus-score"><span>当前综合</span><strong>${riskLabel(screening ? screening.overall : p.risk)}</strong><small>${screening ? `置信度 ${Math.round(screening.confidence * 100)}% · ${screeningStatusTag(screening)}` : "尚未完成今日快筛"}</small></div>
      </section>

      <div class="panel-grid">
        <section class="panel screening-panel">${screeningSummary(screening)}</section>
        <section class="panel">
          <header class="panel-header"><div><h3>今日服务安排</h3><p>服务人员完成后将自动写入动态台账</p></div><button class="text-btn" type="button" data-page="profile">查看档案${icon("arrow-right")}</button></header>
          <div class="panel-body">
            <div class="list-stack">
              <div class="list-item"><span class="list-icon success">${icon("utensils")}</span><div class="list-content"><strong>早餐与用药提醒</strong><p>07:30 · 一楼营养餐厅 · 已完成</p></div><span class="list-side">护理员 林静</span></div>
              <div class="list-item"><span class="list-icon">${icon("activity")}</span><div class="list-content"><strong>血压复测</strong><p>14:30 · 健康管理室 · 请携带个人健康卡</p></div><span class="list-side">护士 梁燕</span></div>
              <div class="list-item"><span class="list-icon">${icon("footprints")}</span><div class="list-content"><strong>膝关节康复训练</strong><p>16:00 · 二楼康复区 · 约20分钟</p></div><span class="list-side">康复师 罗文</span></div>
            </div>
          </div>
        </section>

        <section class="panel">
          <header class="panel-header"><div><h3>需要关注</h3><p>系统根据本人历史基线生成</p></div>${riskTag(p.risk)}</header>
          <div class="panel-body">
            ${activeEvent ? `
              <div class="action-card warning">
                <h3>${escapeHtml(activeEvent.title)}</h3>
                <p>${escapeHtml(activeEvent.action)}</p>
                <div class="action-buttons"><button class="btn btn-primary" type="button" data-action="event-detail" data-id="${activeEvent.id}">${icon("list-checks")}查看处理</button><a class="btn btn-secondary" href="tel:${hotlineForEvent(activeEvent)}">${icon("phone")}联系${hotlineForEvent(activeEvent)}</a></div>
              </div>
            ` : `<div class="empty-state">${icon("badge-check")}<strong>目前没有待处理提醒</strong><p>今日状态正常。</p></div>`}
          </div>
        </section>
      </div>

      <section class="panel" style="margin-top:16px">
        <header class="panel-header"><div><h3>最近动态台账</h3><p>仅展示与本人服务和风险相关的记录</p></div></header>
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr><th>时间</th><th>记录类型</th><th>内容</th><th>来源</th><th>状态</th></tr></thead>
            <tbody>
              <tr><td>今日 08:07</td><td><span class="type-tag">风险提醒</span></td><td>晨间血压高于个人近7日基线</td><td>规则引擎</td><td>${statusTag("待复核")}</td></tr>
              <tr><td>今日 08:05</td><td><span class="type-tag">健康服务</span></td><td>血压138/86 mmHg，建议午后复测</td><td>护理员 林静</td><td>${statusTag("已记录")}</td></tr>
              <tr><td>今日 07:42</td><td><span class="type-tag">状态打卡</span></td><td>睡眠一般、食欲良好、情绪平稳、活动正常</td><td>本人</td><td>${statusTag("已完成")}</td></tr>
              <tr><td>08-09 16:20</td><td><span class="type-tag">康复服务</span></td><td>完成15分钟膝关节训练</td><td>康复师 罗文</td><td>${statusTag("已记录")}</td></tr>
            </tbody>
          </table>
        </div>
      </section>
    `;
  }

  function renderElderProfile() {
    const p = state.data.profile;
    return `
      <div class="page-toolbar">
        <div><h2>旅居老人 OneID 档案</h2><p>跨机构复用必要信息，所有授权均可查看和撤回</p></div>
        <div class="toolbar-actions"><button class="btn btn-secondary" type="button" data-action="edit-profile">${icon("pencil")}更新资料</button></div>
      </div>
      <div class="panel-grid">
        <section class="panel">
          <header class="panel-header"><div><h3>基本信息</h3><p>${escapeHtml(p.id)}</p></div>${riskTag(p.risk)}</header>
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
          <header class="panel-header"><div><h3>档案质量</h3><p>最近核验：今日 07:42</p></div><strong>${p.completeness}%</strong></header>
          <div class="panel-body">
            <div class="progress-track"><div class="progress-bar" style="width:${p.completeness}%"></div></div>
            <div class="list-stack" style="margin-top:14px">
              <div class="list-item"><span class="list-icon success">${icon("badge-check")}</span><div class="list-content"><strong>身份与联系方式</strong><p>来源：本人实名认证 · 今日核验</p></div></div>
              <div class="list-item"><span class="list-icon success">${icon("building-2")}</span><div class="list-content"><strong>入住与服务信息</strong><p>来源：北海银龄康养中心 · 2小时前</p></div></div>
              <div class="list-item"><span class="list-icon warning">${icon("user-round-check")}</span><div class="list-content"><strong>跨区域共享授权</strong><p>尚未开启，更换机构时需重新确认</p></div></div>
            </div>
          </div>
        </section>
      </div>
      <div class="panel-grid equal" style="margin-top:16px">
        <section class="panel">
          <header class="panel-header"><div><h3>当前旅居计划</h3><p>行程变化会同步更新监管台账</p></div></header>
          <div class="panel-body"><div class="profile-grid">
            <div class="data-field"><span>所在城市</span><strong>${escapeHtml(p.stayCity)}</strong></div>
            <div class="data-field"><span>入住机构</span><strong>${escapeHtml(p.institution)}</strong></div>
            <div class="data-field"><span>房间</span><strong>${escapeHtml(p.room)}</strong></div>
            <div class="data-field"><span>计划时间</span><strong>${escapeHtml(p.stayRange)}</strong></div>
          </div></div>
        </section>
        <section class="panel">
          <header class="panel-header"><div><h3>最低必要照护摘要</h3><p>仅在照护与紧急救助场景使用</p></div></header>
          <div class="panel-body"><div class="profile-grid">
            <div class="data-field"><span>慢性病</span><strong>${p.conditions.map(escapeHtml).join("、")}</strong></div>
            <div class="data-field"><span>过敏信息</span><strong>${escapeHtml(p.allergy)}</strong></div>
            <div class="data-field"><span>活动能力</span><strong>可独立行走，长距离需休息</strong></div>
            <div class="data-field"><span>用药提示</span><strong>每日早间降压药</strong></div>
          </div></div>
        </section>
      </div>
      <section class="panel" style="margin-top:16px">
        <header class="panel-header"><div><h3>数据授权</h3><p>按用途和字段控制信息使用范围</p></div></header>
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

  function renderElderCheck() {
    const checks = state.data.dailyChecks;
    const screening = state.data.profile.screening;
    return `
      <div class="page-toolbar">
        <div><h2>今日状态打卡</h2><p>用时约30秒，异常信息将进入人工关怀队列</p></div>
        <div class="toolbar-actions"><button class="btn btn-primary" type="button" data-action="screening-check">${icon("clipboard-check")}五维身心快筛</button><button class="btn btn-secondary" type="button" data-action="health-scan">${icon("scan-face")}AI状态筛查</button></div>
      </div>
      <section class="panel" style="margin-bottom:16px">${screeningSummary(screening)}</section>
      <div class="panel-grid">
        <section class="panel">
          <header class="panel-header"><div><h3>2026年8月10日</h3><p>请选择最接近当前情况的选项</p></div></header>
          <div class="panel-body">
            <form id="daily-check-form" class="form-grid">
              ${checkField("sleep", "昨晚睡眠", ["良好", "一般", "较差"])}
              ${checkField("appetite", "今天食欲", ["良好", "一般", "较差"])}
              ${checkField("mood", "当前心情", ["愉快", "平稳", "低落"])}
              ${checkField("mobility", "活动情况", ["正常", "轻度不适", "行动困难"])}
              <label class="full"><span>补充说明（选填）</span><textarea class="form-control" name="note" placeholder="例如：膝盖有些酸，但可以正常走路"></textarea></label>
              <div class="full"><button class="btn btn-primary" type="submit">${icon("send")}提交今日状态</button></div>
            </form>
          </div>
        </section>
        <section class="panel">
          <header class="panel-header"><div><h3>连续打卡</h3><p>近7天已完成6天</p></div><span class="status-tag success">状态平稳</span></header>
          <div class="panel-body">
            <div class="stat-value" style="margin-top:0"><strong>6</strong><small>天 / 近7天</small></div>
            <div class="progress-track" style="margin-top:13px"><div class="progress-bar" style="width:85.7%"></div></div>
            <div class="notice" style="margin-top:16px">${icon("info")}若出现胸痛、呼吸困难、意识异常等紧急情况，请直接拨打120，不要等待系统分析。</div>
          </div>
        </section>
      </div>
      <section class="panel" style="margin-top:16px">
        <header class="panel-header"><div><h3>最近记录</h3><p>状态变化会与服务记录共同参与风险筛查</p></div></header>
        <div class="table-wrap"><table class="data-table"><thead><tr><th>日期</th><th>睡眠</th><th>食欲</th><th>心情</th><th>活动</th><th>状态</th></tr></thead><tbody>
          ${checks.map((item) => `<tr><td>${escapeHtml(item.date)}</td><td>${escapeHtml(item.sleep)}</td><td>${escapeHtml(item.appetite)}</td><td>${escapeHtml(item.mood)}</td><td>${escapeHtml(item.mobility)}</td><td>${statusTag(item.status)}</td></tr>`).join("")}
        </tbody></table></div>
      </section>
    `;
  }

  function checkField(name, label, options) {
    return `<label><span>${label}</span><select class="form-control" name="${name}" required>${options.map((option) => `<option>${option}</option>`).join("")}</select></label>`;
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
        <div class="notice">${icon("shield-check")}最终等级由确定性规则生成；高风险、冲突数据和低置信度结果必须由工作人员确认。</div>
      </form>`,
      footer: `<button class="btn btn-secondary" type="button" data-action="close-modal">取消</button><button class="btn btn-primary" type="submit" form="screening-form">${icon("sparkles")}生成快筛结果</button>`,
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
    const overall = missing.length ? "medium" : levels.includes("high") ? "high" : levels.includes("medium") ? "medium" : "low";
    const confidence = missing.length ? 0.58 : levels.includes("high") ? 0.78 : 0.94;
    const labels = { activity: "肢体活动", communication: "言语沟通", sensory: "视听能力", emotion: "心理与情绪", daily: "日常生活" };
    const dimensions = Object.entries(values).map(([key, value]) => ({ label: labels[key], value, level: value === "本轮未采集" ? "unknown" : highWords.test(value) ? "high" : mediumWords.test(value) ? "medium" : "low", evidence: String(form.get("evidence") || "本人自填") }));
    state.data.profile.screening = { overall, confidence, source: "本人自填", updatedAt: "刚刚", reviewRequired: missing.length > 0 || overall !== "low", reviewStatus: missing.length ? "缺项待补" : overall === "low" ? "已确认" : "待人工复核", missing, dimensions, carePlan: overall === "high" ? "立即通知机构护理员现场确认；如出现胸痛、呼吸困难或意识异常请拨打120。" : overall === "medium" ? "安排24小时内护理回访，补齐缺项并观察睡眠、食欲和活动变化。" : "保持每日一次快筛，按原旅居计划活动。" };
    state.data.profile.lastCheck = "刚刚";
    state.data.profile.risk = overall;
    state.data.dailyChecks.unshift({ date: "2026-08-13", sleep: values.daily.includes("睡眠") ? values.daily : "已纳入快筛", appetite: values.daily.includes("食欲") ? values.daily : "已纳入快筛", mood: values.emotion, mobility: values.activity, status: missing.length ? "待补项" : "已完成" });
    saveData();
    closeModal();
    showToast(missing.length ? "快筛已保存，等待补齐缺项" : "五维快筛已完成", `${riskLabel(overall)} · 置信度 ${Math.round(confidence * 100)}%${overall !== "low" ? "，已进入人工复核队列" : ""}`, overall === "high" ? "danger" : overall === "medium" ? "warning" : "success");
    renderPage();
  }

  function renderElderRequests() {
    const events = state.data.events.filter((event) => event.residentId === state.data.profile.id);
    const active = events.filter((event) => event.status !== "已办结").length;
    return `
      <div class="page-toolbar">
        <div><h2>我的求助与风险事件</h2><p>可查看责任单位、处置时限和办理结果</p></div>
        <div class="toolbar-actions"><button class="btn btn-danger" type="button" data-action="emergency-report">${icon("siren")}发起求助</button></div>
      </div>
      <div class="stat-grid">
        ${statCard("全部事件", events.length, "条", "messages-square", "含系统风险提醒")}
        ${statCard("办理中", active, "条", "loader-circle", "责任单位已接收", "warning")}
        ${statCard("已办结", events.length - active, "条", "circle-check", "结果可追溯", "positive")}
        ${statCard("平均响应", "8", "分钟", "timer", "快于30分钟目标", "positive")}
      </div>
      <section class="panel">
        <div class="table-wrap"><table class="data-table"><thead><tr><th>事件编号</th><th>事项</th><th>老人</th><th>风险</th><th>状态</th><th>责任单位 / 时限</th><th>操作</th></tr></thead><tbody>${eventRows(events, "elder")}</tbody></table></div>
      </section>
    `;
  }

  function renderProviderDashboard() {
    const residents = state.data.residents;
    const alerts = state.data.events.filter((event) => ["处置中", "待复核", "已转派"].includes(event.status));
    const high = residents.filter((resident) => resident.risk === "high").length;
    const screeningReview = residents.filter((resident) => resident.screening && resident.screening.reviewRequired);
    const stale = residents.filter((resident) => /昨天|天前/.test(resident.fresh));
    const todayServices = state.data.serviceLogs.filter((log) => log.time.startsWith("今日")).length;
    return `
      <div class="page-toolbar">
        <div><h2>北海银龄康养中心</h2><p>今日值班：周敏 · 数据最后同步：08:30</p></div>
        <div class="toolbar-actions"><button class="btn btn-primary" type="button" data-action="movement-report">${icon("route")}外出报备</button><button class="btn btn-secondary" type="button" data-action="record-service">${icon("plus")}记录服务</button><button class="btn btn-secondary" type="button" data-action="register-resident">${icon("user-plus")}办理入住</button></div>
      </div>
      <div class="stat-grid">
        ${statCard("当前在住", residents.length, "位老人", "users-round", "本月新增 16 人", "positive")}
        ${statCard("今日服务", todayServices + 12, "项已完成", "clipboard-check", "完成率 96.8%", "positive")}
        ${statCard("待处置预警", alerts.length, "条", "siren", `${high}条高风险，需优先处理`, high ? "danger" : "warning")}
        ${statCard("本月质量分", "94.2", "分 / 100", "medal", "较上月提升 2.1 分", "positive")}
      </div>
      <section class="focus-panel provider-focus-panel">
        <div class="focus-copy"><span class="eyebrow">今日必须完成</span><h2>身心风险复核队列</h2><p>${screeningReview.length}位老人需要人工确认，${stale.length}位老人动态台账超过24小时未更新。先处理高风险，再补齐缺项。</p><div class="focus-actions"><button class="btn btn-primary" type="button" data-page="residents">${icon("clipboard-check")}进入复核队列</button><button class="text-btn" type="button" data-action="screening-review" data-id="${screeningReview[0] ? screeningReview[0].id : ""}">直接查看首条${icon("arrow-right")}</button></div></div>
        <div class="focus-score queue-score"><span>待复核</span><strong>${screeningReview.length}</strong><small>${stale.length}条数据新鲜度提醒</small></div>
      </section>
      <div class="panel-grid">
        <section class="panel">
          <header class="panel-header"><div><h3>优先处置队列</h3><p>按风险等级和剩余时限排序</p></div><button class="text-btn" type="button" data-page="alerts">进入预警处置${icon("arrow-right")}</button></header>
          <div class="table-wrap"><table class="data-table"><thead><tr><th>老人</th><th>事件</th><th>风险</th><th>状态</th><th>时限</th><th>操作</th></tr></thead><tbody>
            ${alerts.slice(0, 4).map((event) => `<tr><td>${residentCell({ name: event.resident, id: event.residentId })}</td><td><div class="cell-copy"><strong>${escapeHtml(event.title)}</strong><small>${escapeHtml(event.time)} · ${escapeHtml(event.source)}</small></div></td><td>${riskTag(event.level)}</td><td>${statusTag(event.status)}</td><td>${escapeHtml(event.deadline)}</td><td><button class="text-btn" type="button" data-action="handle-event" data-id="${event.id}">处理${icon("arrow-right")}</button></td></tr>`).join("")}
          </tbody></table></div>
        </section>
        <section class="panel">
          <header class="panel-header"><div><h3>服务执行概览</h3><p>今日 00:00 - 08:30</p></div><span class="status-tag success">运行正常</span></header>
          <div class="panel-body">
            <div class="bar-chart">
              ${serviceBar("生活照护", 96, "alt")}
              ${serviceBar("健康监测", 88, "")}
              ${serviceBar("康复训练", 72, "warn")}
              ${serviceBar("行程协助", 64, "coral")}
            </div>
            <div class="notice" style="margin-top:18px">${icon("info")}服务记录必须在完成后2小时内回填，否则将进入机构数据新鲜度提醒。</div>
          </div>
        </section>
        <section class="panel screening-queue-panel">
          <header class="panel-header"><div><h3>身心风险快筛</h3><p>AI只做采集与结构化，最终等级由工作人员确认</p></div><span class="status-tag warning">${screeningReview.length}待复核</span></header>
          <div class="panel-body"><div class="screening-mini-list">${screeningReview.slice(0, 3).map((resident) => `<button class="screening-mini-item" type="button" data-action="screening-review" data-id="${resident.id}"><span class="cell-avatar">${escapeHtml(resident.name.slice(-1))}</span><span><strong>${escapeHtml(resident.name)}</strong><small>${riskLabel(resident.screening.overall)} · ${Math.round(resident.screening.confidence * 100)}%置信度</small></span>${icon("arrow-right")}</button>`).join("") || `<div class="empty-state compact">${icon("badge-check")}<strong>暂无待复核</strong></div>`}</div></div>
        </section>
      </div>
      <section class="panel" style="margin-top:16px">
        <header class="panel-header"><div><h3>最近服务记录</h3><p>抽查记录与老人动态档案同步</p></div><button class="text-btn" type="button" data-page="services">查看全部${icon("arrow-right")}</button></header>
        <div class="table-wrap"><table class="data-table"><thead><tr><th>老人</th><th>服务类型</th><th>执行人</th><th>时间</th><th>结果</th><th>状态</th></tr></thead><tbody>
          ${state.data.serviceLogs.slice(0, 5).map((log) => `<tr><td>${residentCell({ name: log.resident, id: log.residentId })}</td><td><span class="type-tag">${escapeHtml(log.type)}</span></td><td>${escapeHtml(log.staff)}</td><td>${escapeHtml(log.time)}</td><td>${escapeHtml(log.result)}</td><td>${statusTag(log.status)}</td></tr>`).join("")}
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
        <div><h2>在住老人动态档案</h2><p>每条档案展示最后更新时间和当前风险等级</p></div>
        <div class="toolbar-actions"><button class="btn btn-primary" type="button" data-action="register-resident">${icon("user-plus")}办理入住</button></div>
      </div>
      <section class="panel">
        <div class="panel-header"><div><h3>全部在住老人 <span class="muted-inline">${residents.length}人</span></h3><p>支持姓名、档案编号、房间和来源地检索</p></div><div class="filter-row"><label class="global-search" style="width:220px"><i data-lucide="search" aria-hidden="true"></i><input id="resident-query" type="search" value="${escapeHtml(state.residentQuery)}" placeholder="搜索老人档案" aria-label="搜索老人档案"></label><select id="resident-risk" class="form-control" style="min-height:40px;width:120px" aria-label="风险筛选"><option value="all" ${state.residentRisk === "all" ? "selected" : ""}>全部风险</option><option value="high" ${state.residentRisk === "high" ? "selected" : ""}>高风险</option><option value="medium" ${state.residentRisk === "medium" ? "selected" : ""}>需关注</option><option value="low" ${state.residentRisk === "low" ? "selected" : ""}>低风险</option></select></div></div>
        <div class="table-wrap"><table class="data-table"><thead><tr><th>老人</th><th>年龄 / 来源</th><th>房间</th><th>入住时间</th><th>综合风险</th><th>五维快筛</th><th>数据新鲜度</th><th>操作</th></tr></thead><tbody>
          ${residents.length ? residents.map((resident) => `<tr><td>${residentCell(resident)}</td><td>${resident.age}岁 · ${escapeHtml(resident.source)}</td><td>${escapeHtml(resident.room)}</td><td>${escapeHtml(resident.checkIn)}</td><td>${riskTag(resident.screening ? resident.screening.overall : resident.risk)}</td><td>${resident.screening ? screeningStatusTag(resident.screening) : statusTag("未评估")}</td><td>${escapeHtml(resident.fresh)}</td><td><button class="text-btn" type="button" data-action="screening-review" data-id="${resident.id}">复核快筛${icon("arrow-right")}</button></td></tr>`).join("") : `<tr><td colspan="8"><div class="empty-state">${icon("search-x")}<strong>没有匹配的老人</strong><p>请调整搜索词或风险筛选条件。</p></div></td></tr>`}
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
        <div><h2>旅居老人动态台账</h2><p>从机构内服务延伸至外出去向、责任人、返回核验和监管确认</p></div>
        <div class="toolbar-actions"><button class="btn btn-secondary" type="button" data-action="record-service">${icon("clipboard-plus")}记录服务</button><button class="btn btn-primary" type="button" data-action="movement-report">${icon("route")}外出报备</button></div>
      </div>
      <div class="stat-grid movement-stat-grid">
        ${statCard("当前在机构", inInstitution, "人", "building-2", "按最新动向自动更新", "positive")}
        ${statCard("当前在外", outsideIds.size, "人", "map-pinned", "均已绑定责任人", outsideIds.size ? "warning" : "positive")}
        ${statCard("超时未归", overdue.length, "人", "triangle-alert", overdue.length ? "需立即跟进" : "暂无异常", overdue.length ? "danger" : "positive")}
        ${statCard("待监管确认", pending.length, "条", "badge-check", "机构报备后同步推送", pending.length ? "warning" : "positive")}
      </div>
      <section class="panel movement-panel">
        <div class="panel-header"><div><h3>旅居动向记录</h3><p>去向、时限和责任链集中展示，超时记录自动进入预警处置</p></div><span class="status-tag ${overdue.length ? "danger" : "success"}">${overdue.length ? `${overdue.length}条超时` : "动向正常"}</span></div>
        <div class="table-wrap"><table class="data-table movement-table"><thead><tr><th>老人 / 记录</th><th>当前动向</th><th>去向 / 事由</th><th>出发 / 预计返回</th><th>责任人 / 联络</th><th>双重确认</th><th>操作</th></tr></thead><tbody>
          ${movementRows(movements, "provider")}
        </tbody></table></div>
      </section>
      <section class="panel service-ledger-panel">
        <div class="panel-header"><div><h3>机构服务记录</h3><p>已记录 ${state.data.serviceLogs.length} 项 · 与老人档案和动向记录共同构成过程台账</p></div><span class="status-tag success">数据已同步</span></div>
        <div class="table-wrap"><table class="data-table"><thead><tr><th>记录编号</th><th>老人</th><th>服务类型</th><th>执行人</th><th>时间</th><th>服务结果</th><th>状态</th></tr></thead><tbody>
          ${state.data.serviceLogs.map((log) => `<tr><td>${escapeHtml(log.id)}</td><td>${residentCell({ name: log.resident, id: log.residentId })}</td><td><span class="type-tag">${escapeHtml(log.type)}</span></td><td>${escapeHtml(log.staff)}</td><td>${escapeHtml(log.time)}</td><td>${escapeHtml(log.result)}</td><td>${statusTag(log.status)}</td></tr>`).join("")}
        </tbody></table></div>
      </section>
    `;
  }

  function renderProviderAlerts() {
    let alerts = state.data.events.filter((event) => event.status !== "已办结");
    if (state.eventLevel !== "all") alerts = alerts.filter((event) => event.level === state.eventLevel);
    return `
      <div class="page-toolbar">
        <div><h2>预警处置队列</h2><p>按责任人接收、处理并回填结果，超时事件将自动升级</p></div>
        <div class="toolbar-actions"><span class="status-tag danger">${alerts.filter((event) => event.level === "high").length}条高风险</span><button class="btn btn-secondary" type="button" data-action="refresh-data">${icon("refresh-cw")}刷新</button></div>
      </div>
      <section class="panel">
        <div class="panel-header"><div><h3>待处置事件 <span class="muted-inline">${alerts.length}条</span></h3><p>打开事件可查看触发依据、证据和处置时间线</p></div><div class="filter-row"><select id="provider-alert-level" class="form-control" style="min-height:40px;width:130px" aria-label="风险等级"><option value="all">全部等级</option><option value="high" ${state.eventLevel === "high" ? "selected" : ""}>高风险</option><option value="medium" ${state.eventLevel === "medium" ? "selected" : ""}>需关注</option><option value="low" ${state.eventLevel === "low" ? "selected" : ""}>低风险</option></select></div></div>
        <div class="table-wrap"><table class="data-table"><thead><tr><th>事件编号</th><th>事件</th><th>老人</th><th>风险</th><th>状态</th><th>责任单位 / 时限</th><th>操作</th></tr></thead><tbody>${eventRows(alerts, "provider")}</tbody></table></div>
      </section>
      <section class="panel review-note-panel"><div class="notice">${icon("shield-check")}身心风险结果与事件处置共用同一条证据链：中高风险、缺项、冲突数据和低置信度均需人工复核后才能升级或办结。</div></section>
    `;
  }

  function renderRegulatorDashboard() {
    const data = state.data;
    const active = data.events.filter((event) => event.status !== "已办结");
    const high = active.filter((event) => event.level === "high").length;
    const screeningReview = data.residents.filter((resident) => resident.screening && resident.screening.reviewRequired).length;
    const movementLogs = getMovementLogs();
    const outside = activeMovementResidentIds(movementLogs).size;
    const pendingMovement = movementLogs.filter((log) => log.regulatorStatus === "待确认").length;
    const overdueMovement = movementLogs.filter((log) => log.status === "超时未归").length;
    const confirmationRate = movementLogs.length ? Math.round((movementLogs.length - pendingMovement) / movementLogs.length * 100) : 100;
    return `
      <div class="page-toolbar">
        <div><h2>自治区旅居养老监管总览</h2><p>数据范围：接入机构 68 家 · 更新时间：今日 08:30</p></div>
        <div class="toolbar-actions"><button class="btn btn-secondary" type="button" data-action="export-report">${icon("download")}导出简报</button><button class="btn btn-primary" type="button" data-page="events">${icon("siren")}查看事件中心</button></div>
      </div>
      <div class="stat-grid">
        ${statCard("当前在桂老人", "1,284", "人", "users-round", "较昨日 +38 人", "positive")}
        ${statCard("接入服务机构", "68", "家", "building-2", "覆盖 8 个重点区域", "positive")}
        ${statCard("处置中预警", active.length, "条", "siren", `${high}条高风险，需督办`, high ? "danger" : "warning")}
        ${statCard("事件闭环率", "93.6", "%", "circle-check", "较上周提升 4.2%", "positive")}
      </div>
      <section class="focus-panel regulator-focus-panel">
        <div class="focus-copy"><span class="eyebrow">今日重点核验</span><h2>旅居动向责任链</h2><p>当前${outside}位老人处于机构外，${pendingMovement}条报备待监管确认，${overdueMovement}条超时未归已联动风险预警。重点核验去向、返回时间、责任人和联络方式。</p><div class="focus-actions"><button class="btn btn-primary" type="button" data-page="movements">${icon("route")}进入动向监管</button><button class="text-btn" type="button" data-page="events">督办异常事件${icon("arrow-right")}</button></div></div>
        <div class="focus-score"><span>责任链确认率</span><strong>${confirmationRate}%</strong><small>${pendingMovement}条待确认 · ${overdueMovement}条重点跟进</small></div>
      </section>
      <div class="panel-grid">
        <section class="panel">
          <header class="panel-header"><div><h3>重点事件处置</h3><p>全区未办结事件，按风险与时限排序</p></div><button class="text-btn" type="button" data-page="events">进入事件中心${icon("arrow-right")}</button></header>
          <div class="table-wrap"><table class="data-table"><thead><tr><th>事件</th><th>老人</th><th>等级</th><th>责任单位</th><th>状态</th><th>剩余时限</th><th>操作</th></tr></thead><tbody>${eventRows(active.slice(0, 4), "regulator")}</tbody></table></div>
        </section>
        <section class="panel">
          <header class="panel-header"><div><h3>区域人群分布</h3><p>当前在住人数 / 预警数</p></div><button class="text-btn" type="button" data-page="monitoring">查看监测${icon("arrow-right")}</button></header>
          <div class="panel-body">
            <div class="bar-chart">
              ${regionBar("南宁", 402, 3, "alt")}
              ${regionBar("桂林", 318, 4, "")}
              ${regionBar("北海", 276, 6, "warn")}
              ${regionBar("河池", 145, 2, "coral")}
              ${regionBar("防城港", 98, 2, "")}
            </div>
          </div>
        </section>
        <section class="panel screening-panel">
          <header class="panel-header"><div><h3>身心风险质量指标</h3><p>监管看聚合，不看原始隐私数据</p></div>${statusTag("关注")}</header>
          <div class="panel-body"><div class="quality-metrics"><div><strong>91.8%</strong><span>五维字段完整率</span></div><div><strong>88.4%</strong><span>人工复核及时率</span></div><div><strong>97.2%</strong><span>证据可追溯率</span></div></div><div class="notice" style="margin-top:16px">${icon("triangle-alert")}建议督促3家机构在24小时内补齐缺项。</div></div>
        </section>
      </div>
      <div class="panel-grid equal" style="margin-top:16px">
        <section class="panel">
          <header class="panel-header"><div><h3>机构质量关注</h3><p>响应时间、闭环率和投诉情况综合评分</p></div><button class="text-btn" type="button" data-page="institutions">查看机构${icon("arrow-right")}</button></header>
          <div class="table-wrap"><table class="data-table"><thead><tr><th>机构</th><th>城市</th><th>评分</th><th>闭环率</th><th>状态</th></tr></thead><tbody>${data.institutions.slice(0, 4).map((institution) => `<tr><td><strong>${escapeHtml(institution.name)}</strong></td><td>${escapeHtml(institution.city)}</td><td><strong>${institution.score}</strong></td><td>${institution.closure}%</td><td>${statusTag(institution.status)}</td></tr>`).join("")}</tbody></table></div>
        </section>
        <section class="panel">
          <header class="panel-header"><div><h3>今日监管动作</h3><p>系统根据时限与风险自动生成</p></div></header>
          <div class="panel-body"><div class="list-stack">
            <div class="list-item"><span class="list-icon danger">${icon("alarm-clock")}</span><div class="list-content"><strong>督办 2 条红色预警</strong><p>北海市公安联络组、卫健部门需在30分钟内反馈</p></div><span class="list-side">刚刚</span></div>
            <div class="list-item"><span class="list-icon warning">${icon("file-warning")}</span><div class="list-content"><strong>核验 3 条过期档案</strong><p>紧急联系人信息超过90天未确认</p></div><span class="list-side">09:00前</span></div>
            <div class="list-item"><span class="list-icon success">${icon("chart-no-axes-combined")}</span><div class="list-content"><strong>生成周度质量报告</strong><p>覆盖机构68家，数据完整率91.8%</p></div><span class="list-side">昨日</span></div>
          </div></div>
        </section>
      </div>
    `;
  }

  function regionBar(name, people, alerts, tone) {
    const width = Math.round(people / 4.5);
    return `<div class="bar-row"><span>${name}</span><span class="bar-track"><span class="bar-fill ${tone}" style="width:${width}%"></span></span><strong>${people}<small style="display:block;color:var(--muted);font-size:9px;font-weight:400">${alerts}条预警</small></strong></div>`;
  }

  function renderRegulatorMonitoring() {
    const screenings = state.data.residents.map((resident) => resident.screening).filter(Boolean);
    const reviewCount = screenings.filter((item) => item.reviewRequired).length;
    const missingCount = screenings.filter((item) => item.missing && item.missing.length).length;
    return `
      <div class="page-toolbar">
        <div><h2>人群动态监测</h2><p>以旅居老人当前位置、行程状态和风险变化为核心</p></div>
        <div class="toolbar-actions"><span class="status-tag success">数据已更新</span><button class="btn btn-secondary" type="button" data-action="export-report">${icon("download")}导出监测表</button></div>
      </div>
      <div class="panel-grid equal">
        <section class="panel">
          <header class="panel-header"><div><h3>重点区域人群热度</h3><p>人数越高，区域条带越长；右侧为当前预警数</p></div></header>
          <div class="panel-body"><div class="bar-chart">
            ${regionBar("南宁", 402, 3, "alt")}
            ${regionBar("桂林", 318, 4, "")}
            ${regionBar("北海", 276, 6, "warn")}
            ${regionBar("巴马", 145, 2, "coral")}
            ${regionBar("防城港", 98, 2, "")}
            ${regionBar("钦州", 86, 1, "alt")}
          </div></div>
        </section>
        <section class="panel">
          <header class="panel-header"><div><h3>风险构成</h3><p>基于有效动态台账的当前快照</p></div></header>
          <div class="panel-body"><div class="donut-wrap"><div class="donut"><div class="donut-label"><strong>1,284</strong><span>在桂老人</span></div></div><div class="legend-list"><span><i class="legend-swatch" style="background:var(--red)"></i>高风险 12%</span><span><i class="legend-swatch" style="background:var(--amber)"></i>需关注 23%</span><span><i class="legend-swatch" style="background:var(--blue)"></i>观察 21%</span><span><i class="legend-swatch" style="background:var(--green)"></i>稳定 44%</span></div></div></div>
        </section>
        <section class="panel screening-panel">
          <header class="panel-header"><div><h3>身心风险聚合</h3><p>按五维观察项汇总，保留来源和复核状态</p></div>${statusTag(reviewCount ? "关注" : "正常")}</header>
          <div class="panel-body"><div class="quality-metrics"><div><strong>${screenings.filter((item) => item.overall === "high").length}</strong><span>高风险</span></div><div><strong>${reviewCount}</strong><span>待人工复核</span></div><div><strong>${missingCount}</strong><span>含缺项</span></div></div><div class="dimension-rollup">${["肢体活动", "言语沟通", "视听能力", "心理与情绪", "日常生活"].map((label) => `<span><b>${label}</b><em>${screenings.filter((item) => item.dimensions.some((d) => d.label === label && d.level !== "unknown")).length}/${screenings.length}</em></span>`).join("")}</div></div>
        </section>
      </div>
      <section class="panel" style="margin-top:16px">
        <header class="panel-header"><div><h3>动态台账质量</h3><p>每条数据带有更新时间、来源和授权范围</p></div></header>
        <div class="table-wrap"><table class="data-table"><thead><tr><th>指标</th><th>当前值</th><th>目标值</th><th>状态</th><th>改进建议</th></tr></thead><tbody>
          <tr><td><strong>关键字段完整率</strong></td><td>91.8%</td><td>≥90%</td><td>${statusTag("正常")}</td><td>重点补齐紧急联系人和过敏信息</td></tr>
          <tr><td><strong>24小时内更新率</strong></td><td>87.4%</td><td>≥95%</td><td>${statusTag("关注")}</td><td>提醒机构回填服务记录</td></tr>
          <tr><td><strong>来源可追溯率</strong></td><td>99.1%</td><td>≥98%</td><td>${statusTag("正常")}</td><td>保留规则命中、证据和人工复核记录</td></tr>
          <tr><td><strong>身心快筛复核及时率</strong></td><td>88.4%</td><td>≥95%</td><td>${statusTag("关注")}</td><td>优先处理高风险、低置信度和缺项结果</td></tr>
          <tr><td><strong>跨机构重复建档率</strong></td><td>3.2%</td><td>≤5%</td><td>${statusTag("正常")}</td><td>持续推广OneID扫码复用</td></tr>
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
    if (state.movementStatus === "scheduled") movements = movements.filter((log) => log.status === "待出发");
    if (state.movementConfirm === "pending") movements = movements.filter((log) => log.regulatorStatus === "待确认");
    if (state.movementConfirm === "confirmed") movements = movements.filter((log) => log.regulatorStatus !== "待确认");
    const outsideIds = activeMovementResidentIds(allMovements);
    const overdue = allMovements.filter((log) => log.status === "超时未归");
    const pending = allMovements.filter((log) => log.regulatorStatus === "待确认");
    const crossCity = allMovements.filter((log) => log.type === "跨市行程" && log.status !== "已返回");
    return `
      <div class="page-toolbar">
        <div><h2>旅居老人动向监管</h2><p>确认机构外出报备、责任链和返回状态，异常动向联动事件中心</p></div>
        <div class="toolbar-actions"><button class="btn btn-secondary" type="button" data-action="export-movements">${icon("download")}导出动向表</button></div>
      </div>
      <div class="stat-grid movement-stat-grid">
        ${statCard("当前在外", outsideIds.size, "人", "map-pinned", "来自机构最新报备", outsideIds.size ? "warning" : "positive")}
        ${statCard("待监管确认", pending.length, "条", "badge-check", "核验责任人和返回计划", pending.length ? "warning" : "positive")}
        ${statCard("超时未归", overdue.length, "条", "triangle-alert", overdue.length ? "已联动风险预警" : "暂无异常", overdue.length ? "danger" : "positive")}
        ${statCard("跨市行程", crossCity.length, "条", "train-front", "关注离住交接完整性")}
      </div>
      <section class="panel movement-panel">
        <div class="panel-header"><div><h3>全区动向清单 <span class="muted-inline">${movements.length}条</span></h3><p>监管确认只核验报备与责任链，不替代机构现场照护责任</p></div><div class="filter-row"><select id="movement-status" class="form-control" style="min-height:40px;width:135px" aria-label="动向状态筛选"><option value="all" ${state.movementStatus === "all" ? "selected" : ""}>全部动向</option><option value="active" ${state.movementStatus === "active" ? "selected" : ""}>当前在外</option><option value="overdue" ${state.movementStatus === "overdue" ? "selected" : ""}>超时未归</option><option value="scheduled" ${state.movementStatus === "scheduled" ? "selected" : ""}>待出发</option><option value="returned" ${state.movementStatus === "returned" ? "selected" : ""}>已返回</option></select><select id="movement-confirm" class="form-control" style="min-height:40px;width:145px" aria-label="监管确认筛选"><option value="all" ${state.movementConfirm === "all" ? "selected" : ""}>全部确认状态</option><option value="pending" ${state.movementConfirm === "pending" ? "selected" : ""}>待监管确认</option><option value="confirmed" ${state.movementConfirm === "confirmed" ? "selected" : ""}>已确认 / 跟进</option></select></div></div>
        <div class="table-wrap"><table class="data-table movement-table"><thead><tr><th>老人 / 记录</th><th>当前动向</th><th>去向 / 事由</th><th>出发 / 预计返回</th><th>责任人 / 联络</th><th>双重确认</th><th>操作</th></tr></thead><tbody>${movementRows(movements, "regulator")}</tbody></table></div>
      </section>
      <section class="panel review-note-panel"><div class="notice">${icon("shield-check")}监管确认重点核验“去哪里、何时回、谁负责、如何联系”。超时未归或责任人缺失的记录不得直接办结，需转入人工预警处置。</div></section>
    `;
  }

  function renderRegulatorInstitutions() {
    const query = state.institutionQuery.trim().toLowerCase();
    const institutions = state.data.institutions.filter((item) => !query || [item.name, item.city].join(" ").toLowerCase().includes(query));
    return `
      <div class="page-toolbar">
        <div><h2>机构服务质量监管</h2><p>用服务记录、响应时长和事件闭环评价机构</p></div>
        <div class="toolbar-actions"><button class="btn btn-secondary" type="button" data-action="export-report">${icon("download")}导出机构报告</button></div>
      </div>
      <div class="stat-grid">
        ${statCard("平均质量分", "92.8", "分", "medal", "较上月 +1.6", "positive")}
        ${statCard("数据完整率", "91.8", "%", "database", "3家机构需补录", "warning")}
        ${statCard("平均响应", "12", "分钟", "timer", "目标≤30分钟", "positive")}
        ${statCard("本月投诉", "26", "件", "message-square-warning", "同比下降 18%", "positive")}
      </div>
      <section class="panel">
        <div class="panel-header"><div><h3>接入机构清单</h3><p>共 ${institutions.length} 家匹配机构 · 点击查看质量构成</p></div><label class="global-search" style="width:240px"><i data-lucide="search" aria-hidden="true"></i><input id="institution-query" type="search" value="${escapeHtml(state.institutionQuery)}" placeholder="搜索机构或城市" aria-label="搜索机构或城市"></label></div>
        <div class="table-wrap"><table class="data-table"><thead><tr><th>机构</th><th>城市</th><th>在住老人</th><th>待处理预警</th><th>平均响应</th><th>事件闭环率</th><th>质量分</th><th>状态</th><th>操作</th></tr></thead><tbody>
          ${institutions.length ? institutions.map((item) => `<tr><td><strong>${escapeHtml(item.name)}</strong><small style="display:block;color:var(--muted);margin-top:3px">${escapeHtml(item.id)}</small></td><td>${escapeHtml(item.city)}</td><td>${item.residents}</td><td>${item.alerts}</td><td>${escapeHtml(item.response)}</td><td>${item.closure}%</td><td><strong>${item.score}</strong></td><td>${statusTag(item.status)}</td><td><button class="text-btn" type="button" data-action="institution-detail" data-id="${item.id}">查看${icon("arrow-right")}</button></td></tr>`).join("") : `<tr><td colspan="9"><div class="empty-state">${icon("search-x")}<strong>没有匹配机构</strong></div></td></tr>`}
        </tbody></table></div>
      </section>
    `;
  }

  function renderRegulatorEvents() {
    let events = state.data.events.slice();
    if (state.eventLevel !== "all") events = events.filter((event) => event.level === state.eventLevel);
    if (state.eventStatus !== "all") events = events.filter((event) => event.status === state.eventStatus);
    return `
      <div class="page-toolbar">
        <div><h2>风险与事件中心</h2><p>全区事件一张表，支持转派、督办、升级和闭环核验</p></div>
        <div class="toolbar-actions"><button class="btn btn-secondary" type="button" data-action="export-report">${icon("download")}导出事件清单</button></div>
      </div>
      <section class="panel">
        <div class="panel-header"><div><h3>事件清单 <span class="muted-inline">${events.length}条</span></h3><p>高风险事件必须人工复核，不由大模型独立派单</p></div><div class="filter-row"><select id="event-level" class="form-control" style="min-height:40px;width:120px" aria-label="事件风险筛选"><option value="all">全部风险</option><option value="high" ${state.eventLevel === "high" ? "selected" : ""}>高风险</option><option value="medium" ${state.eventLevel === "medium" ? "selected" : ""}>需关注</option><option value="low" ${state.eventLevel === "low" ? "selected" : ""}>低风险</option></select><select id="event-status" class="form-control" style="min-height:40px;width:125px" aria-label="事件状态筛选"><option value="all">全部状态</option><option value="处置中" ${state.eventStatus === "处置中" ? "selected" : ""}>处置中</option><option value="待复核" ${state.eventStatus === "待复核" ? "selected" : ""}>待复核</option><option value="已转派" ${state.eventStatus === "已转派" ? "selected" : ""}>已转派</option><option value="已办结" ${state.eventStatus === "已办结" ? "selected" : ""}>已办结</option></select></div></div>
        <div class="table-wrap"><table class="data-table"><thead><tr><th>事件编号</th><th>事项</th><th>老人</th><th>风险</th><th>状态</th><th>责任单位 / 时限</th><th>操作</th></tr></thead><tbody>${eventRows(events, "regulator")}</tbody></table></div>
      </section>
    `;
  }

  const pageRenderers = {
    elder: { dashboard: renderElderDashboard, profile: renderElderProfile, check: renderElderCheck, requests: renderElderRequests },
    provider: { dashboard: renderProviderDashboard, residents: renderProviderResidents, services: renderProviderServices, alerts: renderProviderAlerts },
    regulator: { dashboard: renderRegulatorDashboard, monitoring: renderRegulatorMonitoring, movements: renderRegulatorMovements, institutions: renderRegulatorInstitutions, events: renderRegulatorEvents }
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
    const checkForm = document.getElementById("daily-check-form");
    if (checkForm) checkForm.addEventListener("submit", submitDailyCheck);
  }

  function submitDailyCheck(event) {
    event.preventDefault();
    const form = new FormData(event.target);
    const entry = {
      date: "2026-08-10",
      sleep: form.get("sleep"),
      appetite: form.get("appetite"),
      mood: form.get("mood"),
      mobility: form.get("mobility"),
      status: "已完成"
    };
    state.data.dailyChecks = [entry, ...state.data.dailyChecks.filter((item) => item.date !== entry.date)];
    state.data.profile.lastCheck = "刚刚";
    saveData();
    showToast("今日状态已提交", "如出现连续异常，服务机构会收到关怀提醒。");
    renderPage();
  }

  function openHealthScan() {
    openModal({
      title: "AI辅助状态筛查",
      subtitle: "仅做非诊断性风险提示，结果不会替代医生判断",
      body: `
        <div class="notice">${icon("shield-check")}请在光线均匀、本人同意的情况下使用。原始视频默认只在当前设备处理，不上传平台。</div>
        <div class="camera-stage" id="camera-stage" style="margin-top:14px">
          <video id="camera-video" autoplay muted playsinline hidden></video>
          <div class="camera-placeholder" id="camera-placeholder">${icon("scan-face")}<strong>摄像头尚未开启</strong><span>点击下方按钮开始本次筛查</span></div>
          <div class="scan-frame" hidden></div>
        </div>
        <div id="scan-progress-wrap" class="scan-progress" hidden><div class="progress-track"><div id="scan-progress" class="progress-bar" style="width:0%"></div></div><small id="scan-progress-label" style="color:var(--muted)">正在分析...</small></div>
        <div id="scan-result" hidden style="margin-top:14px">
          <div class="notice warning">${icon("flask-conical")}原型演示结果：本版尚未接入医疗级 rPPG 算法，以下数值用于展示后续接入后的业务流程，不作为真实测量结果。</div>
          <div class="result-grid" style="margin-top:12px"><div class="result-item"><strong>72</strong><span>演示心率趋势 bpm</span></div><div class="result-item"><strong>16</strong><span>演示呼吸趋势 次/分</span></div><div class="result-item"><strong>轻度</strong><span>演示疲劳风险</span></div></div>
          <div class="notice" style="margin-top:12px">${icon("info")}建议：午后复测血压，保持饮水；若出现持续头晕或胸闷，请联系机构护士。</div>
        </div>
      `,
      footer: `<button class="btn btn-secondary" type="button" data-action="enable-camera">${icon("camera")}开启摄像头</button><button class="btn btn-primary" type="button" data-action="start-scan" disabled>${icon("sparkles")}开始筛查</button>`,
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
      label.textContent = value < 100 ? `正在分析面部状态与呼吸趋势 ${value}%` : "筛查完成";
      if (value >= 100) {
        window.clearInterval(timer);
        result.hidden = false;
        showToast("筛查完成", "结果已写入本次临时记录，不改变医学档案。", "success");
      }
    }, 170);
  }

  function openAiVideoAssistant() {
    state.aiHistory = [];
    state.lastAiResult = null;
    state.aiProvider = "";
    openModal({
      title: "AI视频助手",
      subtitle: "视频留在本机，只发送您主动说出的文字和必要档案摘要",
      wide: true,
      body: `
        <div class="video-assistant-layout">
          <section class="ai-video-pane" aria-label="视频对话画面">
            <div class="video-session-head"><span id="ai-api-status" class="api-pill checking"><span></span>正在检查AI服务</span><small>本次会话不保存原始音视频</small></div>
            <div class="ai-video-stage">
              <video id="ai-video" autoplay muted playsinline hidden></video>
              <div id="ai-video-placeholder" class="camera-placeholder">${icon("video")}<strong>准备开始视频对话</strong><span>开启摄像头后，画面仅在本机显示</span></div>
              <div class="video-local-label">${icon("shield-check")}本机画面</div>
            </div>
            <div class="video-controls" aria-label="视频控制">
              <button id="ai-camera-btn" class="call-control" type="button" data-action="toggle-ai-camera" aria-label="开启摄像头" title="开启摄像头">${icon("video")}</button>
              <button id="ai-mic-btn" class="call-control primary" type="button" data-action="start-ai-speech" aria-label="开始说话" title="开始说话">${icon("mic")}</button>
              <button class="call-control danger" type="button" data-action="close-modal" aria-label="结束对话" title="结束对话">${icon("phone-off")}</button>
            </div>
            <p id="speech-status" class="speech-status">点击麦克风，说出您现在遇到的问题</p>
          </section>
          <section class="ai-dialogue-pane" aria-label="AI对话与结果">
            <div id="ai-chat-log" class="chat-log" aria-live="polite">
              <div class="chat-bubble assistant"><span class="chat-avatar">${icon("sparkles")}</span><p>李阿姨您好，请直接告诉我发生了什么。我会给您简短的下一步、地点、费用和电话。</p></div>
            </div>
            <form id="ai-chat-form" class="ai-composer">
              <textarea id="ai-dialog-input" rows="2" placeholder="也可以在这里输入，例如：我被多收了费用，应该找谁？" aria-label="输入对话内容" required></textarea>
              <button id="ai-send-btn" class="btn btn-primary" type="submit">${icon("send")}发送</button>
            </form>
          </section>
        </div>
        <section id="ai-result-area" class="ai-result-area" aria-live="polite" hidden></section>
      `,
      onOpen: () => {
        document.getElementById("ai-chat-form").addEventListener("submit", (event) => {
          event.preventDefault();
          sendAiMessage(document.getElementById("ai-dialog-input").value);
        });
        checkAiServiceStatus();
      }
    });
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
        status.innerHTML = `<span></span>DeepSeek已连接 · ${escapeHtml(data.model)}`;
      } else {
        status.className = "api-pill fallback";
        status.innerHTML = "<span></span>未找到API配置 · 使用本地规则";
      }
    } catch (error) {
      status.className = "api-pill fallback";
      status.innerHTML = location.hostname.endsWith("github.io")
        ? "<span></span>在线演示 · 使用本地安全规则"
        : "<span></span>请从“启动作品.bat”打开 · 当前使用本地规则";
    }
  }

  async function toggleAiCamera() {
    const video = document.getElementById("ai-video");
    const placeholder = document.getElementById("ai-video-placeholder");
    const button = document.getElementById("ai-camera-btn");
    if (!video || !placeholder || !button) return;

    if (state.activeStream) {
      state.activeStream.getTracks().forEach((track) => track.stop());
      state.activeStream = null;
      video.srcObject = null;
      video.hidden = true;
      placeholder.hidden = false;
      button.classList.remove("active");
      button.innerHTML = icon("video");
      button.setAttribute("aria-label", "开启摄像头");
      refreshIcons();
      return;
    }

    try {
      state.activeStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
      video.srcObject = state.activeStream;
      video.hidden = false;
      placeholder.hidden = true;
      button.classList.add("active");
      button.innerHTML = icon("video-off");
      button.setAttribute("aria-label", "关闭摄像头");
      refreshIcons();
    } catch (error) {
      showToast("摄像头未开启", "仍可使用文字或语音完成AI对话。", "warning");
    }
  }

  function startAiSpeech() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const input = document.getElementById("ai-dialog-input");
    const status = document.getElementById("speech-status");
    const button = document.getElementById("ai-mic-btn");
    if (!SpeechRecognition) {
      status.textContent = "当前浏览器不支持语音转文字，请在右侧输入问题";
      input.focus();
      return;
    }

    if (state.speechRecognition) {
      state.speechRecognition.stop();
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = "zh-CN";
    recognition.continuous = false;
    recognition.interimResults = true;
    state.speechRecognition = recognition;
    button.classList.add("listening");
    button.innerHTML = icon("square");
    status.textContent = "正在听，请慢慢说...";
    refreshIcons();

    recognition.onresult = (event) => {
      let transcript = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        transcript += event.results[index][0].transcript;
      }
      input.value = transcript;
      status.textContent = event.results[event.results.length - 1].isFinal ? "已转成文字，正在提交..." : `正在识别：${transcript}`;
      if (event.results[event.results.length - 1].isFinal) sendAiMessage(transcript);
    };
    recognition.onerror = () => {
      status.textContent = "没有听清，请点击麦克风重试或输入文字";
      showToast("语音识别未完成", "可以直接在输入框中描述问题。", "warning");
    };
    recognition.onend = () => {
      state.speechRecognition = null;
      if (button) {
        button.classList.remove("listening");
        button.innerHTML = icon("mic");
      }
      refreshIcons();
    };
    recognition.start();
  }

  function appendAiBubble(role, content) {
    const log = document.getElementById("ai-chat-log");
    if (!log) return;
    const bubble = document.createElement("div");
    bubble.className = `chat-bubble ${role}`;
    bubble.innerHTML = role === "assistant"
      ? `<span class="chat-avatar">${icon("sparkles")}</span><p>${escapeHtml(content)}</p>`
      : `<p>${escapeHtml(content)}</p>`;
    log.appendChild(bubble);
    log.scrollTop = log.scrollHeight;
    refreshIcons();
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

  async function sendAiMessage(rawMessage) {
    const message = String(rawMessage || "").trim();
    if (!message) return;
    const input = document.getElementById("ai-dialog-input");
    if (input) input.value = "";
    appendAiBubble("user", message);
    state.aiHistory.push({ role: "user", content: message });
    setAiBusy(true);

    let responseData;
    let provider = "DeepSeek";
    try {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 46000);
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
            allergy: state.data.profile.allergy
          }
        })
      });
      window.clearTimeout(timeout);
      if (!response.ok) throw new Error("api_unavailable");
      const payload = await response.json();
      responseData = payload.result;
      provider = `${payload.provider} · ${payload.model}`;
    } catch (error) {
      responseData = localAiFallback(message);
      provider = "本地应急规则";
    }

    state.lastAiResult = responseData;
    state.aiProvider = provider;
    state.aiHistory.push({ role: "assistant", content: responseData.summary });
    appendAiBubble("assistant", responseData.summary);
    renderAiResult(responseData, provider);
    setAiBusy(false);
    const speechStatus = document.getElementById("speech-status");
    if (speechStatus) speechStatus.textContent = "结果已生成，可以继续补充情况";
  }

  function localAiFallback(message) {
    const text = message.toLowerCase();
    if (/胸痛|呼吸困难|昏迷|意识不清|剧烈头痛|严重摔伤/.test(text)) {
      return { summary: "可能存在健康紧急风险，请立即联系120。", immediate_actions: ["坐下或平躺，避免独自走动", "请身边人员陪同", "立即拨打120"], place_route: "留在当前位置，保持通道畅通，等待急救人员。", price: "急救及就医费用以医疗机构实际结算为准。", phone: "120", risk_level: "high", escalate: true, rationale: ["描述中出现紧急健康症状", "需要专业医疗人员现场判断"] };
    }
    if (/迷路|找不到路|走失|被跟踪|人身危险|抢劫|打人/.test(text)) {
      return { summary: "请先保证人身安全，并尽快联系110。", immediate_actions: ["留在明亮且有人值守的位置", "发送当前位置给家属或机构", "拨打110说明情况"], place_route: "优先前往附近警务站、游客服务中心或有人值守的公共场所。", price: "报警求助免费。", phone: "110", risk_level: "high", escalate: true, rationale: ["描述涉及走失或人身安全", "需要属地公安协助"] };
    }
    if (/收费|价格|退款|多收|票据|消费/.test(text)) {
      return { summary: "先保存票据和付款记录，再要求核对公示价格。", immediate_actions: ["拍照保存价目表和票据", "向机构提出核对与退款诉求", "未解决时拨打12315"], place_route: "先到机构服务台；仍未解决可联系属地市场监管部门。", price: "维权咨询免费，实际费用以公示与合同为准。", phone: "12315", risk_level: "medium", escalate: true, rationale: ["描述涉及收费争议", "需要保留证据并核验公示价格"] };
    }
    return { summary: "情况已记录，建议先联系机构工作人员协助处理。", immediate_actions: ["说明发生时间、地点和诉求", "保留相关照片或记录", "需要主管部门协助时拨打12345"], place_route: "前往所在机构服务台，或留在当前位置等待工作人员联系。", price: "咨询免费，服务费用以机构公示为准。", phone: "12345", risk_level: "low", escalate: false, rationale: ["暂未识别到需要立即报警或急救的描述"] };
  }

  function renderAiResult(result, provider) {
    const area = document.getElementById("ai-result-area");
    if (!area) return;
    const actions = Array.isArray(result.immediate_actions) ? result.immediate_actions : [];
    const rationale = Array.isArray(result.rationale) ? result.rationale : [];
    const phone = String(result.phone || "12345");
    const phoneDigits = phone.replace(/[^0-9]/g, "") || "12345";
    area.hidden = false;
    area.innerHTML = `
      <div class="ai-result-head"><div><span class="eyebrow">AI适老行动卡</span><h3>${escapeHtml(result.summary)}</h3></div>${riskTag(result.risk_level || "low")}</div>
      <div class="ai-action-grid">
        <div class="ai-result-block"><span>${icon("list-checks")}现在先做</span><ol>${actions.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ol></div>
        <div class="ai-result-block"><span>${icon("route")}地点 / 路线</span><strong>${escapeHtml(result.place_route || "等待工作人员联系")}</strong></div>
        <div class="ai-result-block"><span>${icon("wallet-cards")}费用</span><strong>${escapeHtml(result.price || "以现场公示为准")}</strong></div>
        <div class="ai-result-block phone"><span>${icon("phone")}联系电话</span><strong>${escapeHtml(phone)}</strong></div>
      </div>
      ${rationale.length ? `<details class="ai-rationale"><summary>查看判断依据</summary><ul>${rationale.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></details>` : ""}
      <div class="ai-result-actions"><small>${icon("cpu")}结果来源：${escapeHtml(provider)} · 高风险仍需人工确认</small><div><a class="btn btn-secondary" href="tel:${phoneDigits}">${icon("phone")}拨打 ${escapeHtml(phone)}</a><button class="btn btn-primary" type="button" data-action="create-event-from-ai">${icon("send")}生成求助事件</button></div></div>
    `;
    refreshIcons();
    area.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function createEventFromAi() {
    const result = state.lastAiResult;
    if (!result) return;
    const lastMessage = [...state.aiHistory].reverse().find((item) => item.role === "user");
    const phone = String(result.phone || "12345");
    const category = phone.includes("120") ? "健康异常" : phone.includes("110") ? "人身安全" : phone.includes("12315") ? "服务投诉" : "其他求助";
    const eventItem = {
      id: `EV-20260810-${String(state.data.events.length + 18).padStart(3, "0")}`,
      residentId: state.data.profile.id,
      resident: state.data.profile.name,
      level: result.risk_level || "medium",
      category,
      title: String(result.summary || "AI视频对话求助").slice(0, 60),
      source: "AI视频对话",
      location: `${state.data.profile.institution} · ${state.data.profile.room}`,
      time: "刚刚",
      status: "待复核",
      owner: category === "健康异常" ? "北海市卫健部门" : category === "人身安全" ? "属地应急联络组" : category === "服务投诉" ? "北海市市场监管部门" : "12345政务服务便民热线",
      deadline: result.risk_level === "high" ? "优先响应" : "2小时内反馈",
      summary: lastMessage ? lastMessage.content : result.summary,
      action: Array.isArray(result.immediate_actions) ? result.immediate_actions.join("；") : result.summary,
      timeline: [{ time: "刚刚", text: "老人完成AI视频对话", state: "done" }, { time: "刚刚", text: "AI生成行动卡并提交人工复核", state: "current" }]
    };
    state.data.events.unshift(eventItem);
    saveData();
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
      title: "发起求助 / 维权",
      subtitle: "系统会把语音、照片和描述整理成一张事件卡",
      body: `
        <form id="emergency-form" class="form-grid">
          <label><span>事项类型</span><select class="form-control" name="category" required><option value="服务投诉">服务投诉</option><option value="人身安全">人身安全</option><option value="健康异常">健康异常</option><option value="失联风险">失联风险</option><option value="设施报修">设施报修</option></select></label>
          <label><span>发生地点</span><span class="input-wrap"><i data-lucide="map-pin" aria-hidden="true"></i><input id="emergency-location" name="location" value="北海银龄康养中心" required><button class="icon-btn inline-icon" type="button" data-action="locate" aria-label="获取位置" title="获取位置">${icon("crosshair")}</button></span></label>
          <label class="full"><span>事情经过</span><textarea id="emergency-description" class="form-control" name="description" placeholder="可以直接说话，也可以简单写下发生了什么" required></textarea></label>
          <div class="full"><div class="filter-row"><button id="voice-btn" class="btn btn-secondary" type="button" data-action="record-voice">${icon("mic")}按住说话</button><label class="btn btn-secondary" style="cursor:pointer">${icon("paperclip")}添加照片/视频<input id="evidence-file" type="file" accept="image/*,video/*" hidden></label><span id="evidence-name" style="color:var(--muted);font-size:11px"></span></div></div>
          <div class="full notice">${icon("sparkles")}提交后生成结构化事件卡：系统只做信息整理和渠道建议，高风险事项仍需人工确认。</div>
        </form>
      `,
      footer: `<button class="btn btn-secondary" type="button" data-action="close-modal">取消</button><button class="btn btn-danger" type="submit" form="emergency-form">${icon("send")}提交求助</button>`,
      onOpen: () => {
        const form = document.getElementById("emergency-form");
        form.addEventListener("submit", submitEmergency);
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
    if (state.voiceRecorder) {
      state.voiceRecorder.stop();
      button.innerHTML = `${icon("mic")}按住说话`;
      refreshIcons();
      return;
    }
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) throw new Error("unavailable");
      state.voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      state.voiceRecorder = new MediaRecorder(state.voiceStream);
      state.voiceRecorder.onstop = () => {
        document.getElementById("emergency-description").value = "老人反馈：康复训练收费与公示价格不一致，已上传付款凭证，请协助核实并退回差额。";
        showToast("语音已转为文字", "已生成简短事件描述，可继续补充。", "success");
      };
      state.voiceRecorder.start();
      button.innerHTML = `${icon("square")}正在录音，点击结束`;
      refreshIcons();
      showToast("正在录音", "再次点击结束并转成文字。", "warning");
    } catch (error) {
      document.getElementById("emergency-description").value = "老人反馈：康复训练收费与公示价格不一致，已上传付款凭证，请协助核实并退回差额。";
      showToast("已使用演示语音", "真实部署时可接入语音识别服务。", "warning");
    }
  }

  function submitEmergency(event) {
    event.preventDefault();
    const formData = new FormData(event.target);
    const description = String(formData.get("description") || "").trim();
    const category = String(formData.get("category") || "服务投诉");
    const location = String(formData.get("location") || "北海银龄康养中心");
    const isDanger = category === "人身安全" || category === "失联风险";
    const eventItem = {
      id: `EV-20260810-${String(state.data.events.length + 18).padStart(3, "0")}`,
      residentId: state.data.profile.id,
      resident: state.data.profile.name,
      level: isDanger ? "high" : "medium",
      category,
      title: description.length > 23 ? `${description.slice(0, 23)}…` : description,
      source: "老人上报",
      location,
      time: "刚刚",
      status: "待复核",
      owner: isDanger ? "属地应急联络组" : category === "服务投诉" ? "北海市市场监管部门" : "北海银龄康养中心",
      deadline: isDanger ? "优先响应" : "2小时内反馈",
      summary: description || "老人通过求助入口提交了一条事件。",
      action: isDanger ? "请保持当前位置，优先联系紧急联系人并等待人工回拨。" : "责任单位将在时限内核验并反馈处理结果。",
      timeline: [{ time: "刚刚", text: "老人提交语音/文字事件", state: "done" }, { time: "刚刚", text: "系统生成结构化事件卡", state: "current" }]
    };
    state.data.events.unshift(eventItem);
    saveData();
    closeModal();
    showActionCard(eventItem);
    renderPage();
  }

  function showActionCard(eventItem) {
    const hotline = hotlineForEvent(eventItem);
    openModal({
      title: "事件卡已生成",
      subtitle: `${eventItem.id} · ${eventItem.status}`,
      body: `<div class="action-card ${eventItem.level === "high" ? "danger" : "warning"}"><h3>${escapeHtml(eventItem.title)}</h3><p>${escapeHtml(eventItem.action)}</p></div><div class="profile-grid" style="margin-top:16px"><div class="data-field"><span>责任渠道</span><strong>${escapeHtml(eventItem.owner)}</strong></div><div class="data-field"><span>建议电话</span><strong>${hotline}</strong></div><div class="data-field"><span>发生地点</span><strong>${escapeHtml(eventItem.location)}</strong></div><div class="data-field"><span>下一步</span><strong>等待人工确认并关注进度</strong></div></div>`,
      footer: `<button class="btn btn-secondary" type="button" data-action="close-modal">关闭</button><a class="btn btn-danger" href="tel:${hotline}">${icon("phone")}拨打 ${hotline}</a>`
    });
  }

  function getEvent(id) {
    return state.data.events.find((event) => event.id === id);
  }

  function openEventDetail(id) {
    const event = getEvent(id);
    if (!event) return;
    const canHandle = state.role !== "elder" && event.status !== "已办结";
    openModal({
      title: event.title,
      subtitle: `${event.id} · ${event.category} · ${event.time}`,
      wide: true,
      body: `
        <div class="panel-grid equal">
          <div>
            <div class="action-card ${event.level === "high" ? "danger" : event.level === "medium" ? "warning" : ""}"><h3>${riskTag(event.level)} ${escapeHtml(event.resident)}</h3><p>${escapeHtml(event.summary)}</p></div>
            <div class="profile-grid" style="margin-top:17px"><div class="data-field"><span>发生地点</span><strong>${escapeHtml(event.location)}</strong></div><div class="data-field"><span>来源</span><strong>${escapeHtml(event.source)}</strong></div><div class="data-field"><span>责任单位</span><strong>${escapeHtml(event.owner)}</strong></div><div class="data-field"><span>处置时限</span><strong>${escapeHtml(event.deadline)}</strong></div></div>
            <div class="notice" style="margin-top:17px">${icon("sparkles")}建议动作：${escapeHtml(event.action)}</div>
          </div>
          <div><h3 style="margin:0 0 14px;font-size:14px">处置时间线</h3><div class="timeline">${(event.timeline || []).map((item) => `<div class="timeline-item ${item.state}"><span class="timeline-dot"></span><div class="timeline-copy"><strong>${escapeHtml(item.text)}</strong><span>${escapeHtml(item.time)}</span></div></div>`).join("")}</div></div>
        </div>
      `,
      footer: `${canHandle ? `<button class="btn btn-primary" type="button" data-action="handle-event" data-id="${event.id}">${icon("check-check")}更新处置结果</button>` : ""}<button class="btn btn-secondary" type="button" data-action="close-modal">关闭</button>`
    });
  }

  function openHandleEvent(id) {
    const event = getEvent(id);
    if (!event) return;
    openModal({
      title: "更新处置结果",
      subtitle: `${event.id} · ${event.resident} · ${event.title}`,
      body: `<form id="event-handle-form" class="form-grid"><label><span>当前处置状态</span><select class="form-control" name="status"><option ${event.status === "待复核" ? "selected" : ""}>待复核</option><option ${event.status === "处置中" ? "selected" : ""}>处置中</option><option ${event.status === "已转派" ? "selected" : ""}>已转派</option><option>已办结</option></select></label><label><span>责任单位</span><select class="form-control" name="owner"><option>${escapeHtml(event.owner)}</option><option>北海银龄康养中心</option><option>北海市卫健部门</option><option>北海市市场监管部门</option><option>北海市公安联络组</option><option>12345政务服务便民热线</option></select></label><label class="full"><span>处置备注</span><textarea class="form-control" name="note" required placeholder="请记录已采取的动作、联系结果或下一步计划">${escapeHtml(event.status === "已办结" ? "已完成现场核验并回访老人。" : "已联系责任人，正在按流程核验。")}</textarea></label><div class="full notice">${icon("shield-check")}提交后会写入动态台账并更新机构质量统计。高风险事件办结需保留人工核验备注。</div></form>`,
      footer: `<button class="btn btn-secondary" type="button" data-action="close-modal">取消</button><button class="btn btn-primary" type="submit" form="event-handle-form">${icon("save")}保存处置</button>`,
      onOpen: () => document.getElementById("event-handle-form").addEventListener("submit", (formEvent) => submitEventHandling(formEvent, id))
    });
  }

  function submitEventHandling(formEvent, id) {
    formEvent.preventDefault();
    const event = getEvent(id);
    if (!event) return;
    const form = new FormData(formEvent.target);
    const previous = event.status;
    event.status = String(form.get("status"));
    event.owner = String(form.get("owner"));
    event.deadline = event.status === "已办结" ? "已按时完成" : "剩余 1小时"
    event.timeline = event.timeline || [];
    event.timeline.push({ time: "刚刚", text: String(form.get("note")), state: event.status === "已办结" ? "done" : "current" });
    saveData();
    closeModal();
    showToast(event.status === "已办结" ? "事件已办结" : "处置结果已更新", `${event.id} 已从${previous}更新为${event.status}`);
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
      body: `<div class="panel-grid equal"><div><div class="profile-grid"><div class="data-field"><span>年龄 / 来源</span><strong>${resident.age}岁 · ${escapeHtml(resident.source)}</strong></div><div class="data-field"><span>房间</span><strong>${escapeHtml(resident.room)}</strong></div><div class="data-field"><span>入住时间</span><strong>${escapeHtml(resident.checkIn)}</strong></div><div class="data-field"><span>数据新鲜度</span><strong>${escapeHtml(resident.fresh)}</strong></div></div><div class="notice" style="margin-top:17px">${icon("database")}档案字段来源可追溯，机构端仅展示当前照护所需字段。</div></div><div><h3 style="margin:0 0 12px;font-size:14px">当前风险</h3>${riskTag(resident.screening ? resident.screening.overall : resident.risk)}<p style="margin:10px 0 0;color:var(--muted);font-size:12px;line-height:1.7">综合入住状态、服务记录、本人打卡和事件变化生成。高风险与低置信度结果必须由工作人员确认。</p></div></div>${screeningSummary(resident.screening)}<section class="panel" style="margin-top:17px"><header class="panel-header"><div><h3>近期服务与事件</h3><p>最近三条台账记录</p></div></header><div class="panel-body"><div class="list-stack">${service.map((item) => `<div class="list-item"><span class="list-icon">${icon("clipboard-list")}</span><div class="list-content"><strong>${escapeHtml(item.type)} · ${escapeHtml(item.result)}</strong><p>${escapeHtml(item.staff)} · ${escapeHtml(item.time)}</p></div></div>`).join("")}${events.map((item) => `<div class="list-item"><span class="list-icon ${item.level === "high" ? "danger" : "warning"}">${icon("siren")}</span><div class="list-content"><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.time)} · ${escapeHtml(item.status)}</p></div></div>`).join("")}</div></div></section>`,
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
      body: `<div class="review-banner ${screening.overall === "high" ? "danger" : "warning"}"><div><span class="eyebrow">系统建议</span><h3>${riskLabel(screening.overall)} · 置信度 ${Math.round(screening.confidence * 100)}%</h3><p>本结果由可观察项和规则引擎生成，不是医学诊断。</p></div>${screeningStatusTag(screening)}</div><div class="review-evidence-grid">${screening.dimensions.map((dimension) => `<article class="evidence-item"><div class="evidence-item-head"><strong>${escapeHtml(dimension.label)}</strong><span class="status-tag ${dimension.level === "high" ? "danger" : dimension.level === "medium" ? "warning" : dimension.level === "unknown" ? "neutral" : "success"}">${escapeHtml(dimension.value)}</span></div><p>${icon("quote")}证据：${escapeHtml(dimension.evidence)}</p><small>来源：${escapeHtml(screening.source)}</small></article>`).join("")}</div>${screening.missing && screening.missing.length ? `<div class="notice warning" style="margin-top:16px">${icon("triangle-alert")}缺项：${screening.missing.map(escapeHtml).join("、")}。缺项未补齐前，系统不会自动升级或判为稳定。</div>` : ""}<label class="full review-note-field"><span>人工复核备注</span><textarea id="screening-review-note" class="form-control" placeholder="记录现场观察、补录结果或冲突说明">${screening.reviewStatus === "已确认" ? "已完成现场观察，与系统建议一致。" : "已核对原始记录，建议按系统提示安排回访。"}</textarea></label>`,
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
    saveData();
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
    openModal({
      title: "新增外出与行程报备",
      subtitle: "离开机构前必须明确去向、返回计划和机构责任人",
      wide: true,
      body: `<form id="movement-report-form" class="form-grid"><label><span>旅居老人</span><select class="form-control" name="residentId" required>${availableResidents.map((resident) => `<option value="${resident.id}">${escapeHtml(resident.name)} · ${escapeHtml(resident.room)}</option>`).join("")}</select><small>已有进行中外出记录的老人需先完成返回核验</small></label><label><span>动向类型</span><select class="form-control" name="type" required><option>临时外出</option><option>集体活动</option><option>外出就医</option><option>康复活动</option><option>探亲访友</option><option>跨市行程</option><option>离住返程</option></select></label><label class="full"><span>目的地</span><input class="form-control" name="destination" placeholder="例如：北海银滩景区东门 / 北海站→南宁东站" required></label><label class="full"><span>外出事由</span><textarea class="form-control" name="reason" placeholder="说明外出目的、活动安排或就医需求" required></textarea></label><label><span>出发时间</span><input class="form-control" name="departAt" value="今日 ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}" required></label><label><span>预计返回</span><input class="form-control" name="expectedReturn" placeholder="例如：今日 18:00 / 计划离住不返回" required></label><label><span>机构责任人</span><input class="form-control" name="responsible" value="工作人员 周敏" placeholder="姓名与岗位" required></label><label><span>责任人联系电话</span><input class="form-control" name="responsiblePhone" placeholder="用于异常情况快速联络" required></label><label><span>陪同方式</span><input class="form-control" name="companion" placeholder="本人外出 / 家属接送 / 机构陪同" required></label><label><span>初始关注等级</span><select class="form-control" name="risk"><option value="low">常规</option><option value="medium">需关注</option><option value="high">高风险</option></select></label><div class="full notice">${icon("shield-check")}提交后同步进入监管端待确认队列。监管确认只核验报备与责任链，机构仍承担现场跟进和按时返回核验责任。</div></form>`,
      footer: `<button class="btn btn-secondary" type="button" data-action="close-modal">取消</button><button class="btn btn-primary" type="submit" form="movement-report-form">${icon("send")}提交报备</button>`,
      onOpen: () => document.getElementById("movement-report-form").addEventListener("submit", submitMovementReport)
    });
  }

  function submitMovementReport(formEvent) {
    formEvent.preventDefault();
    const form = new FormData(formEvent.target);
    const resident = state.data.residents.find((item) => item.id === form.get("residentId"));
    if (!resident) return;
    const id = `MV-${String(Date.now()).slice(-8)}`;
    const log = {
      id,
      residentId: resident.id,
      resident: resident.name,
      type: String(form.get("type")),
      status: String(form.get("departAt")).includes("明日") ? "待出发" : String(form.get("type")) === "外出就医" ? "就医中" : "外出中",
      risk: String(form.get("risk")),
      destination: String(form.get("destination")),
      reason: String(form.get("reason")),
      departAt: String(form.get("departAt")),
      expectedReturn: String(form.get("expectedReturn")),
      actualReturn: "--",
      responsible: String(form.get("responsible")),
      responsiblePhone: String(form.get("responsiblePhone")),
      companion: String(form.get("companion")),
      source: "机构外出报备",
      institutionStatus: "已核验",
      regulatorStatus: "待确认",
      confirmedBy: "--",
      confirmedAt: "--",
      eventId: "",
      timeline: [{ time: "刚刚", text: "机构核验去向、责任人与返回计划", state: "done" }, { time: "刚刚", text: "已推送监管端确认", state: "current" }]
    };
    state.data.movementLogs.unshift(log);
    resident.fresh = "刚刚";
    state.data.notifications.unshift({ id: Date.now(), title: "新动向待监管确认", detail: `${resident.name}前往${log.destination}，责任人${log.responsible}`, time: "刚刚", level: "warning", read: false });
    saveData();
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
      body: `<div class="movement-detail-head ${log.status === "超时未归" ? "danger" : ""}"><div><span class="eyebrow">当前动向</span><h3>${escapeHtml(log.destination)}</h3><p>${escapeHtml(log.reason)}</p></div>${statusTag(log.status)}</div><div class="profile-grid" style="margin-top:17px"><div class="data-field"><span>出发 / 预计返回</span><strong>${escapeHtml(log.departAt)} / ${escapeHtml(log.expectedReturn)}</strong></div><div class="data-field"><span>实际返回</span><strong>${escapeHtml(log.actualReturn)}</strong></div><div class="data-field"><span>机构责任人</span><strong>${escapeHtml(log.responsible)} · ${escapeHtml(log.responsiblePhone)}</strong></div><div class="data-field"><span>陪同与交接</span><strong>${escapeHtml(log.companion)}</strong></div><div class="data-field"><span>机构核验</span><strong>${escapeHtml(log.institutionStatus)}</strong></div><div class="data-field"><span>监管确认</span><strong>${escapeHtml(log.regulatorStatus)} · ${escapeHtml(log.confirmedBy || "--")}</strong></div></div><section class="movement-timeline"><h3>动向时间线</h3><div class="timeline">${(log.timeline || []).map((item) => `<div class="timeline-item ${item.state}"><span class="timeline-dot"></span><div class="timeline-copy"><strong>${escapeHtml(item.text)}</strong><span>${escapeHtml(item.time)}</span></div></div>`).join("")}</div></section>`,
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
    saveData();
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
        linkedEvent.deadline = "等待监管复核";
        linkedEvent.timeline = linkedEvent.timeline || [];
        linkedEvent.timeline.push({ time: "刚刚", text: "机构确认老人已安全返回，等待监管复核", state: "current" });
      }
    }
    saveData();
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
    state.data.serviceLogs.unshift({ id: `SV-0810-${String(state.data.serviceLogs.length + 32).padStart(3, "0")}`, residentId: resident.id, resident: resident.name, type: String(form.get("type")), staff: String(form.get("staff")), time: String(form.get("time")), result: String(form.get("result")), status: "已记录" });
    resident.fresh = "刚刚";
    saveData();
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
    const id = `GX-LJ-2026-${String(319 + state.data.residents.length).padStart(6, "0")}`;
    state.data.residents.unshift({ id, name, age: Number(form.get("age")), source: String(form.get("source")), room: String(form.get("room")), checkIn: "今日", risk: "low", fresh: "刚刚", status: "在住" });
    saveData();
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
      onOpen: () => document.getElementById("profile-form").addEventListener("submit", (formEvent) => { formEvent.preventDefault(); const form = new FormData(formEvent.target); p.phone = String(form.get("phone")); p.emergencyName = String(form.get("emergencyName")); p.emergencyPhone = String(form.get("emergencyPhone")); p.lastCheck = "刚刚"; saveData(); closeModal(); showToast("资料已更新", "紧急联络信息已写入档案。"); renderPage(); })
    });
  }

  function openInstitutionDetail(id) {
    const institution = state.data.institutions.find((item) => item.id === id);
    if (!institution) return;
    openModal({
      title: institution.name,
      subtitle: `${institution.city} · ${institution.id}`,
      body: `<div class="stat-grid" style="grid-template-columns:repeat(2,1fr)">${statCard("质量评分", institution.score, "分", "medal", "综合服务表现", "positive")}${statCard("事件闭环率", institution.closure, "%", "circle-check", "近30日", institution.closure >= 93 ? "positive" : "warning")}${statCard("平均响应", institution.response, "", "timer", "目标≤30分钟", "positive")}${statCard("待处理预警", institution.alerts, "条", "siren", institution.alerts > 3 ? "建议督办" : "正常", institution.alerts > 3 ? "warning" : "positive")}</div><div class="notice">${icon("info")}评分由服务记录新鲜度、预警响应、投诉闭环和老人回访综合计算，支持按机构和时间段追溯。</div>`,
      footer: `<button class="btn btn-secondary" type="button" data-action="close-modal">关闭</button>`
    });
  }

  function openNotifications() {
    const unread = state.data.notifications.filter((item) => !item.read);
    openModal({
      title: "通知中心",
      subtitle: unread.length ? `${unread.length}条未读通知` : "暂无未读通知",
      body: `<div class="list-stack">${state.data.notifications.map((item) => `<div class="list-item"><span class="list-icon ${item.level === "danger" ? "danger" : item.level === "warning" ? "warning" : ""}">${icon(item.level === "danger" ? "siren" : item.level === "warning" ? "file-warning" : "info")}</span><div class="list-content"><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.detail)}</p></div><span class="list-side">${escapeHtml(item.time)}</span></div>`).join("")}</div>`,
      footer: `<button class="btn btn-primary" type="button" data-action="read-notifications">${icon("check-check")}全部标记已读</button><button class="btn btn-secondary" type="button" data-action="close-modal">关闭</button>`
    });
  }

  function openProfileMenu() {
    const account = state.data.accounts[state.role];
    openModal({
      title: account.name,
      subtitle: account.org,
      body: `<div class="profile-grid"><div class="data-field"><span>当前角色</span><strong>${roleMeta[state.role].label}</strong></div><div class="data-field"><span>数据环境</span><strong>本地演示数据</strong></div><div class="data-field"><span>最近登录</span><strong>今日 08:30</strong></div><div class="data-field"><span>权限范围</span><strong>${state.role === "elder" ? "本人档案与求助记录" : state.role === "provider" ? "本机构老人、服务及动向记录" : "全区监测、动向确认与事件督办"}</strong></div></div><div class="notice" style="margin-top:17px">${icon("database")}当前数据保存在浏览器本地，便于现场演示。退出后数据不会丢失。</div>`,
      footer: `<button class="btn btn-secondary" type="button" data-action="reset-demo">${icon("rotate-ccw")}恢复初始数据</button><button class="btn btn-primary" type="button" data-action="close-modal">关闭</button>`
    });
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
  loginForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const account = state.data.accounts[state.selectedRole];
    if (loginAccount.value.trim() !== account.account || loginPassword.value !== account.password) {
      loginError.textContent = "账号或密码不正确，请使用页面下方的演示账号。";
      loginError.hidden = false;
      return;
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
    if (action === "ai-video") openAiVideoAssistant();
    if (action === "toggle-ai-camera") toggleAiCamera();
    if (action === "start-ai-speech") startAiSpeech();
    if (action === "create-event-from-ai") createEventFromAi();
    if (action === "health-scan") openHealthScan();
    if (action === "screening-check") openScreeningCheck();
    if (action === "screening-review") openScreeningReview(actionButton.dataset.id);
    if (action === "confirm-screening") confirmScreening(actionButton.dataset.id);
    if (action === "enable-camera") enableCamera();
    if (action === "start-scan") startHealthScan();
    if (action === "emergency-report") openEmergencyReport();
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
    if (action === "refresh-data") { state.data = loadData(); renderPage(); showToast("数据已刷新", "当前台账已重新载入。"); }
    if (action === "export-report") exportReport();
    if (action === "export-movements") exportMovements();
    if (action === "read-notifications") { state.data.notifications.forEach((item) => { item.read = true; }); saveData(); closeModal(); document.getElementById("notification-count").textContent = "0"; showToast("通知已全部标记为已读"); }
    if (action === "reset-demo") { state.data = cloneSeed(); saveData(); closeModal(); renderShell(); showToast("演示数据已恢复", "所有角色将重新看到初始数据。", "warning"); }
  });

  document.addEventListener("change", (event) => {
    const consent = event.target.closest("[data-consent]");
    if (!consent) return;
    state.data.profile.consents[consent.dataset.consent] = consent.checked;
    saveData();
    showToast(consent.checked ? "授权已开启" : "授权已撤回", "后续数据使用范围会按授权状态更新。");
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

  const session = sessionStorage.getItem(SESSION_KEY);
  if (session && roleMeta[session]) {
    state.role = session;
    loginView.hidden = true;
    appView.hidden = false;
    renderShell();
  } else {
    setSelectedRole("elder");
    refreshIcons();
  }
})();
