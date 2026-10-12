# 接手说明（最新：16.0 评阅整改，2026-10-08）

> 16.0 按模拟评阅报告修复 5 个 P0 问题和 10 处页面问题，接手时先看第 15 节。交付包请用 `python scripts/package_release.py` 生成，目录名为 `桂养安心_源码16.0`。下文第 1～14 节为 14.0～15.4 的历史记录（15.5 的改动见 `README.md`）。

# 14.0 完成记录与接手说明

> 2026-09-25 完成 14.0 升级。源码目录按仓库约定命名为 `桂养安心_源码14.0`；下文第 4～6 节保留原始需求及验收依据。上一级 `myproject-main/HANDOFF.md` 是更早的 12.0 说明，本文件以后为准。
> 本机这份代码仍是下载的压缩包，**不是 Git 仓库**，因此没有在本机推送或创建 PR。

本轮三件事均已完成，界面沿用原有布局与排版：

1. **对话反诈加“证据链”**（第 4 节）
2. **AI 回答朗读**（第 5 节）
3. **台风 / 高温预警 + 一键报平安**（第 6 节）

**验证结果**：Python 测试 66/66；原有六组 Chromium 浏览器回归 82/82；新增三端联调通过。真实 DeepSeek 108 次用例调用全通过，主动预警 3/3 通过，类案雷达未调优样本准确率和召回率均为 1.0。详细操作及限制见 `README.md` 的 14.0 节，真实调用完整报告另附。测试使用合成种子与临时数据库，未读写原有演示数据库。

**交付注意**：源码包不含 `deepseek.env.local` 或 `runtime/`。本机目录保留原有密钥和演示数据库。密钥先前出现在聊天记录中，赛前应换发并让旧密钥失效。

---

## 1. 项目背景（必读）

- **作品**：桂养安心·旅居智管，广西“银发智享”AI 赋能旅居康养服务创新大赛（**监管赛道**）决赛作品，决赛日期 2026-10-24。
- **三个角色**：
  - 老人端：账号 `elder`；
  - 服务机构端：账号 `center`；
  - 监管端：账号 `admin`。
  - 本地密码默认都是 `123456`（首次启动写入与数据库同目录的 `demo_credentials.json`）。
- **核心定位**：“AI 对话决策 + 证据链 + 旅居特色 + 监管闭环”。AI 就是 DeepSeek（`deepseek-chat`，OpenAI 兼容接口）。
- **小组已定的原则**（不要违背）：
  - **不再加新场景**。不接外部服务器，比如老师团队的摄像头平台；安全类新场景优先级靠后。
  - 决赛重点是 PPT 和演示，所以功能要稳、要好演示，**宁可少做也不能现场出错**。
  - 急症安全分流先于大模型，AI 只做辅助判断，**关键动作都要老人或工作人员点确认**。
  - 不直接认定诈骗，只说“符合常见骗局特征”。
  - 隐私：监管端看聚合数据为主，给老人的推送不含个人信息。

## 2. 密钥与安全（必须遵守）

- 密钥在本目录的 `deepseek.env.local` 里，只有一行 `DEEPSEEK_API_KEY=...`，2026-09-25 已换成新密钥，并已验证可以调用。
- **绝不打印、提交、复制密钥内容**。检查时只看“有没有这个字段”。服务会自动读取；在 `http://127.0.0.1:4173/api/status` 看到 `"configured": true` 就说明读到了。
- 提交信息、PR、代码注释里不要写模型名。

## 3. 运行与测试

**Windows 注意事项：**
- 命令行里先 `set PYTHONIOENCODING=utf-8`（Git Bash 用 `export`），否则中文输出会报 `UnicodeEncodeError`。
- 用 bash 的 heredoc 往文件里写 Python 代码时，`\n`、`\s` 等反斜杠可能被转义成真换行，导致语法错误。改代码请直接编辑文件，不要用 heredoc 拼代码。

