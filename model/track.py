"""Prediction ledger and public track record.

  python -m model.track [--scored data/scored.json] [--history data/history.json]
                        [--params model/params.json] [--predictions data/predictions.json]
                        [--out data/track_record.json] [--no-backfill] [--today YYYY-MM-DD]

data/predictions.json is APPEND-ONLY. Every refresh, each IPO whose bidding has
closed gets one row holding the score exactly as it stood then ("close"); an IPO
that is already listed when first seen, but listed on/after the day this ledger
started (SHIP_DATE), is locked from the pre-listing inputs it still carries
("pre_listing"). A row, once written, is never changed: `merge_ledger` refuses to
overwrite and the test suite checks it.

Listed IPOs in history.json with no locked row can be given a "backfill" row:
the CURRENT model scored on the pre-listing inputs in history. Those are
hindsight numbers (the model may have been fitted on the same listings), so they
are labelled and reported separately; only "close" / "pre_listing" rows are a
genuine out-of-sample record.

data/track_record.json is rebuilt each refresh from the ledger plus the actual
listing-day outcomes (close vs issue price).
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
from datetime import date, datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from model.features import gmp_pct_of, _f  # noqa: E402
from model.score import score_ipo  # noqa: E402

SHIP_DATE = "2026-11-15"          # the ledger's first day: listings from here on are locked, not backfilled
GENUINE = ("close", "pre_listing")
TIERS = ("apply", "lean", "coinflip", "avoid", "watch", "nodata")
LEDGER_FIELDS = ("id", "name", "board", "locked_at", "lock_stage", "p_up", "gain_p10", "gain_p50", "gain_p90",
                 "verdict_tier", "verdict_label", "gmp_pct", "sub_total", "sub_retail", "model_status")


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _r(v, nd=4):
    v = _f(v)
    return None if v is None else round(v, nd)


def prediction_row(ipo: dict, score: dict, locked_at: str, stage: str, model_status: str | None) -> dict:
    gain = score.get("gain") or {}
    sub = ipo.get("subscription") or {}
    v = score.get("verdict") or {}
    g = gmp_pct_of(ipo)
    return {
        "id": ipo["id"], "name": ipo.get("name"), "board": ipo.get("board"),
        "locked_at": locked_at, "lock_stage": stage,
        "p_up": _r(score.get("p_up")),
        "gain_p10": _r(gain.get("p10"), 2), "gain_p50": _r(gain.get("p50"), 2), "gain_p90": _r(gain.get("p90"), 2),
        "verdict_tier": v.get("tier"), "verdict_label": v.get("label"),
        "gmp_pct": _r(g, 2), "sub_total": _r(sub.get("total"), 2), "sub_retail": _r(sub.get("retail"), 2),
        "model_status": model_status,
        "listing_date": ipo.get("listing_date"), "close_date": ipo.get("close_date"),
    }


def ledger_ids(preds: dict) -> set[str]:
    out = set()
    for r in preds.get("rows", []):
        out.add(r["id"])
        out.update(r.get("aliases") or [])
    return out


def merge_ledger(preds: dict, new_rows: list[dict]) -> dict:
    """Append rows whose id is not in the ledger yet. Existing rows are copied untouched."""
    have = ledger_ids(preds)
    rows = [dict(r) for r in preds.get("rows", [])]
    for r in new_rows:
        ids = {r["id"], *(r.get("aliases") or [])}
        if ids & have:
            continue
        rows.append(r)
        have |= ids
    return {"generated_at": _now(), "started": preds.get("started") or SHIP_DATE, "rows": rows}


def lock_live(preds: dict, live: dict, params: dict, today: str, ship_date: str = SHIP_DATE) -> tuple[dict, int]:
    """Lock every closed (or freshly listed) IPO in the scored pipeline that has no ledger row."""
    have = ledger_ids(preds)
    new = []
    status = params.get("status")
    for ipo in live.get("ipos", []):
        ids = {ipo.get("id"), *(ipo.get("aliases") or [])}
        if not ipo.get("id") or ids & have:
            continue
        st = ipo.get("status")
        if st == "closed":
            stage = "close"
        elif st == "listed" and str(ipo.get("listing_date") or "") >= ship_date:
            stage = "pre_listing"
        else:
            continue
        score = ipo.get("score") or score_ipo(ipo, params, live.get("market"), today=today)
        if score.get("p_up") is None:
            continue                       # nothing to lock: no GMP and no demand figures
        row = prediction_row(ipo, score, live.get("generated_at") or today, stage, status)
        if ipo.get("aliases"):
            row["aliases"] = sorted(ipo["aliases"])
        new.append(row)
    out = merge_ledger(preds, new)
    return out, len(out["rows"]) - len(preds.get("rows", []))


def pre_listing_view(row: dict) -> dict:
    """A history row as it looked when bidding closed: no listing prices, status closed,
    GMP quotes after the close date ignored when a dated series exists."""
    r = json.loads(json.dumps(row))
    r.pop("listing", None)
    r.pop("post_listing", None)
    r["status"] = "closed"
    cd = r.get("close_date") or r.get("listing_date")
    g = r.get("gmp") or {}
    hist = [h for h in (g.get("history") or []) if isinstance(h, dict) and h.get("date") and cd and str(h["date"]) <= str(cd)]
    if hist and cd:
        g = dict(g, history=hist, rs=hist[-1].get("rs"), pct=None, as_of=hist[-1]["date"])
        r["gmp"] = g
    return r


def backfill(preds: dict, history: list[dict], params: dict, today: str) -> tuple[dict, int]:
    have = ledger_ids(preds)
    new = []
    for h in history:
        if not h.get("id") or ({h["id"], *(h.get("aliases") or [])} & have):
            continue
        if (h.get("listing") or {}).get("gain_pct") is None:
            continue
        view = pre_listing_view(h)
        asof = view.get("close_date") or view.get("listing_date") or today
        try:
            score = score_ipo(view, params, None, today=str(asof)[:10])
        except Exception:  # noqa: BLE001
            continue
        if score.get("p_up") is None:
            continue
        row = prediction_row(view, score, today, "backfill", params.get("status"))
        if h.get("aliases"):
            row["aliases"] = sorted(h["aliases"])
        new.append(row)
    out = merge_ledger(preds, new)
    return out, len(out["rows"]) - len(preds.get("rows", []))


# ------------------------------------------------------------ track record ---

def _gmp_only_p(row: dict, params: dict, base: float) -> float:
    """Baseline forecast: the empirical share of past listings that rose in this row's
    GMP bucket and board (params.empirical), else the board's base rate."""
    g, board = _f(row.get("gmp_pct")), row.get("board") or "mainboard"
    for e in params.get("empirical") or []:
        if e.get("board") != board or not e.get("n"):
            continue
        if g is None and e.get("bucket") == "no GMP quote":
            return float(e["p_up"])
        if g is not None and e.get("lo") is not None and e["lo"] <= g < e["hi"]:
            return float(e["p_up"])
    br = ((params.get("base_rate") or {}).get(board) or {}).get("p_up")
    return float(br) if br is not None else base


