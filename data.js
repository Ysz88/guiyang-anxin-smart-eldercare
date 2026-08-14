window.GY_DATA = {
  version: 2,
  accounts: {
    elder: { account: "elder", password: "123456", name: "李桂芳", org: "旅居老人", avatar: "李" },
    provider: { account: "center", password: "123456", name: "周敏", org: "北海银龄康养中心", avatar: "周" },
    regulator: { account: "admin", password: "123456", name: "陈科长", org: "自治区民政主管部门", avatar: "陈" }
  },
  profile: {
    id: "GX-LJ-2026-000318",
    name: "李桂芳",
    gender: "女",
    age: 68,
    source: "湖南省长沙市",
    idCard: "4301**********1628",
    phone: "138****6038",
    stayCity: "北海市",
    institution: "北海银龄康养中心",
    room: "颐养楼 208室",
    stayRange: "2026.08.03 - 2026.10.30",
    emergencyName: "李明辉（儿子）",
    emergencyPhone: "138****7281",
    conditions: ["高血压", "膝关节退行性病变"],
    allergy: "青霉素",
    completeness: 92,
    risk: "medium",
    lastCheck: "今日 07:42",
    screening: {
      overall: "medium",
      confidence: 0.91,
      source: "本人自填 + 护理记录",
      updatedAt: "今日 07:42",
      reviewRequired: true,
      reviewStatus: "待人工复核",
      missing: [],
      dimensions: [
        { key: "activity", label: "肢体活动", value: "轻度不适", level: "medium", evidence: "膝关节不适，仍可独立行走" },
        { key: "communication", label: "言语沟通", value: "正常", level: "low", evidence: "本人自填，沟通清晰" },
        { key: "sensory", label: "视听能力", value: "正常", level: "low", evidence: "未报告视听异常" },
        { key: "emotion", label: "心理与情绪", value: "平稳", level: "low", evidence: "近3次打卡情绪平稳" },
        { key: "daily", label: "日常生活", value: "睡眠一般", level: "medium", evidence: "昨晚睡眠一般，建议午后关怀" }
      ],
      carePlan: "午后复测血压，完成一次护理员情绪回访；若头晕加重立即升级。"
    },
    consents: {
      basic: true,
      institution: true,
      health: true,
      crossRegion: false
    }
  },
  dailyChecks: [
    { date: "2026-08-10", sleep: "一般", appetite: "良好", mood: "平稳", mobility: "正常", status: "已完成" },
    { date: "2026-08-09", sleep: "良好", appetite: "良好", mood: "愉快", mobility: "正常", status: "已完成" },
    { date: "2026-08-08", sleep: "一般", appetite: "一般", mood: "平稳", mobility: "轻度不适", status: "已完成" }
  ],
  residents: [
    { id: "GX-LJ-2026-000318", name: "李桂芳", age: 68, source: "湖南长沙", room: "颐养楼 208", checkIn: "08-03", risk: "medium", fresh: "2小时前", status: "在住" },
    { id: "GX-LJ-2026-000267", name: "王建国", age: 72, source: "四川成都", room: "颐养楼 316", checkIn: "07-28", risk: "high", fresh: "18分钟前", status: "在住" },
    { id: "GX-LJ-2026-000251", name: "赵秀兰", age: 66, source: "湖北武汉", room: "雅居楼 105", checkIn: "07-26", risk: "low", fresh: "1小时前", status: "在住" },
    { id: "GX-LJ-2026-000232", name: "刘志远", age: 74, source: "重庆市", room: "颐养楼 402", checkIn: "07-22", risk: "medium", fresh: "昨天", status: "在住" },
    { id: "GX-LJ-2026-000205", name: "陈美华", age: 63, source: "贵州贵阳", room: "雅居楼 211", checkIn: "07-18", risk: "low", fresh: "3小时前", status: "在住" },
    { id: "GX-LJ-2026-000189", name: "孙和平", age: 79, source: "北京市", room: "颐养楼 118", checkIn: "07-16", risk: "high", fresh: "9分钟前", status: "在住" },
    { id: "GX-LJ-2026-000171", name: "周桂英", age: 70, source: "江西南昌", room: "雅居楼 307", checkIn: "07-12", risk: "low", fresh: "4小时前", status: "在住" },
    { id: "GX-LJ-2026-000143", name: "黄德明", age: 76, source: "广东佛山", room: "颐养楼 225", checkIn: "07-09", risk: "medium", fresh: "6小时前", status: "在住" }
  ],
  serviceLogs: [
    { id: "SV-0810-031", residentId: "GX-LJ-2026-000318", resident: "李桂芳", type: "血压测量", staff: "护理员 林静", time: "今日 08:05", result: "138/86 mmHg，建议午后复测", status: "已记录" },
    { id: "SV-0810-026", residentId: "GX-LJ-2026-000267", resident: "王建国", type: "用药提醒", staff: "护士 梁燕", time: "今日 07:50", result: "已按医嘱服药", status: "已记录" },
    { id: "SV-0810-021", residentId: "GX-LJ-2026-000251", resident: "赵秀兰", type: "早餐送餐", staff: "服务员 陈佳", time: "今日 07:32", result: "送达并确认用餐", status: "已记录" },
    { id: "SV-0809-118", residentId: "GX-LJ-2026-000232", resident: "刘志远", type: "康复训练", staff: "康复师 罗文", time: "昨天 16:20", result: "完成15分钟步态训练", status: "已记录" },
    { id: "SV-0809-104", residentId: "GX-LJ-2026-000189", resident: "孙和平", type: "夜间巡查", staff: "护理员 林静", time: "昨天 22:10", result: "老人已休息，房间环境正常", status: "已记录" }
  ],
  events: [
    {
      id: "EV-20260810-017",
      residentId: "GX-LJ-2026-000267",
      resident: "王建国",
      level: "high",
      category: "健康异常",
      title: "连续两次血压偏高并伴头晕",
      source: "机构上报",
      location: "北海银龄康养中心 颐养楼316",
      time: "今日 08:12",
      status: "处置中",
      owner: "北海市卫健部门",
      deadline: "剩余 18分钟",
      summary: "老人今晨自述头晕，07:55与08:08两次血压测量均高于个人基线，已安排护士陪同休息。",
      action: "建议联系定点医院远程问诊，若症状加重立即拨打120。",
      timeline: [
        { time: "08:12", text: "机构提交异常事件", state: "done" },
        { time: "08:14", text: "系统触发红色预警", state: "done" },
        { time: "08:16", text: "卫健联络员接收", state: "current" }
      ]
    },
    {
      id: "EV-20260810-015",
      residentId: "GX-LJ-2026-000189",
      resident: "孙和平",
      level: "high",
      category: "失联风险",
      title: "离开机构后超过2小时未返回",
      source: "动态监测",
      location: "北海银滩景区周边",
      time: "今日 07:46",
      status: "处置中",
      owner: "北海市公安联络组",
      deadline: "剩余 32分钟",
      summary: "老人昨晚未按计划返回机构，电话暂时无法接通，最后一次定位在银滩景区东门。",
      action: "机构继续联系本人及家属，属地联络组核查公共区域信息。",
      timeline: [
        { time: "07:46", text: "系统判定超时未归", state: "done" },
        { time: "07:51", text: "机构确认无法联系", state: "done" },
        { time: "08:03", text: "公安联络组接收", state: "current" }
      ]
    },
    {
      id: "EV-20260810-011",
      residentId: "GX-LJ-2026-000318",
      resident: "李桂芳",
      level: "medium",
      category: "健康提醒",
      title: "晨间血压高于个人基线",
      source: "服务记录",
      location: "北海银龄康养中心 颐养楼208",
      time: "今日 08:07",
      status: "待复核",
      owner: "北海银龄康养中心",
      deadline: "剩余 1小时18分",
      summary: "晨间血压138/86 mmHg，高于近7日个人均值，暂未报告明显不适。",
      action: "午后复测并询问头晕、胸闷等症状。",
      timeline: [
        { time: "08:05", text: "护理员记录血压", state: "done" },
        { time: "08:07", text: "系统生成黄色提醒", state: "current" }
      ]
    },
    {
      id: "EV-20260809-096",
      residentId: "GX-LJ-2026-000232",
      resident: "刘志远",
      level: "medium",
      category: "服务投诉",
      title: "康复训练收费与公示价格不一致",
      source: "老人上报",
      location: "北海银龄康养中心",
      time: "昨天 16:42",
      status: "已转派",
      owner: "北海市市场监管部门",
      deadline: "剩余 5小时",
      summary: "老人提供付款截图，实际收取120元，机构公示单次价格为80元，诉求为核实并退回差额。",
      action: "核验收费记录与公示标准，2个工作日内反馈。",
      timeline: [
        { time: "16:42", text: "老人语音与票据上报", state: "done" },
        { time: "16:43", text: "AI整理事件摘要", state: "done" },
        { time: "17:05", text: "转派市场监管部门", state: "current" }
      ]
    },
    {
      id: "EV-20260809-082",
      residentId: "GX-LJ-2026-000251",
      resident: "赵秀兰",
      level: "low",
      category: "设施报修",
      title: "浴室扶手松动",
      source: "老人上报",
      location: "雅居楼105",
      time: "昨天 10:28",
      status: "已办结",
      owner: "北海银龄康养中心",
      deadline: "已按时完成",
      summary: "老人拍照反映浴室扶手松动，存在轻度安全隐患。",
      action: "维修并复核相邻房间同类设施。",
      timeline: [
        { time: "10:28", text: "老人拍照上报", state: "done" },
        { time: "10:36", text: "后勤人员接单", state: "done" },
        { time: "11:05", text: "维修完成并回访", state: "done" }
      ]
    },
    {
      id: "EV-20260808-061",
      residentId: "GX-LJ-2026-000205",
      resident: "陈美华",
      level: "low",
      category: "行程变更",
      title: "计划提前离住",
      source: "老人报备",
      location: "北海银龄康养中心",
      time: "08-08 18:20",
      status: "已办结",
      owner: "北海银龄康养中心",
      deadline: "已按时完成",
      summary: "老人因家庭安排将离住日期由8月20日提前至8月15日。",
      action: "完成费用结算并生成离住交接摘要。",
      timeline: [
        { time: "08-08 18:20", text: "老人提交行程变更", state: "done" },
        { time: "08-09 09:12", text: "机构确认并更新台账", state: "done" }
      ]
    }
  ],
  institutions: [
    { id: "IN-04501", name: "北海银龄康养中心", city: "北海", residents: 186, alerts: 4, response: "9分钟", closure: 96.4, score: 94.2, status: "正常" },
    { id: "IN-04512", name: "桂林山水颐养公寓", city: "桂林", residents: 142, alerts: 2, response: "12分钟", closure: 95.8, score: 93.6, status: "正常" },
    { id: "IN-04527", name: "巴马候鸟人康养基地", city: "河池", residents: 219, alerts: 5, response: "15分钟", closure: 92.1, score: 91.8, status: "关注" },
    { id: "IN-04533", name: "南宁暖心旅居中心", city: "南宁", residents: 167, alerts: 1, response: "8分钟", closure: 97.2, score: 95.1, status: "正常" },
    { id: "IN-04541", name: "防城港滨海颐养社区", city: "防城港", residents: 98, alerts: 3, response: "18分钟", closure: 89.7, score: 88.9, status: "关注" },
    { id: "IN-04556", name: "钦州湾旅居康养中心", city: "钦州", residents: 86, alerts: 2, response: "14分钟", closure: 93.5, score: 90.6, status: "正常" }
  ],
  notifications: [
    { id: 1, title: "红色预警待跟进", detail: "王建国健康异常事件距首次响应时限剩余18分钟", time: "2分钟前", level: "danger", read: false },
    { id: 2, title: "机构事件已转派", detail: "收费争议事件已由北海市市场监管部门接收", time: "26分钟前", level: "warning", read: false },
    { id: 3, title: "台账数据需更新", detail: "3名旅居老人紧急联系人信息超过90天未确认", time: "1小时前", level: "neutral", read: false }
  ]
};