**启动：**
```
python server.py                      # 默认 http://127.0.0.1:4173/ ，端口被占用会顺延
```
- 开发和测试时**不要动用户的演示数据库** `runtime/guiyang_elders.db`，请用临时库：
```
set GUIYANG_DB_PATH=%TEMP%\gy_dev\dev.db
python server.py --port 4190
```
- 数据版本：`data.js` 顶部的 `version`（当前 **11**，16.0 起另有 `anchorDate`，见第 15 节）。改了演示数据，先改 `data.js`，再运行 `node scripts/export_seed.mjs` 生成 `seed.json`，并把 `version` +1。旧数据库启动时会自动升级，也就是**重置为新种子**。15.3 起，重置前会自动把旧库完整备份到 `runtime/backups/guiyang_elders_before_v版本号_时间.sqlite`；14.0 升级前的库在 `runtime/backups/guiyang_elders_before14.sqlite`。

**测试**（全部通过才算完成）：
```
node --check app.js
python -m py_compile server.py database.py route_risk.py agent.py case_radar.py advisor.py care.py insight.py weather.py sla.py watchdog.py
python scripts/lint_field_names.py
python -m unittest discover -s scripts -p test_security_routes.py
python scripts/test_agent.py
python scripts/test_case_radar.py
python scripts/test_advisor.py
python scripts/test_care.py
python scripts/test_weather.py
python scripts/test_review_fixes.py
node scripts/test_triage.mjs
python scripts/lint_launchers.py
```
- **真实 DeepSeek 测试**：`python scripts/deepseek_eval.py`（约 3.5 分钟、108 次调用），结果写到 `测试结果/`。
  - 最近一次（15.3，210 次调用，约 5.5 分钟）：演示用句 12/12、自由说法 48/48、情景 84/84、闲聊 9/9、多轮 12/12、安全红线 6/6、监管参谋 39/39、主动预警 3/3。
  - 改了提示词或智能体逻辑后必须重跑，通过率不能下降。
  - `--only F15,F16` 只跑指定用例。F15（99 元越南芒街团）最容易波动，改动反诈、出行规则后要重点看。
- **浏览器端到端脚本** `scripts/e2e_*.py`，共 9 组（16.0 新增 `e2e_review_fixes.py`，其中一项要等约 35 秒验证后台值守），需要 Python Playwright。本机已安装，首次安装方法：`pip install playwright` 后运行 `python -m playwright install chromium`。
  - 脚本开头会**把数据库重置为种子数据**，所以服务和脚本都要指向同一个临时库：
```
set GUIYANG_DB_PATH=%TEMP%\gy_dev\dev.db
set GY_BASE=http://127.0.0.1:4190/
python server.py --port 4190        （另开一个窗口）
python scripts\e2e_sos_full_loop.py
```
  - 15.1 结果：6 组呼救 82/82，`e2e_ai_dialog` 16/16，`e2e_smoke_pages` 270/270。

## 3.5 文件地图（本轮相关）

| 文件 | 作用 |
| --- | --- |
| `server.py` | HTTP 服务、登录鉴权、`public_state`（按角色裁剪数据：老人只看本人，机构只看本机构）、`merge_authorized`（按角色和对象类型合并写入）、各 API |
| `database.py` | SQLite。`app_snapshot` 存整份状态；`sos_sessions`、`audit_logs` 等是规范化表 |
| `agent.py` | 老人端守护智能体：工具调用循环 `run_model_agent`，规则兜底 `enforce_policy`，无密钥时走 `run_rule_agent` |
| `care.py` | AI 主动预警，给每位老人列风险信号（带证据编号） |
| `case_radar.py` | 类案雷达 |
| `advisor.py` | 监管参谋（只读工具） |
| `insight.py` | 运行态势研判与服务质量评价 |
| `app.js` | 全部前端，原生 JS。页面渲染函数 `render*`，全局点击分发在文件末尾 `document.addEventListener("click", …)` 里按 `data-action` 处理 |
| `styles.css` / `tokens.css` | 样式，颜色一律用 `tokens.css` 里的变量 |
| `data.js` / `seed.json` | 演示数据 |

**关键前端函数**（行号为 13.0 时的大致位置）：
- `renderAiResult`（约 2541 行）：渲染老人端建议卡和智能体执行过程；
- `confirmAgentAction`（约 2585 行）：老人点“确认提交”，生成工单或报备；
- `openEventDetail`（约 3777 行）：事件详情弹窗；
- `startSosSession` / `progressSosSessions`：呼救工单和分级升级；
- `renderElderDashboard`（约 790 行）：老人端首页；
- `renderRegulatorDashboard`：监管总览；
- `saveData(action, entityType, entityId)`：写回服务器。`entityType` 必须在 `server.py` 的 `ALLOWED_WRITES` 里。

