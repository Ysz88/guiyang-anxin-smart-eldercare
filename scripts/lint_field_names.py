"""Catch a profile.residentId typo before packaging."""
import json
import pathlib
import re
import sys

root = pathlib.Path(__file__).resolve().parents[1]
used = set(re.findall(r"\bprofile\.([A-Za-z_][A-Za-z0-9_]*)", (root / "app.js").read_text(encoding="utf-8")))
valid = set(json.loads((root / "seed.json").read_text(encoding="utf-8"))["profile"])
bad = sorted(used - valid)
if bad:
    print("[失败] profile 引用了不存在的字段：", ", ".join(bad))
    sys.exit(1)
print("[通过] profile 字段引用有效")
