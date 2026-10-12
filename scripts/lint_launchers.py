"""Static sanity check for the Windows launchers (cmd.exe is unavailable here)."""
import re, sys

problems = []
for path in ["启动作品.bat", "备用启动_无需Python.bat", "重置演示数据.bat", "DeepSeek测试.bat"]:
    # 统一 UTF-8 保存，并在第二行切换控制台到 UTF-8，GBK 与 UTF-8 系统都不乱码
    text = open(path, "rb").read().decode("utf-8")
    if not text.startswith("@echo off\r\nchcp 65001 >nul\r\n"):
        problems.append(f"{path}: 第二行应为 chcp 65001 >nul")
    if "/dev/null" in text:
        problems.append(f"{path}: Windows 批处理应写 >nul，不能写 /dev/null")
    lines = text.splitlines()
    depth = 0
    labels = set()
    gotos = []
    for i, line in enumerate(lines, 1):
        stripped = line.strip()
        if stripped.startswith("::") or stripped.startswith("rem "):
            continue
        if stripped.startswith(":"):
            labels.add(stripped[1:].split()[0].lower())
        for match in re.finditer(r"goto\s+:?(\w+)", stripped, re.I):
            gotos.append((i, match.group(1).lower()))
        # naive paren balance outside quotes
        in_quote = False
        for char in line:
            if char == '"':
                in_quote = not in_quote
            elif not in_quote and char == "(":
                depth += 1
            elif not in_quote and char == ")":
                depth -= 1
        if depth < 0:
            problems.append(f"{path}:{i} unbalanced closing paren")
            depth = 0
        # %errorlevel% inside a block is expanded at parse time -> classic bug
        if depth > 0 and "%errorlevel%" in line.lower():
            problems.append(f"{path}:{i} uses %errorlevel% inside a block (parse-time expansion)")
    if depth != 0:
        problems.append(f"{path}: {depth} unclosed paren block(s)")
    for line_no, target in gotos:
        if target not in labels and target != "eof":
            problems.append(f"{path}:{line_no} goto :{target} has no label")
    if not text.endswith("\r\n") and not text.rstrip().endswith("exit /b 1"):
        problems.append(f"{path}: file should end with a newline")
    # every exit path a human might hit must pause
    exits = [i for i, l in enumerate(lines, 1) if l.strip().lower().startswith("exit /b")]
    for line_no in exits:
        window = [l.strip().lower() for l in lines[max(0, line_no - 6):line_no]]
        if not any(w == "pause" for w in window) and not lines[line_no - 1].strip().lower().endswith("exit /b 0"):
            problems.append(f"{path}:{line_no} exit path without a preceding pause")
    print(f"{path}: {len(lines)} lines, labels={sorted(labels)}, exits={exits}")

if problems:
    print("\nISSUES:")
    for problem in problems:
        print(" -", problem)
    sys.exit(1)
print("\nlauncher lint clean")