---

## 4. 任务一：对话反诈加“证据链”

**为什么做**：组员和老师讨论时指出，只让机构端看到“可能被诈骗”，没有依据，会被质疑是 AI 幻觉。每条由对话产生的涉诈工单，都要能追溯到**老人原话 → AI 查证了什么 → 老人何时确认**。信息来源是“老人和陪伴 AI 闲聊或求证时主动透露”，**不涉及监听通话**。

**现状**：`confirmAgentAction` 生成工单时只写了 `title`、`summary` 等字段，没有保存对话原话和执行轨迹。`state.lastAgentRun` 里有 `trace`（每一步的 `kind`、`title`、`detail`、`tool`）和 `actions`；`state.aiHistory` 里有最近几轮对话。

**要做的：**

1. **生成证据链（前端，`confirmAgentAction` 的 ticket 分支）**：给事件加一个 `evidence` 对象，例如：
   ```js
   evidence: {
     source: "老人对话主动透露",        // 或 老人上报（演示数据）/ 家属代报 / 机构代录
     quotes: [{ time: "09-25 14:02", text: "有个养生基地让我今天交一万块定金" }],  // 最近 3 句老人原话，每句 ≤ 80 字
     checks: [{ tool: "check_institution", label: "核查机构登记", result: "…" }],   // 来自 trace 里 kind === "tool" 的步骤，≤ 6 条
     rules: ["规则补全：…"],             // trace 里 title 为“规则补全”“规则校正意图”的 detail
     movement: "MV-0810-020 · 明日 南宁",   // 老人当前或待出发的动向（getMovementLogs 中本人的有效记录），没有就空
     matchedAlert: "BC-…",               // 命中已推送防骗提醒时
     provider: "DeepSeek 智能体",         // 或 本地规则智能体
     confirmedAt: "09-25 14:03"
   }
   ```
   `createEventFromAi`（手动“生成求助事件”）也要带上同样结构的证据链。

2. **服务端校验（`server.py`）**：老人新建 `risk_event` 时，`evidence` 只保留上面这些字段，并限制长度和条数（参考 `broadcast` 分支的做法），防止前端塞入任意内容。机构端和监管端同样只能写这些字段。

3. **展示**：
   - `openEventDetail`：新增“证据链”区块，按时间线显示“老人原话 → AI 查证 → 规则补全 → 老人确认”。没有 `evidence` 的旧事件显示“来源：老人上报（无对话记录）”。
   - 类案雷达的个案列表（`radarGraph` 附近的“归并的个案”）：每个个案旁加“查看证据链”，打开同一个详情弹窗。
   - 监管参谋 `advisor.py` 的 `tool_query_events`：每条结果加一个 `证据来源` 字段，比如“老人对话原话 1 句 + 查证 3 项”，**不要把原话全文交给模型**。

4. **演示数据**：给巴马类案的 3 条事件（`EV-20260809-103`、`EV-20260809-117`、`EV-20260810-024`）和冒充亲属的 2 条（`EV-20260810-031`、`EV-20260809-126`）补上合成的 `evidence`，`source` 写“老人对话主动透露（演示数据）”。原话要与 `summary` 一致，不能编出新的事实。然后 `version` 改为 8，并重新导出 `seed.json`。

5. **测试**：
   - `scripts/test_security_routes.py` 加一个用例：老人提交带超长或多余字段 `evidence` 的事件后，服务器只保留白名单字段。
   - 手工验证：老人端说“有个养生基地让我今天交一万块定金”，点“确认提交”；再到机构端和监管端打开该事件，能看到完整的证据链。

**验收**：
- 由对话生成的涉诈工单 100% 带证据链；
- 监管端、机构端能看到证据链，老人端的推送里没有其他老人的信息；
- 全部测试通过，DeepSeek 测试通过率不下降。

---

## 5. 任务二：AI 回答朗读

