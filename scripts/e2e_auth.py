"""Local test-only fixture: never expose the database reset over HTTP."""
import json
import os
import sys
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def password_for(role):
    key = f"GUIYANG_PASSWORD_{role.upper()}"
    if os.environ.get(key):
        return os.environ[key]
    db_path = Path(os.environ.get("GUIYANG_DB_PATH") or ROOT / "runtime" / "guiyang_elders.db")
    return json.loads((db_path.parent / "demo_credentials.json").read_text(encoding="utf-8"))[role]


def reset_demo(actor="重置测试样本"):
    """恢复演示初始数据：样本日期平移到今天，呼救工单清空。服务可以不停。"""
    from database import BusinessDatabase
    db = BusinessDatabase()
    db.initialize()
    db.reset_to_seed(actor)


def authorized_open(base, path, role="regulator"):
    account = {"elder": "elder", "provider": "center", "regulator": "admin"}[role]
    payload = json.dumps({"role": role, "account": account, "password": password_for(role)}).encode()
    request = urllib.request.Request(base + "api/login", data=payload, headers={"Content-Type": "application/json"})
    token = json.load(urllib.request.urlopen(request))["token"]
    return urllib.request.urlopen(urllib.request.Request(base + path, headers={"Authorization": "Bearer " + token}))
