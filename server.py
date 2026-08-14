#!/usr/bin/env python3
"""Local full-service server: static site, SQLite persistence, and DeepSeek proxy."""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from database import BusinessDatabase


ROOT = Path(__file__).resolve().parent
MAX_BODY_BYTES = 2 * 1024 * 1024
DEFAULT_BASE_URL = "https://api.deepseek.com"
DEFAULT_MODEL = "deepseek-chat"
DATABASE = BusinessDatabase()


def parse_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    try:
        for raw_line in path.read_text(encoding="utf-8-sig").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            name, value = line.split("=", 1)
            value = value.strip().strip('"').strip("'")
            values[name.strip()] = value
    except (OSError, UnicodeError):
        return {}
    return values


def config_candidates() -> list[Path]:
    explicit = os.environ.get("DEEPSEEK_ENV_FILE", "").strip()
    desktop = Path.home() / "Desktop"
    candidates = [Path(explicit)] if explicit else []
    candidates.extend(
        [
            desktop / "deepseek.env.local",
            desktop / "deep seekapi.env.local",
            desktop / "deepseekapi.env.local",
            desktop / "deepseek_api.env.local",
            desktop / "deep seekapi.txt",
            desktop / "deepseekapi.txt",
        ]
    )
    return candidates


def load_config() -> dict[str, str]:
    file_values: dict[str, str] = {}
    source = ""
    for candidate in config_candidates():
        if candidate.is_file():
            file_values = parse_env_file(candidate)
            source = candidate.name
            break

    def resolve(name: str, default: str = "") -> str:
        return os.environ.get(name, "").strip() or file_values.get(name, "").strip() or default

    base_url = resolve("DEEPSEEK_BASE_URL", DEFAULT_BASE_URL)
    requested_model = resolve("DEEPSEEK_MODEL", DEFAULT_MODEL)
    host = (urlparse(base_url).hostname or "").lower()
    official_models = {"deepseek-chat", "deepseek-reasoner"}
    model = requested_model
    model_adjusted = False
    if host == "api.deepseek.com" and requested_model not in official_models:
        model = DEFAULT_MODEL
        model_adjusted = True

    return {
        "api_key": resolve("DEEPSEEK_API_KEY"),
        "base_url": base_url,
        "model": model,
        "requested_model": requested_model,
        "model_adjusted": model_adjusted,
        "source": source or "system environment",
    }


def endpoint_for(base_url: str) -> str:
    base = base_url.rstrip("/")
    if base.endswith("/chat/completions"):
        return base
    return f"{base}/chat/completions"


def json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def clean_model_content(content: str) -> str:
    content = content.strip()
    if content.startswith("```"):
        content = re.sub(r"^```(?:json)?\s*", "", content, flags=re.IGNORECASE)
        content = re.sub(r"\s*```$", "", content)
    return content.strip()


def normalize_result(content: str) -> dict[str, Any]:
    cleaned = clean_model_content(content)
    try:
        result = json.loads(cleaned)
    except json.JSONDecodeError:
        result = {"summary": cleaned}

    if not isinstance(result, dict):
        result = {"summary": str(result)}

    actions = result.get("immediate_actions")
    if not isinstance(actions, list):
        actions = ["保持冷静，先确认本人当前是否安全。", "需要帮助时联系机构工作人员。"]

    rationale = result.get("rationale")
    if not isinstance(rationale, list):
        rationale = []

    risk_level = str(result.get("risk_level", "low")).lower()
    if risk_level not in {"low", "medium", "high"}:
        risk_level = "medium"

    return {
        "summary": str(result.get("summary", "已完成本次情况分析。"))[:180],
        "immediate_actions": [str(item)[:80] for item in actions[:3]],
        "place_route": str(result.get("place_route", "留在当前位置，等待工作人员联系。"))[:140],
        "price": str(result.get("price", "以现场公示或主管部门答复为准。"))[:100],
        "phone": str(result.get("phone", "12345"))[:30],
        "risk_level": risk_level,
        "escalate": bool(result.get("escalate", risk_level == "high")),
        "rationale": [str(item)[:100] for item in rationale[:3]],
    }