**为什么做**：很多老人看字费劲。目前完全没有朗读功能：`app.js` 里没有 `speechSynthesis`，只有语音输入。

**要做的：**

1. 用浏览器自带的 `window.speechSynthesis` 和 `SpeechSynthesisUtterance`，`lang = "zh-CN"`，`rate ≈ 0.85`。**不接外部语音服务**。
2. **朗读内容**：建议卡的 `summary` 加上“现在先做”三条加上联系电话。
   - 电话号码逐字读，例如 `110` 读成“幺幺零”，`12315` 读成“幺二三幺五”；
   - 带 `*` 的脱敏号码读作“机构值班电话”；
   - 不读证据编号（EV-、MV- 等）。
3. **触发方式**：
   - 老人端 AI 助手里，建议卡渲染完成后自动朗读，也就是 `renderAiResult` 的 `animate` 结束后；
   - 卡片上加“朗读 / 停止”大按钮，高度 ≥ 48px；
   - 老人端首页设置“自动朗读”开关，存在 `localStorage`（读写要包在 try/catch 里）。
4. **边界情况**：
   - 关闭弹窗（`closeModal`）、发送新消息、退出登录时调用 `speechSynthesis.cancel()`；
   - 浏览器没有中文语音或不支持时，隐藏按钮，不报错；
   - 急症安全分流的结果也要朗读，而且优先读“请立即拨打120”。
5. 任务三的台风提醒横幅也复用这个朗读函数，把它写成独立函数，比如 `speakForElder(text)`。

**验收**：在 Edge 或 Chrome 里，老人端问一句话，建议卡出来后自动读出，点“停止”立即停；关掉自动朗读后不再自动读；不支持语音的浏览器没有报错。

---

## 6. 任务三：台风 / 高温预警 + 一键报平安

**为什么做**：对应赛道的“突发事件联动调度”和“人群动态监测”。广西沿海（北海、防城港）是旅居老人最集中的地方，台风和高温是真实风险。**要复用现有的呼救工单、外出动向、机构值班体系，不另起炉灶。**

**数据**：`state` 里新增：
```js
weatherAlerts: [{ id: "WA-…", type: "台风" | "高温", level: "蓝色" | "黄色" | "橙色" | "红色",
                  cities: ["北海", "防城港"], title, advice, issuedAt, issuedBy,
                  source: "模拟预警（演示）", status: "生效中" | "已解除", deadlineMinutes: 30 }]
safetyCheckins: [{ id: "CK-…", alertId, residentId, resident, status: "safe" | "help" | "pending",
                   at, by: "本人" | "机构代报", note }]
```

**天气来源**：
- **默认是“模拟预警”**：监管端点“发布预警”，选择类型、等级、城市，演示和测试都用它，保证离线可用。
- 可以预留一个真实天气接口开关（环境变量，例如 `WEATHER_API_KEY`），**默认关闭**。没有密钥时绝不联网。界面上始终标明数据来源。

**流程：**

1. **监管端**：监管总览或新增的“应急调度”区块里有“发布预警”按钮。
   - 发布后，服务端算出受影响的老人：所属机构城市或居家地址在预警城市内，或者正有外出、跨市行程去往这些城市。
   - 排序优先级：正在外出 > 独居 > 快筛高风险 > 其他。
   - 新增 API：`POST /api/weather-alert`（仅监管端），`POST /api/checkin`（老人本人，或机构代报）。写入时照 `merge_authorized` 的方式做角色校验和字段白名单，并写审计日志。
2. **老人端**：首页顶部出现大横幅，比如“台风蓝色预警：今晚北海有大风，请留在室内”，下面两个大按钮“我很安全”“我需要帮助”。
   - 横幅自动朗读（复用任务二）；
   - 点“需要帮助”直接调用现有的 `startSosSession`，触发方式写“台风预警·报平安求助”；
   - 正在外出的老人，横幅里额外提示“请尽快返回，或告诉我们你在哪里”。
3. **机构端**：出现“报平安任务”列表：受影响老人、是否已回应、截止时间。
   - 工作人员可以点“已电话确认安全”代为报平安，记为 `by: "机构代报"`；
   - 超过截止时间（演示可设 2 分钟）仍未回应的，自动标红，并按现有升级逻辑通知机构负责人。