def _median(xs: list[float]) -> float | None:
    if not xs:
        return None
    s = sorted(xs)
    n = len(s)
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2.0


def _summary(rows: list[dict], params: dict) -> dict:
    n = len(rows)
    if not n:
        return {"n": 0, "hit_rate": None, "n_called": 0, "brier": None, "brier_gmp_only": None, "base_rate": None,
                "range_coverage": None, "mean_gain": None}
    ys = [1.0 if r["listed_up"] else 0.0 for r in rows]
    base = sum(ys) / n
    called = [r for r in rows if r["verdict_tier"] in ("apply", "lean")]
    probs = [(r["p_up"], y) for r, y in zip(rows, ys) if r.get("p_up") is not None]
    brier = sum((p - y) ** 2 for p, y in probs) / len(probs) if probs else None
    gmp_b = sum((_gmp_only_p(r, params, base) - y) ** 2 for r, y in zip(rows, ys)) / n
    rng = [r for r in rows if r.get("gain_p10") is not None and r.get("gain_p90") is not None]
    cov = (sum(1 for r in rng if r["gain_p10"] <= r["actual_gain_pct"] <= r["gain_p90"]) / len(rng)) if rng else None
    return {"n": n, "n_called": len(called),
            "hit_rate": round(sum(1 for r in called if r["listed_up"]) / len(called), 4) if called else None,
            "brier": round(brier, 4) if brier is not None else None, "brier_gmp_only": round(gmp_b, 4),
            "base_rate": round(base, 4), "range_coverage": round(cov, 4) if cov is not None else None,
            "mean_gain": round(sum(r["actual_gain_pct"] for r in rows) / n, 2)}


def calibration(rows: list[dict], width: float = 0.1) -> list[dict]:
    bins = []
    k = int(round(1 / width))
    for i in range(k):
        lo, hi = round(i * width, 2), round((i + 1) * width, 2)
        sel = [r for r in rows if r.get("p_up") is not None and (lo <= r["p_up"] < hi or (i == k - 1 and r["p_up"] == 1.0))]
        if not sel:
            continue
        bins.append({"bin_lo": lo, "bin_hi": hi, "pred_mean": round(sum(r["p_up"] for r in sel) / len(sel), 4),
                     "obs_rate": round(sum(1 for r in sel if r["listed_up"]) / len(sel), 4), "n": len(sel)})
    return bins


def outcomes_index(history: list[dict], live: dict | None) -> dict[str, dict]:
    idx: dict[str, dict] = {}
    for r in list(history) + list((live or {}).get("ipos", [])):
        lst = r.get("listing") or {}
        if lst.get("gain_pct") is None or not r.get("id"):
            continue
        for k in {r["id"], *(r.get("aliases") or [])}:
            idx.setdefault(k, r)
    return idx