def urgent_guardrail(message: str) -> dict[str, Any] | None:
    """Return a deterministic emergency decision before any model call."""
    text = re.sub(r"\s+", "", message.lower())

    if re.search(r"胸痛|胸口(?:疼|痛|发闷|闷)|心口(?:疼|痛)|胸闷|喘不上气|喘不过气|呼吸(?:困难|不畅|急促)|气短得厉害|窒息|嘴唇发紫", text):
        return {
            "summary": "胸口疼或喘不上气属于急症信号，请立即拨打120。",
            "immediate_actions": [
                "立即停止活动，坐下或半卧，不要独自走动",
                "让身边人通知机构并保持门口通畅",
                "马上拨打120，说明胸痛和呼吸困难",
            ],
            "place_route": "留在当前位置等待120；不要自行驾车去医院。",
            "price": "120接警免费；救护车和就医费用按当地标准结算。",
            "phone": "120",
            "risk_level": "high",
            "escalate": True,
            "rationale": ["描述出现胸口疼、胸闷或胸痛", "描述出现喘不上气或呼吸困难"],
            "rule_id": "medical_cardiorespiratory",
            "rule_label": "胸痛与呼吸急症",
            "urgent": True,
        }

    neurological_signal = re.search(r"昏迷|意识不清|叫不醒|抽搐|口角歪|嘴歪|说话含糊|一侧(?:无力|麻木)|浑身动不了|全身动不了", text)
    dizziness = re.search(r"头(?:很|特别|非常|突然)?晕|头昏|眩晕", text)
    functional_loss = re.search(r"站不稳|站不起来|走不了|不能走|动不了|看不清|视物模糊|眼前发黑", text)
    if neurological_signal or (dizziness and functional_loss):
        return {
            "summary": "头晕且无法站立或视物不清属于高危信号，请立即拨打120。",
            "immediate_actions": [
                "立即坐下或侧卧，不要再站立和走动",
                "记住症状开始时间，让身边人陪同",
                "马上拨打120，说明头晕、活动和视力变化",
            ],
            "place_route": "留在当前位置等待120；不要自行乘车或独自外出。",
            "price": "120接警免费；救护车和就医费用按当地标准结算。",
            "phone": "120",
            "risk_level": "high",
            "escalate": True,
            "rationale": ["描述出现明显头晕或意识异常", "同时出现无法站立、活动或视物不清"],
            "rule_id": "medical_neurological",
            "rule_label": "神经系统急症",
            "urgent": True,
        }

    if re.search(r"骨折|大量出血|出血不止|流血不止|严重摔伤|头部受伤|撞到头|开放性伤口", text):
        return {
            "summary": "疑似骨折或持续出血，请停止移动伤处并立即拨打120。",
            "immediate_actions": [
                "不要自行复位或继续走动，保持伤处稳定",
                "用干净纱布轻压出血处，不触碰外露骨端",
                "立即拨打120，并通知机构责任人",
            ],
            "place_route": "留在安全位置等待急救人员；不要自行搬动伤者。",
            "price": "120接警免费；救护车和就医费用按当地标准结算。",
            "phone": "120",
            "risk_level": "high",
            "escalate": True,
            "rationale": ["描述出现骨折、严重外伤或持续出血", "不当移动可能加重损伤"],
            "rule_id": "medical_trauma",
            "rule_label": "外伤急症",
            "urgent": True,
        }

    if re.search(r"不想活|活不下去|想死|自杀|轻生|伤害自己", text):
        return {
            "summary": "您现在的安全最重要，请立即联系身边人并拨打110。",
            "immediate_actions": [
                "不要独处，马上叫工作人员或家属来到身边",
                "远离药物、刀具、阳台等危险位置",
                "立即拨打110；已经受伤同时拨打120",
            ],
            "place_route": "留在有人陪同的安全区域，不要独自离开。",
            "price": "报警和紧急求助免费。",
            "phone": "110",
            "risk_level": "high",
            "escalate": True,
            "rationale": ["描述出现自伤或轻生表达", "需要立即由真人介入保护"],
            "rule_id": "personal_self_harm",
            "rule_label": "人身安全急症",
            "urgent": True,
        }

    return None