4. **监管端**：看到报平安率、未回应名单、求助数，未回应的可以一键督办。
5. **AI 部分**（可选，要有兜底）：
   - DeepSeek 按人群生成分组提醒文案，比如外出中、独居、高血压老人各一段。**只能使用预警里给出的信息，不得编造风速、降雨等气象数据**；
   - 模型不可用时用固定模板；
   - AI 主动预警 `care.py` 新增信号“预警期间未报平安”；
   - 态势研判 `insight.py` 新增“报平安率”；
   - 监管参谋新增只读工具“查询预警与报平安”。
6. **隐私**：给老人的横幅不含其他老人的信息；机构端只看本机构老人，照 `public_state` 的机构范围过滤。

**演示数据**：默认**不带**生效中的预警，现场演示时由监管端发布。数据版本照第 3 节的规则递增。

**测试**：
- `test_security_routes.py`：只有监管端能发布预警；老人只能给自己报平安；机构只能代报本机构老人。
- 受影响老人的计算要加单元测试，覆盖外出去往预警城市、居家、非预警城市等情况。
- “需要帮助”生成的呼救工单要进入现有的升级流程。
- 手工三端联调：监管发布 → 老人横幅加朗读 → 一位点“安全”、一位点“需要帮助”、一位不回应 → 机构端和监管端数字正确。

**验收**：三端联调全流程能走通，断网也能演示（模拟预警），全部测试通过。

---

## 7. 完成后

1. 在 `README.md` 里加“14.0”一节，照 13.0 的写法，用大白话说明做了什么、怎么测。
2. 跑一遍第 3 节的全部测试和 DeepSeek 测试，把通过率写进 README。
3. **目录改名**：已按仓库约定更新为 `桂养安心_源码14.0`，并更新上一级 `CLAUDE.md`。
4. 本机不是 Git 仓库：本轮没有推送或开 PR。日后需要同步到 GitHub 时，先确认使用哪个仓库。

## 8. 已知的坑

- **机构端数据范围**：`public_state` 里 `provider` 会过滤掉其他机构的老人和事件。新增的数据类型（如 `safetyCheckins`）也要照样过滤。
- **`merge_authorized` 只接受 `ALLOWED_WRITES` 里的类型**，新写入类型要先加进去，再按字段白名单处理。
- **AI 主动预警**：老人一多，模型输出可能被截断。`care.py` 已经把 `max_tokens` 调大，并能保留被截断前已写完整的条目；新增信号时注意不要让输出过长。
- **截图注意**：界面有逐步出现的动画，截图要等动画结束。建议卡出现“联系电话”再等 10 秒以上。
- **测试数据要隔离**：跑测试和演示前后，不要改动用户正式的 `runtime/` 数据库。

## 9. 复查修复（2026-09-25，14.0 验收后）

均在 `app.js` 中修改，离线测试全部通过，并在浏览器中逐项验证：

1. **朗读号码**：脱敏值班电话（如 `0779-3882***`）整体读作“机构值班电话”，不再读成“零七七九 杠 …”。连续的句号等重复标点会合并。
2. **报平安后不重复朗读**：预警横幅只在本人状态为“待回应”时自动朗读，报过平安后刷新页面不会再读。
3. **证据链里的动向**：只有待出发、跨市或出境行程，或者老人原话里提到了目的地，才标为“计划行程”；其余标为“当前所在（参考）”，不作为涉诈证据。
4. **横幅位置**：预警生效且本人未报平安时，报平安横幅放在“一键呼救”上方；报平安后回到原来位置。

- 上一级的 `桂养安心_源码12.0` 目录联接已删除，`CLAUDE.md` 已同步更新。

## 10. 界面精修与演示功能（15.0，2026-09-27）

详见 `README.md` 的 15.0 节，只改了前端 `app.js`、`styles.css`、`index.html` 和 `assets/login-map.svg`。接手时注意：

- **新的共用组件**：
  - `todoPanel(items)`：机构端、监管端首页的“今天要处理的事”；
  - `agentTraceMarkup(run, collapsed)`：查证过程，完成后自动收起，老人端和监管参谋共用；
  - `openDemoGuide()`：演示指引，步骤写在 `DEMO_STEPS` 里；
  - `exportClusterEvidence` / `exportEventEvidence`：证据材料导出。