// The demo records retain the same five observable dimensions used by the reviewed assessment materials.
window.GY_DATA.residents.forEach((resident, index) => {
  const presets = [
    { overall: "medium", confidence: 0.91, reviewRequired: true, reviewStatus: "待人工复核", source: "本人自填 + 护理记录", updatedAt: "今日 07:42", missing: [], dimensions: [{ label: "肢体活动", value: "轻度不适", level: "medium", evidence: "膝关节不适" }, { label: "言语沟通", value: "正常", level: "low", evidence: "护理员观察" }, { label: "视听能力", value: "正常", level: "low", evidence: "未见异常" }, { label: "心理与情绪", value: "平稳", level: "low", evidence: "本人打卡" }, { label: "日常生活", value: "睡眠一般", level: "medium", evidence: "本人自填" }] },
    { overall: "high", confidence: 0.68, reviewRequired: true, reviewStatus: "待人工复核", source: "机构代录 + 血压记录", updatedAt: "今日 08:12", missing: ["视听能力"], dimensions: [{ label: "肢体活动", value: "头晕步态不稳", level: "high", evidence: "连续两次记录伴头晕" }, { label: "言语沟通", value: "可沟通", level: "low", evidence: "护士观察" }, { label: "视听能力", value: "缺项", level: "unknown", evidence: "本轮未采集" }, { label: "心理与情绪", value: "担忧", level: "medium", evidence: "本人描述" }, { label: "日常生活", value: "食欲下降", level: "medium", evidence: "早餐剩余较多" }] },
    { overall: "low", confidence: 0.96, reviewRequired: false, reviewStatus: "已确认", source: "本人自填", updatedAt: "1小时前", missing: [], dimensions: [{ label: "肢体活动", value: "正常", level: "low", evidence: "本人自填" }, { label: "言语沟通", value: "正常", level: "low", evidence: "本人自填" }, { label: "视听能力", value: "正常", level: "low", evidence: "本人自填" }, { label: "心理与情绪", value: "愉快", level: "low", evidence: "本人自填" }, { label: "日常生活", value: "正常", level: "low", evidence: "本人自填" }] },
    { overall: "medium", confidence: 0.74, reviewRequired: true, reviewStatus: "缺项待补", source: "护理员代录", updatedAt: "昨天", missing: ["心理与情绪"], dimensions: [{ label: "肢体活动", value: "轻度不适", level: "medium", evidence: "康复记录" }, { label: "言语沟通", value: "正常", level: "low", evidence: "护理员观察" }, { label: "视听能力", value: "正常", level: "low", evidence: "护理员观察" }, { label: "心理与情绪", value: "缺项", level: "unknown", evidence: "未完成回访" }, { label: "日常生活", value: "睡眠一般", level: "medium", evidence: "夜间巡查" }] },
    { overall: "low", confidence: 0.93, reviewRequired: false, reviewStatus: "已确认", source: "本人自填", updatedAt: "3小时前", missing: [], dimensions: [{ label: "肢体活动", value: "正常", level: "low", evidence: "本人自填" }, { label: "言语沟通", value: "正常", level: "low", evidence: "本人自填" }, { label: "视听能力", value: "正常", level: "low", evidence: "本人自填" }, { label: "心理与情绪", value: "平稳", level: "low", evidence: "本人自填" }, { label: "日常生活", value: "正常", level: "low", evidence: "本人自填" }] },
    { overall: "high", confidence: 0.79, reviewRequired: true, reviewStatus: "待人工复核", source: "夜间巡查 + 机构代录", updatedAt: "9分钟前", missing: [], dimensions: [{ label: "肢体活动", value: "跌倒高风险", level: "high", evidence: "夜间起身需搀扶" }, { label: "言语沟通", value: "正常", level: "low", evidence: "护理员观察" }, { label: "视听能力", value: "听力下降", level: "medium", evidence: "需重复说明" }, { label: "心理与情绪", value: "低落", level: "medium", evidence: "近两日主动交流减少" }, { label: "日常生活", value: "夜间睡眠差", level: "high", evidence: "夜间巡查记录" }] },
    { overall: "low", confidence: 0.95, reviewRequired: false, reviewStatus: "已确认", source: "本人自填", updatedAt: "4小时前", missing: [], dimensions: [{ label: "肢体活动", value: "正常", level: "low", evidence: "本人自填" }, { label: "言语沟通", value: "正常", level: "low", evidence: "本人自填" }, { label: "视听能力", value: "正常", level: "low", evidence: "本人自填" }, { label: "心理与情绪", value: "愉快", level: "low", evidence: "本人自填" }, { label: "日常生活", value: "正常", level: "low", evidence: "本人自填" }] },
    { overall: "medium", confidence: 0.82, reviewRequired: true, reviewStatus: "待人工复核", source: "AI视频 + 护理记录", updatedAt: "6小时前", missing: [], dimensions: [{ label: "肢体活动", value: "步态变慢", level: "medium", evidence: "AI动作辅助采集" }, { label: "言语沟通", value: "正常", level: "low", evidence: "AI语音转写置信度高" }, { label: "视听能力", value: "正常", level: "low", evidence: "本人反馈" }, { label: "心理与情绪", value: "担忧", level: "medium", evidence: "语音表达" }, { label: "日常生活", value: "食欲一般", level: "medium", evidence: "护理员代录" }] }
  ];
  resident.screening = presets[index] || presets[2];
});