def deepseek_chat(payload: dict[str, Any], config: dict[str, str]) -> dict[str, Any]:
    message = str(payload.get("message", "")).strip()
    if not message:
        raise ValueError("message is required")
    if len(message) > 4000:
        raise ValueError("message is too long")

    profile = payload.get("context") if isinstance(payload.get("context"), dict) else {}
    history = payload.get("history") if isinstance(payload.get("history"), list) else []
    safe_history = []
    for item in history[-6:]:
        if not isinstance(item, dict):
            continue
        role = item.get("role")
        content = str(item.get("content", ""))[:1200]
        if role in {"user", "assistant"} and content:
            safe_history.append({"role": role, "content": content})

    system_prompt = """
你是广西旅居养老场景中的适老AI服务助手。你只提供风险筛查、办事指引和信息整理，不作医学诊断，不替代医生、警察或主管部门。
回答必须简短、明确、可行动，适合老年人阅读。不要夸大确定性，不要编造机构地址、价格或电话号码。
遇到胸痛、呼吸困难、意识异常等健康紧急情况，电话优先120；人身安全、走失或治安危险优先110；消费维权可建议12315；其他政务诉求可建议12345。
请只输出一个JSON对象，不要输出Markdown，字段必须为：
summary（不超过60字）、immediate_actions（最多3条）、place_route（地点或路线）、price（费用说明）、phone（一个最优联系电话）、risk_level（low/medium/high）、escalate（布尔值）、rationale（最多3条触发依据）。
""".strip()

    user_context = {
        "current_city": str(profile.get("current_city", "北海市"))[:60],
        "institution": str(profile.get("institution", ""))[:100],
        "age": str(profile.get("age", ""))[:10],
        "conditions": profile.get("conditions", []) if isinstance(profile.get("conditions"), list) else [],
        "allergy": str(profile.get("allergy", ""))[:80],
    }
    messages = [{"role": "system", "content": system_prompt}]
    messages.extend(safe_history)
    messages.append(
        {
            "role": "user",
            "content": "老人必要背景："
            + json.dumps(user_context, ensure_ascii=False)
            + "\n老人本次主动描述："
            + message,
        }
    )

    request_body = {
        "model": config["model"],
        "messages": messages,
        "temperature": 0.2,
        "max_tokens": 650,
        "response_format": {"type": "json_object"},
        "stream": False,
    }
    request = urllib.request.Request(
        endpoint_for(config["base_url"]),
        data=json_bytes(request_body),
        method="POST",
        headers={
            "Authorization": f"Bearer {config['api_key']}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "GuangxiEldercareService/1.3",
        },
    )
    with urllib.request.urlopen(request, timeout=45) as response:
        remote = json.loads(response.read().decode("utf-8"))
    content = remote["choices"][0]["message"]["content"]
    return normalize_result(content)