- **新样式**：统一放在 `styles.css` 末尾的“15.0”各节里。统计卡已去掉图标，`statCard` 的图标参数保留但不再显示。
- **呼救面板**：机构端呼救面板（`.sos-queue-panel`）在空闲时排在待办清单之后，有进行中的呼救时自动顶到最上面。浏览器端到端脚本依赖的类名（`.sos-band`、`.sos-big-btn`、`.sos-live-banner`、`.sos-queue-item` 等）都没有改。
- **截图检查**：用无头 Edge 逐页截图时，弹窗有淡入动画，截图前要等动画结束，或临时关闭弹窗层的动画。
- **目录版本号**：仓库约定大升级要把目录改名为下一个版本号（本轮应为 15.0）。改名会让当前会话和其他工具的路径失效，是否改名由用户决定。

## 11. 小桂对话改为聊天式（15.1，2026-09-27）

详见 `README.md` 的 15.1 节。接手时注意：

- **闲聊判断在两处**：
  - 页面 `app.js` 的 `SMALL_TALK` / `smallTalkKind`，用于即时回复；
  - 服务端 `agent.py` 的 `SMALL_TALK` / `small_talk_kind`，供接口和测试脚本使用。
  - 两处词表要一起改，只有整句都是寒暄词时才算闲聊。
- **返回字段 `mode`**：`chat` 只回一句话，`card` 出建议卡，在 `finalize_card` 里决定。页面另外把本地规则的 `needs_clarification` 也当作 `chat` 处理。急症（`urgent`）永远出卡。
- **建议卡**：`#ai-result-area` 不再写在弹窗模板里，由 `renderAiResult` 插到对话记录末尾，也就是紧跟在对应气泡后面；新问题出卡前会删掉旧卡。闲聊回复不改 `state.lastAiResult`，旧卡上的按钮仍然对应上一件事。
- **朗读**：所有朗读按钮都是 `[data-action="ai-speak"]`，念的内容来自所在气泡的 `data-speech`。`speakForElder(text, force, button)` 负责把按钮切换成“停止”，被打断的上一段不会误把按钮改回来。
- **测试新增**：`e2e_ai_dialog.py`、`e2e_smoke_pages.py` 已加入 `run_all_tests.sh`。改首页或对话框后，至少跑这两个再加 `e2e_sos_full_loop.py`。

## 12. 逐项实测与修补（15.2，2026-09-27）

详见 `README.md` 的 15.2 节。接手时注意：

- **监管参谋新增的工具**：
  - `query_residents`：按条件查老人，只返回概况；
  - `get_record`：按编号查一条记录。
  - 老人档案号 `GX-…` 也算证据，由 `advisor.EVIDENCE_RE` 核对。给老人看的文字仍按 `agent.ID_PATTERN` 去掉编号。
  - `WRITE_RE` 识别修改台账的要求，`DRAFT_RE` 识别起草文书的要求。起草时返回 `draft` 字段，页面在 `advisorEntryMarkup` 里显示。
- **主动预警的下限**：信号可以带 `floor`（目前只有涉诈事件和涉诈类案，值为 `medium`），模型给的级别不能低于它。信号的 `short` 字段用于拼一句话结论。
- **电话规则**写在 `agent.finalize_card`，需要传入老人的话（含前文）：
  - 诈骗、人身安全、走失给 110；
  - 投诉涉及钱（`MONEY_COMPLAINT`）给 12315；
  - 健康问题判为高风险才给 120；
  - 其余都给机构值班电话。
- **打卡关怀提醒**：
  - 规则在 `care.daily_check_concern`，页面 `submitDailyCheck` 用同一规则决定提示文字，改动时两处一起改。
  - 提醒由服务端在 `merge_authorized` 的 `daily_check` 分支生成，编号为 `DC-老人编号-日期`，`audience: "provider"`。`public_state` 里老人端和监管端都不返回这类提醒。
- **通知中心**：`notificationItems` 现在包含 `state.data.notifications`，按身份过滤。

## 13. 家人要钱先核实、生活情景实测（15.3，2026-09-27）

