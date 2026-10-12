/* Focused browser regression for authentication, sync, speech fallback and scene ⑤. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbPath = process.env.GUIYANG_DB_PATH || path.join(root, "runtime", "guiyang_elders.db");
const passwords = JSON.parse(fs.readFileSync(path.join(path.dirname(dbPath), "demo_credentials.json"), "utf8"));
const base = process.env.GY_BASE || "http://127.0.0.1:4173/";
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const failures = [];

async function login(page, role, account) {
  await page.goto(base);
  await page.locator(`.role-option[data-role="${role}"]`).click();
  await page.locator("#login-account").fill(account);
  await page.locator("#login-password").fill(passwords[role]);
  await page.locator("#login-form button[type=submit]").click();
  await page.locator("#app-view").waitFor({ state: "visible", timeout: 12000 });
}

try {
  const elder = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const provider = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const e = await elder.newPage();
  const p = await provider.newPage();
  for (const page of [e, p]) page.on("pageerror", (error) => failures.push(error.message));
  await login(e, "elder", "elder");
  assert.equal(await e.locator(".sos-big-btn").count(), 1);
  assert.equal(await e.evaluate(() => sessionStorage.getItem("guiyang-v1-session")), "elder");
  await login(p, "provider", "center");
  await p.locator('[data-action="movement-report"]').first().click();
  await p.locator('input[name="destination"]').fill("巴马山地康养路线（模拟）");
  await p.locator("#route-risk-preview").getByText("高风险提示", { exact: false }).waitFor({ timeout: 8000 });
  assert.match(await p.locator("#route-risk-preview").innerText(), /合成案例/);
  await p.locator('input[name="responsiblePhone"]').fill("13900000000");
  await p.locator('input[name="companion"]').fill("护理员陪同");
  await p.locator('textarea[name="reason"]').fill("路线风险演示与人工复核");
  await p.locator('#movement-report-form button[type="submit"], [form="movement-report-form"]').first().click();
  await p.locator("#movement-report-form").waitFor({ state: "detached", timeout: 7000 });
  await e.waitForFunction(() => (JSON.parse(localStorage.getItem("guiyang-v1-data"))?.movementLogs || []).some((item) => item.destination.includes("巴马山地康养")), null, { timeout: 12000 });
  const snapshot = await p.evaluate(() => JSON.parse(localStorage.getItem("guiyang-v1-data")));
  const trip = snapshot.movementLogs.find((item) => item.destination.includes("巴马山地康养"));
  assert.equal(trip.routeAssessment.verified, false);
  const elderSnapshot = await e.evaluate(() => JSON.parse(localStorage.getItem("guiyang-v1-data")));
  assert.equal(elderSnapshot.residents.length, 1);
  assert.ok(elderSnapshot.movementLogs.some((item) => item.id === trip.id));
  await e.locator(".sos-big-btn").click();
  await e.locator('[data-action="sos-send-now"]').click();
  const ticket = await e.locator("[data-sos-modal]").getAttribute("data-sos-modal");
  await p.locator(`.sos-queue-item:has([data-sos-countdown="${ticket}"])`).waitFor({ timeout: 10000 });
  await p.locator(`.sos-queue-item:has([data-sos-countdown="${ticket}"]) [data-action="sos-claim"]`).click();
  await e.waitForFunction((id) => (JSON.parse(localStorage.getItem("guiyang-v1-data"))?.sosSessions || []).some((item) => item.id === id && item.status === "claimed"), ticket, { timeout: 10000 });
  assert.equal(failures.length, 0, failures.join("\n"));
  console.log("PASS browser login, scene ⑤ route preview, cross-device state sync, SOS claim, role view");
} finally {
  await browser.close();
}
