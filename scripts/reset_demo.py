"""把本地数据库恢复成演示初始状态（决赛演示前或演示后重来一遍时使用），服务可以不停。"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from e2e_auth import reset_demo  # noqa: E402

reset_demo("重置演示数据")
print("演示数据已恢复初始状态。已打开的页面会在几秒内自动同步，老人端和监管端重新登录即可。")