详见 `README.md` 的 15.3 节。接手时注意：

- **`agent.family_money(message)`** 返回五种结果：`paid`、`impersonation`、`gift`、`verify`，或空串（与家人要钱无关）。
  - 判断顺序：先看已转账，再看老人自己给钱，再看是否要钱，最后看有没有冒充迹象。
  - 冒充特征写在 `IMPERSONATION` 里，要钱的说法写在 `ASK_MONEY` 里。
  - `verify` 由 `_family_verify` 处理：去掉“马上报警”这类非条件句，保证“先别转”和“打平常用的号码核实”两条，删去报案工单，补上请家人回电的提醒。
  - 新意图 `verify` 的电话给档案里的紧急联系人，`finalize_card` 返回 `contact` 字段，页面据此显示“打给某某核实”。
- **建议卡**：`place_route` 和 `price` 可以为空，页面只渲染有内容的格子（`--cols`）。对话里的拨号按钮用 `ai-dial`，不要换回 `dial`，否则会弹窗盖掉对话。
- **数据版本 10**：所有在住老人都有 `emergencyName` 和 `emergencyPhone`（已脱敏）。旧数据库启动时会自动重置为新种子，重置前会先备份。
- **DeepSeek 测试**：新增“情景”组 Q1～Q28。新增的检查字段有：`calm`（钱没转时不能让老人马上报警）、`max_risk`、`phone_not`、`contact`、`must_any`。
- **监管总览**：`qualityGap` 负责对照填报分和核算分，`qualityTodoItem` 在差距 10 分以上时生成待办。

## 14. 老人端视频对话与首页入口（15.4，2026-09-27）

详见 `README.md` 的 15.4 节。只改了 `app.js` 和 `styles.css`，后端没动。接手时注意：

- **对话框结构**：`.va` 分左右两栏，左边 `.va-call`（`#va-stage` 画面、`#va-xg` 小桂状态、`#va-caption` 字幕、`.va-controls` 通话按键），右边 `.va-chat`（`#ai-chat-log`、`#ai-chat-form`）。
  - `#ai-mic-btn`、`#ai-camera-btn`、`#ai-video`、`#ai-dialog-input`、`#ai-send-btn`、`#speech-status` 这些 id 都保留了。
- **字幕和状态**：
  - `setCaption(谁, 文字)` 负责字幕，`setXgState(idle/listening/thinking/speaking)` 负责小桂状态，对话框没打开时两者都不做任何事。
  - `speakForElder` 改为按句朗读，每句的 `onstart` 更新字幕。
- **摄像头**：`startAiCamera(quiet)` 在打开对话时自动调用（`quiet` 为真时失败也不弹提示）。`stopAiCamera` 和 `toggleAiCamera` 对应“开画面 / 关画面”；关闭对话框时 `closeModal` 会停掉摄像头。
- **求助与维权**：去向写在 `REPORT_ROUTES` 里（负责单位、时限、电话、是否同时呼救、图标），类型是单选按钮 `input[name=category]`。浏览器测试改为点 `label.report-type`。
- **首页服务入口**：`elderServicesHtml(openEvents)`，状态快筛是否已做，看 `dailyChecks[0].date` 是不是今天。
- **老人端放大**：统一写在 `styles.css` 末尾的“15.4 老人端整体放大一档”里，只对 `body[data-role="elder"]` 生效，不影响机构端和监管端。
- **15.5 细调**：
  - 样式在 `styles.css` 末尾的“15.5”一节；
  - 电脑端放大画面的规则写在 `@media (min-width: 901px)` 里，不要挪出来，否则会覆盖手机的单栏布局；
  - 首页右栏的 `elderFamilyHtml` 用档案里的 `emergencyName` 和 `emergencyPhone`。

## 15. 评阅整改（16.0，2026-10-08）

详见 `README.md` 的 16.0 节。接手时注意：

