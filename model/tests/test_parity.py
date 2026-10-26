"""The browser (site/score.js) and the refresh job (model/score.py) must agree
to the rupee and the percentage point on every row, or the page would show
numbers the calibration report never saw."""
import json
import math
import os
import shutil
import subprocess
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
from model.score import score_ipo  # noqa: E402

FIX = os.path.join(ROOT, "model", "tests", "fixtures")


def _walk(a, b, path=""):
    if isinstance(a, dict):
        assert isinstance(b, dict), path
        assert set(a) == set(b), f"{path}: keys {set(a) ^ set(b)}"
        for k in a:
            _walk(a[k], b[k], f"{path}.{k}")
    elif isinstance(a, list):
        assert isinstance(b, list) and len(a) == len(b), path
        for i, (x, y) in enumerate(zip(a, b)):
            _walk(x, y, f"{path}[{i}]")
    elif isinstance(a, float) or isinstance(b, float):
        assert a is not None and b is not None, f"{path}: {a!r} vs {b!r}"
        assert math.isclose(float(a), float(b), rel_tol=1e-9, abs_tol=1e-9), f"{path}: {a} vs {b}"
    else:
        assert a == b, f"{path}: {a!r} vs {b!r}"


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
@pytest.mark.parametrize("fixture", ["ipos.json", "edge.json"])
def test_js_and_python_scores_match(fixture):
    ipos = os.path.join(FIX, fixture)
    params = os.path.join(FIX, "params.json")
    with open(ipos, encoding="utf-8") as fh:
        live = json.load(fh)
    with open(params, encoding="utf-8") as fh:
        prm = json.load(fh)
    today = "2026-10-26"
    py = [score_ipo(i, prm, live.get("market"), today=today) for i in live["ipos"]]
    js = json.loads(subprocess.check_output(["node", os.path.join(ROOT, "model", "tests", "parity.js"), ipos, params, today]))
    assert len(py) == len(js)
    for p, j in zip(py, js):
        _walk(p, j)
