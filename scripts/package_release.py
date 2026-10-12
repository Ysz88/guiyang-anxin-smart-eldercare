"""制作参赛 / 交付源码包：只打包源码、合成种子、说明和空配置模板，并自检有没有混入私有文件。

用法：python scripts/package_release.py            → 在项目上一级生成 桂养安心_源码16.0.zip
      python scripts/package_release.py --out D:\\交付\\源码.zip --name 桂养安心_源码16.0

不会打包：deepseek.env.local（密钥）、runtime/（数据库、备份、账号密码文件、模型缓存）、__pycache__、*.db / *.sqlite。
不要依赖 .gitignore 判断压缩包内容：本脚本按白名单收集文件，打包后再逐个检查文件名和内容。
"""
from __future__ import annotations

import argparse
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RELEASE_NAME = "桂养安心_源码16.0"
INCLUDE_TOP = {".py", ".js", ".html", ".css", ".sql", ".md", ".bat", ".ps1", ".json"}
INCLUDE_DIRS = {"assets": None, "data": {".json"}, "api": {".js"}, "scripts": {".py", ".mjs", ".sh"}, "测试结果": {".json", ".md"}}
TOP_FILES_EXTRA = {"deepseek.env.example", ".gitignore", ".vercelignore"}
FORBIDDEN_NAME = re.compile(r"(^|/)(runtime|__pycache__|\.git|node_modules|backups)(/|$)|deepseek\.env(\.local|\.txt)|demo_credentials|radar_ai_cache|\.(db|sqlite|sqlite3|pyc|log)$|-(wal|shm)$", re.I)
SECRET_PATTERNS = [
    re.compile(r"sk-[A-Za-z0-9]{16,}"),
    re.compile(r"DEEPSEEK_API_KEY\s*=\s*['\"]?[A-Za-z0-9_\-]{12,}"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
]
TEXT_SUFFIXES = {".py", ".js", ".mjs", ".html", ".css", ".sql", ".md", ".bat", ".ps1", ".json", ".sh", ".example", ".txt", ".svg"}


def collect() -> list[Path]:
    files: list[Path] = []
    for path in sorted(ROOT.iterdir()):
        if path.is_file() and (path.suffix.lower() in INCLUDE_TOP or path.name in TOP_FILES_EXTRA):
            files.append(path)
    for folder, suffixes in INCLUDE_DIRS.items():
        base = ROOT / folder
        if not base.is_dir():
            continue
        for path in sorted(base.rglob("*")):
            if path.is_file() and (suffixes is None or path.suffix.lower() in suffixes):
                files.append(path)
    return [path for path in files if not FORBIDDEN_NAME.search(path.relative_to(ROOT).as_posix())]


def inspect(archive: Path) -> dict[str, list[str]]:
    """打包后再逐个检查：文件名不能是私有文件，文本内容不能含密钥。"""
    problems = []
    with zipfile.ZipFile(archive) as bundle:
        names = bundle.namelist()
        for name in names:
            if FORBIDDEN_NAME.search(name):
                problems.append(f"不应打包的文件：{name}")
                continue
            if Path(name).suffix.lower() in TEXT_SUFFIXES:
                text = bundle.read(name).decode("utf-8", errors="ignore")
                for pattern in SECRET_PATTERNS:
                    if pattern.search(text):
                        problems.append(f"疑似密钥内容：{name}（匹配 {pattern.pattern[:24]}…）")
    return {"files": names, "problems": problems}


def build(target: Path, folder: str = RELEASE_NAME) -> dict[str, list[str]]:
    target.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as bundle:
        for path in collect():
            bundle.write(path, f"{folder}/{path.relative_to(ROOT).as_posix()}")
    return inspect(target)


def main() -> None:
    parser = argparse.ArgumentParser(description="制作不含密钥和运行数据的源码包")
    parser.add_argument("--out", type=Path, default=ROOT.parent / f"{RELEASE_NAME}.zip")
    parser.add_argument("--name", default=RELEASE_NAME, help="压缩包里的顶层文件夹名")
    args = parser.parse_args()
    report = build(args.out, args.name)
    print(f"已生成 {args.out}（{len(report['files'])} 个文件）")
    if report["problems"]:
        print("[检查未通过] 压缩包里混入了不应交付的内容，已保留文件供排查，请勿外发：")
        for item in report["problems"]:
            print("  -", item)
        sys.exit(1)
    print("检查通过：不含密钥、数据库、运行目录和账号密码文件。")


if __name__ == "__main__":
    main()
