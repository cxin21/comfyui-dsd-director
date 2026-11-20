#!/usr/bin/env python
"""把 film-pipeline/src/dsd 同步进 dsd-director/dsd，并打印 sha256 对照。

用法：
    python scripts/sync_kernel.py           # 复制并打印对照
    python scripts/sync_kernel.py --check   # 只比较；不一致时退出码 1
"""

from __future__ import annotations

import hashlib
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)
DST = os.path.join(PKG, "dsd")
SRC = os.environ.get("DSD_SRC") or os.path.join(
    os.path.expanduser("~"), "Documents", "deepseek-harness",
    "default-workspace", "film-pipeline", "src", "dsd")

FILES = ("__init__.py", "plan.py", "executor.py", "handoff.py",
         "sampling.py", "preflight.py", "nodes.py")


def _sha(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()[:12]


def main(argv):
    check = "--check" in argv
    if not os.path.isdir(SRC):
        print("source kernel not found: %s" % SRC)
        return 2
    rows, drift = [], []
    for name in FILES:
        a = os.path.join(SRC, name)
        b = os.path.join(DST, name)
        if not os.path.isfile(a):
            print("missing in source: %s" % name)
            return 2
        ha = _sha(a)
        hb = _sha(b) if os.path.isfile(b) else "-"
        same = ha == hb
        rows.append((name, ha, hb, same))
        if not same:
            drift.append(name)
    for name, ha, hb, same in rows:
        print("%-14s %s %s %s" % (name, ha, hb, "ok" if same else "DRIFT"))
    if check:
        print("\n%s" % ("in sync" if not drift else "out of sync: " + ", ".join(drift)))
        return 0 if not drift else 1
    os.makedirs(DST, exist_ok=True)
    for name in drift:
        shutil.copyfile(os.path.join(SRC, name), os.path.join(DST, name))
    print("\ncopied %d file(s) from %s" % (len(drift), SRC))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))