def build_track_record(preds: dict, history: list[dict], live: dict | None, params: dict, max_rows: int = 600) -> dict:
    idx = outcomes_index(history, live)
    rows = []
    for p in preds.get("rows", []):
        o = None
        for k in (p["id"], *(p.get("aliases") or [])):
            o = idx.get(k)
            if o:
                break
        if not o:
            continue
        lst = o.get("listing") or {}
        gain = _f(lst.get("gain_pct"))
        if gain is None:
            continue
        rows.append({"id": p["id"], "name": p.get("name"), "board": p.get("board") or o.get("board"),
                     "listing_date": o.get("listing_date"), "lock_stage": p.get("lock_stage"),
                     "p_up": p.get("p_up"), "verdict_tier": p.get("verdict_tier"),
                     "gain_p50": p.get("gain_p50"), "gain_p10": p.get("gain_p10"), "gain_p90": p.get("gain_p90"),
                     "actual_gain_pct": round(gain, 2), "gain_basis": lst.get("gain_basis"), "listed_up": gain > 0})
    rows.sort(key=lambda r: (str(r.get("listing_date") or ""), r["id"]), reverse=True)
    by_verdict = {}
    for t in TIERS:
        sel = [r for r in rows if r["verdict_tier"] == t]
        if not sel and t == "nodata":
            continue
        gains = [r["actual_gain_pct"] for r in sel]
        by_verdict[t] = {"n": len(sel), "n_up": sum(1 for r in sel if r["listed_up"]),
                         "mean_gain": round(sum(gains) / len(gains), 2) if gains else None,
                         "median_gain": round(_median(gains), 2) if gains else None}
    overall = _summary(rows, params)
    genuine = [r for r in rows if r["lock_stage"] in GENUINE]
    return {
        "generated_at": _now(),
        "started": preds.get("started") or SHIP_DATE,
        "n": len(rows),
        "n_locked": len(genuine),
        "n_backfill": sum(1 for r in rows if r["lock_stage"] == "backfill"),
        "n_pending": sum(1 for p in preds.get("rows", []) if not any(k in idx for k in (p["id"], *(p.get("aliases") or [])))),
        "hit_rate": overall["hit_rate"],
        "by_verdict": by_verdict,
        "brier": overall["brier"],
        "brier_gmp_only": overall["brier_gmp_only"],
        "base_rate": overall["base_rate"],
        "range_coverage": overall["range_coverage"],
        "calibration": calibration(rows),
        "by_board": {b: _summary([r for r in rows if r["board"] == b], params) for b in ("mainboard", "sme")},
        "locked_only": _summary(genuine, params),
        "notes": ("'close' and 'pre_listing' rows were locked before the listing and never changed. 'backfill' rows "
                  "were scored afterwards by the current model on the pre-listing inputs in history.json, so they are "
                  "hindsight, not a forecast record; locked_only holds the genuine numbers. brier_gmp_only scores the "
                  "naive forecast 'share of past listings in the same GMP bucket that rose'."),
        "rows": rows[:max_rows],
    }


def _load(path: str, default):
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _dump(path: str, obj, indent=None) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=indent, separators=(",", ":") if indent is None else None)
        f.write("\n")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Lock predictions and rebuild the track record.")
    ap.add_argument("--scored", default="data/scored.json")
    ap.add_argument("--history", default="data/history.json")
    ap.add_argument("--params", default="model/params.json")
    ap.add_argument("--predictions", default="data/predictions.json")
    ap.add_argument("--out", default="data/track_record.json")
    ap.add_argument("--today", default=None)
    ap.add_argument("--no-backfill", action="store_true")
    a = ap.parse_args(argv)
    live = _load(a.scored, {"ipos": []})
    hist = _load(a.history, {"rows": []})
    hist_rows = hist["rows"] if isinstance(hist, dict) else hist
    params = _load(a.params, {})
    today = a.today or (live.get("generated_at") or "")[:10] or date.today().isoformat()
    preds = _load(a.predictions, {"generated_at": None, "started": SHIP_DATE, "rows": []})
    preds, n_live = lock_live(preds, live, params, today)
    n_back = 0
    if not a.no_backfill:
        preds, n_back = backfill(preds, hist_rows, params, today)
    _dump(a.predictions, preds, indent=0)
    tr = build_track_record(preds, hist_rows, live, params)
    _dump(a.out, tr, indent=0)
    lo = tr["locked_only"]
    print(f"ledger {len(preds['rows'])} rows (+{n_live} locked, +{n_back} backfill); track record n={tr['n']} "
          f"(locked {tr['n_locked']}, backfill {tr['n_backfill']}), hit rate {tr['hit_rate']}, brier {tr['brier']} "
          f"vs GMP-only {tr['brier_gmp_only']}; locked-only n={lo['n']} brier {lo['brier']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