class AppHandler(SimpleHTTPRequestHandler):
    server_version = "GuangxiEldercare/1.3"

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def send_json(self, status: HTTPStatus, value: Any) -> None:
        body = json_bytes(value)
        self.send_response(status.value)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def read_json_body(self) -> dict[str, Any]:
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise ValueError("invalid_request_size") from error
        if content_length <= 0 or content_length > MAX_BODY_BYTES:
            raise ValueError("invalid_request_size")
        try:
            payload = json.loads(self.rfile.read(content_length).decode("utf-8"))
        except (UnicodeError, json.JSONDecodeError) as error:
            raise ValueError("invalid_json") from error
        if not isinstance(payload, dict):
            raise ValueError("invalid_json")
        return payload

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/api/status":
            config = load_config()
            self.send_json(
                HTTPStatus.OK,
                {
                    "configured": bool(config["api_key"]),
                    "provider": "DeepSeek",
                    "model": config["model"],
                    "model_adjusted": config["model_adjusted"],
                    "source": config["source"],
                    "video_upload": False,
                    "database": DATABASE.status(),
                },
            )
            return
        if parsed.path == "/api/database/status":
            self.send_json(HTTPStatus.OK, {"ok": True, "database": DATABASE.status()})
            return
        if parsed.path == "/api/state":
            self.send_json(
                HTTPStatus.OK,
                {"ok": True, "data": DATABASE.read_state(), "database": DATABASE.status()},
            )
            return
        if parsed.path == "/api/audit":
            query = parse_qs(parsed.query)
            try:
                limit = int(query.get("limit", ["20"])[0])
            except ValueError:
                limit = 20
            self.send_json(
                HTTPStatus.OK,
                {"ok": True, "logs": DATABASE.audit_logs(limit), "database": DATABASE.status()},
            )
            return
        super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path not in {"/api/chat", "/api/state"}:
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "not_found"})
            return

        try:
            payload = self.read_json_body()
        except ValueError as error:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return

        if parsed.path == "/api/state":
            state = payload.get("state")
            audit = payload.get("audit") if isinstance(payload.get("audit"), dict) else {}
            if not isinstance(state, dict):
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid_state"})
                return
            try:
                DATABASE.replace_state(state, audit)
            except (ValueError, sqlite3.DatabaseError):
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": "database_write_failed"})
                return
            self.send_json(HTTPStatus.OK, {"ok": True, "database": DATABASE.status()})
            return

        message = str(payload.get("message", "")).strip()
        guardrail = urgent_guardrail(message) if message else None
        if guardrail:
            self.send_json(
                HTTPStatus.OK,
                {
                    "provider": "急症安全分流",
                    "model": "deterministic-guardrail-v1",
                    "result": guardrail,
                    "created_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                },
            )
            return

        config = load_config()
        if not config["api_key"]:
            self.send_json(
                HTTPStatus.SERVICE_UNAVAILABLE,
                {"error": "deepseek_not_configured", "message": "未找到DeepSeek API配置。"},
            )
            return

        try:
            result = deepseek_chat(payload, config)
        except ValueError as error:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid_message", "message": str(error)})
            return
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, KeyError, IndexError, json.JSONDecodeError):
            self.send_json(
                HTTPStatus.BAD_GATEWAY,
                {"error": "deepseek_unavailable", "message": "DeepSeek暂时无法响应，请稍后重试。"},
            )
            return

        self.send_json(
            HTTPStatus.OK,
            {
                "provider": "DeepSeek",
                "model": config["model"],
                "result": result,
                "created_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            },
        )

    def log_message(self, format_string: str, *args: Any) -> None:
        # Never log request bodies, headers, or API configuration.
        print(f"[{self.log_date_time_string()}] {self.command} {self.path} - {format_string % args}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the Guiyang Anxin local full-service server.")
    parser.add_argument("--port", type=int, default=4173)
    parser.add_argument("--open", action="store_true", help="Open the site in the default browser.")
    args = parser.parse_args()

    DATABASE.initialize()
    database_status = DATABASE.status()
    config = load_config()
    status = f"DeepSeek ready ({config['model']}, {config['source']})" if config["api_key"] else "DeepSeek not configured"
    url = f"http://127.0.0.1:{args.port}/"
    print(f"Guiyang Anxin full service running at {url}")
    print(
        "SQLite ready "
        f"({database_status['counts']['residents']['count']} residents, "
        f"{database_status['counts']['movement_records']['count']} movements, "
        f"{database_status['counts']['audit_logs']['count']} audit logs)"
    )
    print(status)
    print("Press Ctrl+C to stop.")

    if args.open:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()

    server = ThreadingHTTPServer(("127.0.0.1", args.port), AppHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
