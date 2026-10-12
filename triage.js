(function (global) {
  "use strict";

  function decision(ruleId, ruleLabel, values) {
    return Object.assign({ rule_id: ruleId, rule_label: ruleLabel, urgent: false }, values);
  }

  function assess(message, ctx = {}) {
    const text = String(message || "").toLowerCase().replace(/\s+/g, "");
    const conditions = Array.isArray(ctx.conditions) ? ctx.conditions.join("、") : "";

    const chestEmergency = /胸痛|胸口(?:疼|痛|发闷|闷)|心口(?:疼|痛)|胸闷|喘不上气|喘不过气|呼吸(?:困难|不畅|急促)|气短得厉害|窒息|嘴唇发紫/.test(text);
    if (chestEmergency) {
      return decision("medical_cardiorespiratory", "胸痛与呼吸急症", {
        summary: "胸口疼或喘不上气属于急症信号，请立即拨打120。",
        immediate_actions: ["立即停止活动，坐下或半卧，不要独自走动", "让身边人通知机构并保持门口通畅", "马上拨打120，说明胸痛和呼吸困难"],
        place_route: "留在当前位置等待120；不要自行驾车去医院。",
        price: "120接警免费；救护车和就医费用按当地标准结算。",
        phone: "120",
        risk_level: "high",
        escalate: true,
        urgent: true,
        rationale: ["描述出现胸口疼、胸闷或胸痛", "描述出现喘不上气或呼吸困难"]
      });
    }

    const neurologicalSignal = /昏迷|意识不清|叫不醒|抽搐|口角歪|嘴歪|说话含糊|一侧(?:无力|麻木)|浑身动不了|全身动不了/.test(text);
    const dizziness = /头(?:很|特别|非常|突然)?晕|头昏|眩晕/.test(text);
    const functionalLoss = /站不稳|站不起来|走不了|不能走|动不了|看不清|视物模糊|眼前发黑/.test(text);
    if (neurologicalSignal || (dizziness && functionalLoss)) {
      return decision("medical_neurological", "神经系统急症", {
        summary: "头晕且无法站立或视物不清属于高危信号，请立即拨打120。",
        immediate_actions: ["立即坐下或侧卧，不要再站立和走动", "记住症状开始时间，让身边人陪同", "马上拨打120，说明头晕、活动和视力变化"],
        place_route: "留在当前位置等待120；不要自行乘车或独自外出。",
        price: "120接警免费；救护车和就医费用按当地标准结算。",
        phone: "120",
        risk_level: "high",
        escalate: true,
        urgent: true,
        rationale: ["描述出现明显头晕或意识异常", "同时出现无法站立、活动或视物不清"]
      });
    }

    const majorInjury = /骨折|腿断|胳膊断|手臂断|脚断|骨头断|无法负重|不能负重|大量出血|出血不止|流血不止|严重摔伤|(?:摔倒|跌倒|摔了|跌了|滑倒|摔跤|跌跤|绊倒)[^。！？!?]{0,8}(?:起不来|站不起来|爬不起来|动不了|剧烈疼|疼得厉害)|头部受伤|撞到头|开放性伤口/.test(text);
    if (majorInjury) {
      return decision("medical_trauma", "外伤急症", {
        summary: "疑似骨折或持续出血，请停止移动伤处并立即拨打120。",
        immediate_actions: ["不要自行复位或继续走动，保持伤处稳定", "用干净纱布轻压出血处，不触碰外露骨端", "立即拨打120，并通知机构责任人"],
        place_route: "留在安全位置等待急救人员；不要自行搬动伤者。",
        price: "120接警免费；救护车和就医费用按当地标准结算。",
        phone: "120",
        risk_level: "high",
        escalate: true,
        urgent: true,
        rationale: ["描述出现骨折、严重外伤或持续出血", "不当移动可能加重损伤"]
      });
    }

    if (/不想活|活不下去|想死|自杀|轻生|伤害自己/.test(text)) {
      return decision("personal_self_harm", "人身安全急症", {
        summary: "您现在的安全最重要，请立即联系身边人并拨打110。",
        immediate_actions: ["不要独处，马上叫工作人员或家属来到身边", "远离药物、刀具、阳台等危险位置", "立即拨打110；已经受伤同时拨打120"],
        place_route: "留在有人陪同的安全区域，不要独自离开。",
        price: "报警和紧急求助免费。",
        phone: "110",
        risk_level: "high",
        escalate: true,
        urgent: true,
        rationale: ["描述出现自伤或轻生表达", "需要立即由真人介入保护"]
      });
    }

    if (/被跟踪|人身危险|抢劫|打人|被打|威胁|骚扰|有人闯[入进]/.test(text)) {
      return decision("personal_safety", "人身安全", {
        summary: "请先离开危险位置，并立即联系110。",
        immediate_actions: ["前往明亮且有人值守的位置", "把当前位置发给家属或机构", "拨打110说明人员、地点和当前危险"],
        place_route: "前往附近警务站、游客服务中心或有人值守的公共场所。",
        price: "报警求助免费。",
        phone: "110",
        risk_level: "high",
        escalate: true,
        urgent: true,
        rationale: ["描述涉及现实人身威胁", "需要属地公安立即介入"]
      });
    }

    if (/救命|救救我|快来人|来人啊|来人呀|来人哪|有人吗快|求救|求求你们来|sos/.test(text)) {
      return decision("personal_sos", "紧急呼救", {
        summary: "已识别到呼救。平台已生成站内响应工单；回拨为模拟流程，请同时联系值班人员；情况危急请直接拨打120。",
        immediate_actions: ["留在原地，保持电话畅通，等待平台回拨", "如能说话，请补充在哪里、发生了什么", "出现胸痛、呼吸困难或大量出血时，立即拨打120"],
        place_route: "留在当前位置；值班人员正在赶来确认。",
        price: "平台应急响应和报警求助免费。",
        phone: "120",
        risk_level: "high",
        escalate: true,
        urgent: true,
        sos: true,
        rationale: ["语音或文字中出现明确呼救词", "按平台应急响应机制先回拨确认，再由值班人员到场"]
      });
    }

    if (/迷路|找不到路|找不到.*(?:路|机构)|走失|不知道在哪|回不去|回不了机构|找不到机构/.test(text)) {
      return decision("location_lost", "迷路与走失风险", {
        summary: "请不要继续走动，留在安全地点并联系110和机构。",
        immediate_actions: ["停在有明显标志和工作人员的位置", "发送定位或说出附近店名、路牌", "联系机构；无法联系时拨打110"],
        place_route: "优先停留在警务站、游客中心、商场服务台等有人值守处。",
        price: "报警和公共场所求助免费。",
        phone: "110",
        risk_level: "high",
        escalate: true,
        urgent: true,
        rationale: ["描述出现迷路或无法返回机构", "老人继续移动会增加失联风险"]
      });
    }

    const fraudSignals = [/保证收益|稳赚不赔|高额回报|养老投资|养老床位返利/, /转账|汇款|预付|充值|交押金/, /索要验证码|屏幕共享|陌生链接|冒充客服|冒充民政|冒充公检法/].filter((item) => item.test(text)).length;
    if (fraudSignals >= 2) {
      return decision("fraud_warning", "涉老诈骗风险提示", {
        summary: "发现多项可疑话术，请先暂停付款并请工作人员核实。",
        immediate_actions: ["停止转账和提供验证码，保留聊天、合同与付款凭证", "请机构或家属协助核实对方身份与合同", "若已转账或遭胁迫，请及时向公安机关咨询报警"],
        place_route: "先到有工作人员陪同的安全地点核对信息。", price: "不要为获取所谓返利追加付款。", phone: "110（已受骗或受到威胁时）", risk_level: "medium", escalate: true, intent: "fraud", rationale: ["命中至少两类可疑交易/身份话术", "仅作非定罪风险提示，须人工复核"]
      });
    }
    if (/收费|价格|退款|多收|乱收费|票据|消费|合同|押金/.test(text)) {
      return decision("consumer_dispute", "消费维权", {
        summary: "先保存票据和付款记录，再要求核对公示价格。",
        immediate_actions: ["拍照保存价目表、合同和付款记录", "向机构提出核对与退款诉求", "未解决时拨打12315"],
        place_route: "先到机构服务台；仍未解决可联系属地市场监管部门。",
        price: "维权咨询免费；实际费用以公示和合同为准。",
        phone: "12315",
        risk_level: "medium",
        escalate: true,
        rationale: ["描述涉及收费或合同争议", "需要保存证据并核验公示价格"]
      });
    }

    if (/漏服|多服|吃错药|用错药|药物过敏|忘记吃药|用药/.test(text)) {
      return decision("medication_attention", "用药关注", {
        summary: "先停止自行补药，马上联系医护人员核对。",
        immediate_actions: ["保留药盒并记录药名、剂量和服药时间", "不要自行加倍或混用其他药", "出现呼吸困难、昏厥等情况立即拨打120"],
        place_route: "留在机构或当前安全位置，等待医护人员核对。",
        price: "咨询费用以机构或医疗机构公示为准。",
        phone: "120（出现严重症状时）",
        risk_level: "medium",
        escalate: true,
        rationale: ["描述涉及用药差错或用药疑问", "需要医护人员核对而不是自行调整"]
      });
    }

    if (/头晕|头昏|疼|痛|咳嗽|发烧|发热|恶心|呕吐|腹泻|血压|不舒服|乏力|没胃口|食欲差/.test(text)) {
      return decision("medical_attention", "身体不适", {
        summary: /高血压/.test(conditions) && /头晕|头昏|血压/.test(text) ? "您有高血压史，请静坐并联系工作人员核对当前症状。" : "已识别到身体不适，请先休息并联系机构工作人员复核。",
        immediate_actions: ["坐下休息，不要独自外出", "告诉工作人员何时开始、哪里不适", /高血压/.test(conditions) && /头晕|头昏|血压/.test(text) ? "告知既往高血压史，请工作人员协助测量并联系医护复核" : "症状加重或出现胸痛、呼吸困难时立即拨打120"],
        place_route: "留在机构或当前位置，等待工作人员现场查看。",
        price: "现场关怀以机构公示为准；就医费用按医疗机构结算。",
        phone: "120（症状加重时）",
        risk_level: "medium",
        escalate: true,
        rationale: ["描述出现身体不适", /高血压/.test(conditions) && /头晕|头昏|血压/.test(text) ? "既往高血压史与本次描述同时出现，需人工核对" : "当前信息不足以排除风险，需要人工复核"]
      });
    }

    if (/难过|孤独|害怕|焦虑|失眠|睡不着|心情不好|想家/.test(text)) {
      return decision("emotional_attention", "情绪关怀", {
        summary: "已记录您的情绪变化，请联系熟悉的工作人员陪伴沟通。",
        immediate_actions: ["先到有人陪伴的公共区域", "告诉工作人员这种感受持续了多久", "如出现伤害自己的想法，立即拨打110"],
        place_route: "前往机构服务台、活动室或值班室，不要独自待着。",
        price: "机构基础关怀通常不另收费，专业服务以公示为准。",
        phone: "机构值班人员",
        risk_level: "medium",
        escalate: true,
        rationale: ["描述出现持续负面情绪", "建议由熟悉的工作人员进行真人回访"]
      });
    }

    if (/活动|吃饭|用餐|房间|打扫|接送|行程|预约|课程|娱乐/.test(text)) {
      return decision("daily_service", "日常服务", {
        summary: "这是日常服务问题，请联系机构服务台确认具体安排。",
        immediate_actions: ["说清需要的服务和时间", "确认地点、费用和负责人员", "安排有变化时要求工作人员回电"],
        place_route: "前往机构服务台，或在房间等待工作人员联系。",
        price: "以机构当天公示和已签服务协议为准。",
        phone: "机构服务台",
        risk_level: "low",
        escalate: false,
        rationale: ["描述属于日常服务咨询", "暂未出现健康或人身安全信号"]
      });
    }

    return decision("needs_clarification", "信息待补充", {
      summary: "我还不能确认风险，请补充哪里不舒服、何时开始、现在是否安全。",
      immediate_actions: ["先留在安全位置，不要独自外出", "补充症状、地点和发生时间", "不确定时请工作人员立即到场查看"],
      place_route: "留在当前位置，等待机构工作人员联系。",
      price: "咨询和服务费用以机构公示为准。",
      phone: "机构值班人员",
      risk_level: "medium",
      escalate: true,
      rationale: ["信息不足，系统不会自动判为低风险"]
    });
  }

  global.GY_TRIAGE = Object.freeze({ assess: assess });
})(typeof window !== "undefined" ? window : globalThis);