- **新文件**
  - `sla.py`：事件时限（`due_ms`、`status`）和呼救接单考核（`sos_outcome`、`sos_summary`）。
  - `watchdog.py`：后台值守。`tick(state, now)` 是纯函数，方便测试；`Watchdog` 线程在 `server.main()` 里启动，每秒一次。
  - `scripts/package_release.py`：白名单打包 + 自检；`deepseek.env.example`：空白密钥模板；`.gitignore`：排除密钥、`runtime/`、数据库和缓存。
  - `scripts/test_review_fixes.py`（28 项）、`scripts/e2e_review_fixes.py`（25 项），已加入 `run_all_tests.sh`。
- **机构范围**：`authenticate` 返回 `org`，存进会话；`public_state`、`merge_authorized`、`GET /api/sos`、`/api/route-risk`、`/api/checkin`、`/api/device-alarm` 都用会话里的机构。`owned_resident_ids`：没有登记机构的旧档案算本机构，读写同一口径。新增写入类型时，记得在 `check_scope` 里核对归属。
- **事件写入一律走 `apply_event_write`**
  - 新建：服务器写 `createdAt`、`dueAt`、`statusChangedAt`、`time`（月-日 时:分），时间线里的“刚刚”换成服务器时间。
  - 更新：只接受 `status`、`owner`、时间线追加和 `followUp`；办结要新增一条不少于 4 个字的说明，回访“老人不认可”不能办结；从已办结改回处理中算重新打开，要写原因。
  - `deadline` 现在只是“承诺时限”文字，只在创建时用来推算 `dueAt`。**不要再在页面上改写 `deadline`**，时限显示用 `eventSla()` / `slaTag()`。
- **呼救写入走 `merge_sos`**：升级只升不降、`notified` 只增不减、时间线按文字去重追加；工作人员第一次处理（接单，或没接单直接回拨办结）时记 `responseSeconds`；进入结束状态时记 `closedAtMs`。`/api/sos` 写入在 `DATABASE._lock` 内完成，与后台值守互斥。
- **自动推进只在 `watchdog.tick`**：连接本地服务时，页面不再调用 `progressSosSessions`、`refreshOverdueMovements`（只在离线 `file://` 演示用）。改呼救时序要同时改 `watchdog.SOS_RULES` 和 `app.js` 的 `SOS_CONFIG`。`DATABASE.mutate()` 用 `BEGIN IMMEDIATE` 先拿写锁再读，多个服务进程也不会重复推进。
- **口径要两处一起改**：达标率 `sla.py` ↔ `app.js` 的 `sosOutcome` / `sosSlaSummary`；时限文字 `sla.minutes_from_label` ↔ `slaMinutesFromLabel`；样本平移 `database.anchor_seed` ↔ `app.js` 的 `anchorSeed`（新增带日期的字段时两处都要加）。
- **样本**：`data.js` 顶部 `anchorDate`（2026-08-10）；导入、版本升级和 `reset_to_seed()` 时整体平移到当天。版本升级时呼救台账一并重置（旧库先完整备份）。DeepSeek 测试脚本也改为读平移后的样本。
- **类案人工纠错**：`state.radarReviews`（只有监管端能写，类型 `radar_review`）；归并前用 `case_radar.radar_events(state)` 过滤，雷达、主动预警、监管参谋、小桂识别已推送提醒都用它。
- **读接口不改数据**：`GET /api/state` 不再推进报平安超时。
- **测试库路径**：`BusinessDatabase(path)` 显式传入的路径优先于 `GUIYANG_DB_PATH`。设置了该变量跑 e2e 时，单元测试仍用各自的临时库，不会改到 e2e 用的库（以前会因此报错）。
- **写入被拒绝时**：`/api/state`、`/api/sos` 返回 4xx（越权、缺少说明、工单已被他人接单等）时，页面提示“没有保存”，并重新拉取服务器记录；不再显示“数据库暂时离线”，也不再反复补传同一个被拒绝的呼救改动。
- **页面刷新**：`saveData` 成功后不再直接采用新修订号，而是约 0.4 秒后拉一次服务器合并后的状态（服务器写入的时间和校验结果为准）；后台刷新只重绘当前页，不跳回页首。
- **还没做**：真实 DeepSeek 测试没有重跑（本轮没有用密钥）。监管参谋工具结果的字段变了（`deadline` 改为实时时限，另有“承诺时限”“是否超时”“接单考核”），决赛前必须重跑 `DeepSeek测试.bat`，通过率不能下降。
