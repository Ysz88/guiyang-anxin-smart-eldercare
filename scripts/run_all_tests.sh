#!/usr/bin/env bash
# 桂养安心 · 一键回归验证
# 用法：先启动本地服务（python server.py），再执行 bash scripts/run_all_tests.sh
set -uo pipefail
BASE="${GY_BASE:-http://127.0.0.1:4173/}"
export GY_BASE="$BASE"
cd "$(dirname "$0")/.."

fail=0
step() { printf '\n=== %s ===\n' "$1"; }

step "静态语法检查"
for f in app.js triage.js data.js api/chat.js api/status.js; do node --check "$f" || fail=1; done
python3 -m py_compile server.py database.py route_risk.py agent.py case_radar.py advisor.py care.py insight.py weather.py sla.py watchdog.py scripts/deepseek_eval.py scripts/package_release.py || fail=1
python3 scripts/lint_field_names.py || fail=1
python3 -m unittest discover -s scripts -p 'test_security_routes.py' || fail=1
python3 scripts/test_agent.py || fail=1
python3 scripts/test_case_radar.py || fail=1
python3 scripts/test_advisor.py || fail=1
python3 scripts/test_care.py || fail=1
python3 scripts/test_weather.py || fail=1
python3 scripts/test_review_fixes.py || fail=1
rm -rf __pycache__

step "急症分流规则回归"
node scripts/test_triage.mjs || fail=1

step "Windows 启动器静态检查"
python3 scripts/lint_launchers.py || fail=1

step "浏览器端到端（需要本地服务运行在 $BASE）"
if ! python3 -c 'import playwright' >/dev/null 2>&1; then
  echo "[失败] 缺少 Python Playwright，9 个浏览器 e2e 无法执行；先运行 pip install playwright 和 python -m playwright install chromium。"
  fail=1
elif curl -fsS -m 3 "${BASE}api/status" >/dev/null 2>&1; then
  for t in e2e_sos_full_loop e2e_sos_escalation e2e_sos_realtime e2e_sos_cross_device e2e_dial_handling e2e_sos_offline_mode e2e_ai_dialog e2e_smoke_pages e2e_review_fixes; do
    printf -- '--- %s ---\n' "$t"
    python3 "scripts/$t.py" | tail -3 || fail=1
  done
else
  echo "[失败] 未检测到本地服务，9 个浏览器 e2e 未执行；请先用临时数据库运行 python server.py"
  fail=1
fi

rm -rf __pycache__ scripts/__pycache__
if [ "$fail" -eq 0 ]; then echo -e "\n全部检查通过。"; else echo -e "\n存在失败项，请查看上方输出。"; fi
exit "$fail"
