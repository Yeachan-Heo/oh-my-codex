from __future__ import annotations

import contextlib
import io
import json
import os
import runpy
import sys

_SCRIPT_PATH = os.path.normpath(os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "playground",
    "ml_kaggle_demo",
    "train.py",
))

if not os.path.isfile(_SCRIPT_PATH):
    print(json.dumps({"pass": False, "score": 0.0}))
    raise SystemExit(1)

_stdout_buf = io.StringIO()
_stderr_buf = io.StringIO()
_exit_code = 0

try:
    with contextlib.redirect_stdout(_stdout_buf), contextlib.redirect_stderr(_stderr_buf):
        runpy.run_path(_SCRIPT_PATH, run_name="__main__")
except SystemExit as _exc:
    _exit_code = int(_exc.code) if _exc.code is not None else 0

_stdout_output = _stdout_buf.getvalue()
_stderr_output = _stderr_buf.getvalue()

if _stdout_output:
    sys.stderr.write(_stdout_output)
if _stderr_output:
    sys.stderr.write(_stderr_output)

if _exit_code != 0:
    print(json.dumps({"pass": False, "score": 0.0}))
    raise SystemExit(_exit_code)

metrics = json.loads(_stdout_output)
auc = float(metrics["roc_auc"])

# Baseline should pass, but score_improvement should still reward better architectures.
passed = auc >= 0.90
print(json.dumps({"pass": passed, "score": auc}))
raise SystemExit(0 if passed else 1)
