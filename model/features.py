"""Feature engineering shared by calibration and scoring.

KEEP THIS IN LOCK-STEP WITH site/app.js (function `features`). The parity test
feeds the same rows to both and asserts identical numbers.

Each feature is a plain number; a missing input becomes 0 *and* flips a
"missing" indicator so the model can learn that absence itself carries
information (an IPO with no GMP quote is usually a weak SME issue).
"""
from __future__ import annotations

import math

FEATURE_NAMES = [
    "gmp_pct",          # grey market premium as % of issue price, clipped
    "gmp_missing",      # 1 if no GMP quote
    "log_sub_qib",      # log1p(QIB times subscribed)
    "log_sub_nii",      # log1p(NII times subscribed)
    "log_sub_retail",   # log1p(retail times subscribed)
    "sub_missing",      # 1 if no subscription figures at all
    "is_sme",           # 1 for NSE Emerge / BSE SME
    "log_issue_size",   # log(issue size in crore)
    "nifty_1m_pct",     # Nifty 50 one-month change, %
    "gmp_trend_pct",    # change in GMP% over the last ~3 quotes (momentum)
]

GMP_CLIP = (-25.0, 150.0)


def _f(x):
    try:
        if x is None:
            return None
        v = float(x)
        if math.isnan(v) or math.isinf(v):
            return None
        return v
    except (TypeError, ValueError):
        return None


def gmp_pct_of(ipo: dict) -> float | None:
    g = ipo.get("gmp") or {}
    pct = _f(g.get("pct"))
    rs = _f(g.get("rs"))
    price = _f(ipo.get("issue_price"))
    if pct is None and rs is not None and price:
        pct = 100.0 * rs / price
    return pct


def gmp_history_of(ipo: dict) -> list[dict]:
    """Dated, numeric GMP quotes, oldest first; anything malformed is dropped.
    KEEP IN STEP WITH score.js gmpHistoryOf."""
    g = ipo.get("gmp") or {}
    out = []
    for h in (g.get("history") or []):
        if not isinstance(h, dict):
            continue
        v = _f(h.get("rs"))
        if v is None:
            continue
        out.append({"date": str(h.get("date") or ""), "rs": v})
    out.sort(key=lambda h: h["date"])
    return out


def gmp_trend_of(ipo: dict) -> float | None:
    """GMP% change between the latest quote and the quote ~3 entries earlier."""
    hist = gmp_history_of(ipo)
    price = _f(ipo.get("issue_price"))
    if len(hist) < 2 or not price:
        return None
    last = hist[-1]["rs"]
    prev = hist[max(0, len(hist) - 4)]["rs"]
    return 100.0 * (last - prev) / price


def features(ipo: dict, market: dict | None = None) -> dict:
    sub = ipo.get("subscription") or {}
    qib, nii, ret = _f(sub.get("qib")), _f(sub.get("nii")), _f(sub.get("retail"))
    total = _f(sub.get("total"))
    sub_missing = 1.0 if (qib is None and nii is None and ret is None and total is None) else 0.0
    # a category the source did not report falls back to the overall multiple
    if total is not None:
        qib = total if qib is None else qib
        nii = total if nii is None else nii
        ret = total if ret is None else ret
    gmp = gmp_pct_of(ipo)
    gmp_missing = 1.0 if gmp is None else 0.0
    size = _f(ipo.get("issue_size_cr"))
    m = market or ipo.get("market") or {}
    n1m = _f(m.get("nifty_1m_pct"))
    trend = gmp_trend_of(ipo)
    return {
        "gmp_pct": min(GMP_CLIP[1], max(GMP_CLIP[0], gmp)) if gmp is not None else 0.0,
        "gmp_missing": gmp_missing,
        "log_sub_qib": math.log1p(max(0.0, qib)) if qib is not None else 0.0,
        "log_sub_nii": math.log1p(max(0.0, nii)) if nii is not None else 0.0,
        "log_sub_retail": math.log1p(max(0.0, ret)) if ret is not None else 0.0,
        "sub_missing": sub_missing,
        "is_sme": 1.0 if (ipo.get("board") == "sme") else 0.0,
        "log_issue_size": math.log(max(1.0, size)) if size is not None else math.log(300.0),
        "nifty_1m_pct": n1m if n1m is not None else 0.0,
        "gmp_trend_pct": trend if trend is not None else 0.0,
    }


def vector(feat: dict) -> list[float]:
    return [float(feat[k]) for k in FEATURE_NAMES]
