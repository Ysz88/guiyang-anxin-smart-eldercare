import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(scriptDir, "..", "triage.js"), "utf8");
const context = {};
vm.runInNewContext(source, context, { filename: "triage.js" });

const cases = [
  ["我胸口疼得厉害，喘不上气", "medical_cardiorespiratory", "high", "120"],
  ["我头很晕，浑身动不了，有点看不清东西", "medical_neurological", "high", "120"],
  ["我已经骨折，擦破皮出血了", "medical_trauma", "high", "120"],
  ["我感觉腿断了", "medical_trauma", "high", "120"],
  ["康复训练多收了300元", "consumer_dispute", "medium", "12315"],
  ["我找不到回机构的路了", "location_lost", "high", "110"],
  ["我有点咳嗽，没发烧", "medical_attention", "medium", "120（症状加重时）"],
  ["今天有什么活动", "daily_service", "low", "机构服务台"],
  ["帮帮我", "needs_clarification", "medium", "机构值班人员"]
];

for (const [message, ruleId, riskLevel, phone] of cases) {
  const result = context.GY_TRIAGE.assess(message);
  assert.equal(result.rule_id, ruleId, message);
  assert.equal(result.risk_level, riskLevel, message);
  assert.equal(result.phone, phone, message);
  assert.ok(result.summary.length <= 60, message);
  assert.ok(result.immediate_actions.length <= 3, message);
}

console.log(`triage rules passed: ${cases.length}`);
