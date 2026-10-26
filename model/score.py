"""Score the live pipeline: probability of a listing gain, the likely gain
range, allotment odds, expected value after costs, and a plain-language
verdict with the warnings that should stop someone from gambling.

KEEP THE MATH IN LOCK-STEP WITH site/app.js (`scoreIpo`). The parity test
runs both on the same rows and compares every number.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
from datetime import date

ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from model.features import FEATURE_NAMES, features, vector, gmp_pct_of, gmp_trend_of, gmp_history_of, _f  # noqa: E402
from model.rules import CostConfig, expected_value_of_application, retail_lots_affordable  # noqa: E402

TIERS = {
    "apply":    {"label": "Apply",            "order": 0},
    "lean":     {"label": "Lean apply",       "order": 1},
    "coinflip": {"label": "Coin flip",        "order": 2},
    "avoid":    {"label": "Avoid",            "order": 3},
    "watch":    {"label": "Too early",        "order": 4},
    "nodata":   {"label": "Not enough data",  "order": 5},
}


def _r1(v: float) -> str:
    """One-decimal text, rounding half up, identical to score.js's r1()."""
    return f"{math.floor(v * 10 + 0.5) / 10:.1f}"


def _sigmoid(z: float) -> float:
    return 1.0 / (1.0 + math.exp(-z))


def _std(vec: list[float], params: dict) -> list[float]:
    lg = params["logistic"]
    return [(v - m) / s for v, m, s in zip(vec, lg["mean"], lg["scale"])]


def model_outputs(ipo: dict, params: dict, market: dict | None) -> tuple[float, dict, dict]:
    feat = features(ipo, market)
    xs = _std(vector(feat), params)
    lg, gn = params["logistic"], params["gain"]
    z = lg["intercept"] + sum(c * x for c, x in zip(lg["coef"], xs))
    p_up = _sigmoid(z)
    mean_gain = gn["intercept"] + sum(c * x for c, x in zip(gn["coef"], xs))
    board = "sme" if ipo.get("board") == "sme" else "mainboard"
    rq = gn["resid_quantiles"].get(board) or gn["resid_quantiles"]["mainboard"]
    gain = {"mean": mean_gain, "p10": mean_gain + rq["p10"], "p25": mean_gain + rq["p25"],
            "p50": mean_gain + rq["p50"], "p75": mean_gain + rq["p75"], "p90": mean_gain + rq["p90"]}
    return p_up, gain, feat


def similar_past(ipo: dict, params: dict) -> dict | None:
    g = gmp_pct_of(ipo)
    board = "sme" if ipo.get("board") == "sme" else "mainboard"
    for row in params.get("empirical", []):
        if row["board"] != board or row.get("n", 0) == 0:
            continue
        if g is None:
            if row["bucket"] == "no GMP quote":
                return row
            continue
        if row.get("lo") is None:
            continue
        if row["lo"] <= g < row["hi"]:
            return row
    return None


def gmp_is_unquoted(ipo: dict) -> bool:
    """GMP trackers print Rs 0 for small SME issues nobody quotes. An isolated
    zero with no non-zero quote in its history is 'no quote', not 'expects a
    discount', whatever the issue's status (so a row reads the same before and
    after it closes)."""
    g = ipo.get("gmp") or {}
    hist = gmp_history_of(ipo)
    nonzero = [h for h in hist if h["rs"] != 0]
    rs = _f(g.get("rs"))
    return (ipo.get("board") == "sme" and rs is not None and rs == 0 and not nonzero and len(hist) <= 2)


def data_quality(ipo: dict, today: str) -> tuple[str, list[str]]:
    """How much should anyone trust this row? Returns (confidence, flags)."""
    flags = list(ipo.get("flags") or [])
    sub = ipo.get("subscription") or {}
    gmp = ipo.get("gmp") or {}
    status = ipo.get("status")
    if gmp_is_unquoted(ipo):
        ipo = dict(ipo, gmp=dict(gmp, rs=None, pct=None))
        gmp = ipo["gmp"]
        flags.append("gmp_unquoted")
    has_sub = any(sub.get(k) is not None for k in ("qib", "nii", "retail", "total"))
    has_gmp = gmp_pct_of(ipo) is not None
    if gmp.get("as_of") and today and ISO_DATE.match(str(gmp["as_of"])) and ISO_DATE.match(str(today)):
        try:
            age = (date.fromisoformat(today) - date.fromisoformat(gmp["as_of"])).days
            if age >= 3:
                flags.append("gmp_stale")
        except ValueError:
            pass
    if not has_gmp and not has_sub:
        return "none", flags + ["no_gmp_no_sub"]
    if status == "closed" and has_sub and has_gmp:
        return "high", flags
    if status == "open" and has_sub:
        return "medium", flags + ["sub_partial"]
    if has_gmp and not has_sub:
        return "low", flags + ["gmp_only"]
    return "medium", flags


def verdict(ipo: dict, p_up: float | None, gain: dict | None, ev: dict, confidence: str, flags: list[str],
            feat: dict | None) -> dict:
    """Deterministic, explainable. Every rule names its reason so the page can show it."""
    reasons: list[str] = []
    warnings: list[str] = []
    sub = ipo.get("subscription") or {}
    qib_v, nii_v, ret_v, tot_v = _f(sub.get("qib")), _f(sub.get("nii")), _f(sub.get("retail")), _f(sub.get("total"))
    board = ipo.get("board")
    g = gmp_pct_of(ipo)
    trend = gmp_trend_of(ipo)
    size = _f(ipo.get("issue_size_cr"))
    status = ipo.get("status")
    live = status in ("open", "closed")          # figures mean something once bidding has started
    sofar = " so far" if status == "open" else ""

    if p_up is None or confidence == "none":
        return {"tier": "nodata", "label": TIERS["nodata"]["label"], "reasons": ["No GMP quote and no subscription figures yet."],
                "warnings": warnings, "gamble": None}

    # --- hard warnings: each one is a reason to stop and think ---
    if g is not None and g <= 0:
        warnings.append("GMP is zero or negative: the grey market expects a flat or discount listing.")
    elif g is not None and g < 5:
        warnings.append("GMP under 5%: thin cushion; a weak market on listing day wipes it out.")
    if trend is not None and g is not None and trend <= -0.4 * max(g - trend, 1):
        warnings.append("GMP has fallen sharply over the last few sessions.")
    if live and ret_v is not None and ret_v < 1:
        warnings.append(f"Retail portion under-subscribed{sofar}: weak demand, and everyone who bids gets allotted in full.")
    if live and qib_v is not None and qib_v < 1:
        warnings.append(f"QIBs (institutions) have not filled their quota{sofar}" + (" (they usually bid on the last day)." if status == "open" else ": the smart money passed."))
    if board == "sme":
        warnings.append("SME issue: thin liquidity, 5% circuit on listing day, lot of ₹2 lakh or more, and a wider spread of outcomes than mainboard.")
        if tot_v is not None and tot_v < 10 and status == "closed":
            warnings.append("SME with under 10x total subscription: historically the riskiest bucket.")
    if (status == "closed" and qib_v is not None and qib_v >= 20
            and ((nii_v is not None and nii_v < 2) or (ret_v is not None and ret_v < 2))):
        warnings.append("Institution-only demand: QIBs piled in but HNIs or retail stayed under 2x. Thin day-one buying is a classic flat-listing setup.")
    if "gmp_stale" in flags and status != "listed":
        warnings.append("GMP quote is 3+ days old; check a fresh one before applying.")
    if size is not None and size < 50:
        warnings.append("Very small issue (under ₹50 crore): a few operators can move both the GMP and the listing price.")
    ofs, fresh = _f(ipo.get("ofs_cr")), _f(ipo.get("fresh_issue_cr"))
    if ofs and (fresh is not None) and (ofs + fresh) > 0 and ofs / (ofs + fresh) > 0.85:
        reasons.append("Almost entirely an offer for sale: promoters and investors are cashing out, no fresh money goes into the company.")

    # --- supporting reasons ---
    if g is not None:
        reasons.append(f"GMP {'+' if g >= 0 else '-'}{_r1(abs(g))}% of the issue price.")
    if qib_v is not None or nii_v is not None or ret_v is not None:
        fx = lambda v: "–" if v is None else _r1(v)  # noqa: E731
        reasons.append(f"QIB {fx(qib_v)}x, NII {fx(nii_v)}x, retail {fx(ret_v)}x" + (" (final)" if status in ("closed", "listed") else " (so far)"))
    if confidence == "low":
        reasons.append("No subscription figures were captured for this issue; the read rests on the GMP alone." if status in ("closed", "listed")
                       else "Only a GMP quote so far; subscription figures will sharpen this.")
    if status == "open" and confidence == "medium":
        reasons.append("Bidding is still on: QIB and HNI books usually fill on the last day.")

    # --- tier ---
    hard = len([w for w in warnings if not w.startswith("SME issue")])
    evv = ev.get("ev")
    ev_ok = True if evv is None else evv > 0      # unknown allotment odds are neutral, not a veto
    if p_up >= 0.75 and (gain or {}).get("p50", 0) >= 5 and ev_ok and hard == 0:
        tier = "apply"
    elif p_up >= 0.6 and ev_ok and hard <= 1:
        tier = "lean"
    elif p_up >= 0.4 and (evv is None or evv > -1):
        tier = "coinflip"
    else:
        tier = "avoid"
    if hard >= 2 and tier in ("apply", "lean"):
        tier = "coinflip"
    if g is not None and g <= 0 and tier in ("apply", "lean"):
        tier = "coinflip"                         # a discount GMP is never an apply
    early = confidence == "low" or (status == "open" and confidence == "medium")
    if early and status != "closed":
        # before the books are final an early lean is useful, a verdict is not
        if tier == "apply":
            tier = "lean"
        elif tier in ("coinflip", "avoid") and not (g is not None and g <= 0):
            tier = "watch"
    if status == "listed":
        warnings = []                             # it has listed; nothing left to warn about

    # --- is it a gamble? ---
    gamble = None
    if tier == "avoid":
        gamble = "sure"
    elif tier == "coinflip" or hard >= 1:
        gamble = "possible"
    if board == "sme" and tier != "apply":
        gamble = gamble or "possible"
    if tier == "watch" and gamble == "sure":
        gamble = "possible"
    return {"tier": tier, "label": TIERS[tier]["label"], "reasons": reasons, "warnings": warnings, "gamble": gamble}


def score_ipo(ipo: dict, params: dict, market: dict | None = None, cfg: CostConfig | None = None,
              today: str | None = None) -> dict:
    cfg = cfg or CostConfig()
    today = today or date.today().isoformat()
    confidence, flags = data_quality(ipo, today)
    if "gmp_unquoted" in flags:
        ipo = dict(ipo, gmp=dict(ipo.get("gmp") or {}, rs=None, pct=None))
    price, lot = ipo.get("issue_price"), ipo.get("lot_size")
    sub = ipo.get("subscription") or {}
    p_up = gain = feat = None
    if confidence != "none":
        p_up, gain, feat = model_outputs(ipo, params, market)
    price, lot = _f(price), _f(lot)
    if price and lot:
        min_lots = int(_f(ipo.get("min_lots")) or (2 if ipo.get("board") == "sme" else 1))
        ret = _f(sub.get("retail"))
        if ret is None and _f(sub.get("total")) is not None:
            ret = _f(sub.get("total"))            # only an overall multiple: use it as the retail stand-in
        ev = expected_value_of_application(price, lot, ret, p_up, gain, cfg, min_lots=min_lots,
                                           status=ipo.get("status") or "closed")
        if ret is not None and _f(sub.get("retail")) is None and ev["allotment"].get("p_min_lot") is not None:
            ev["allotment"]["basis"] += " (overall multiple used; retail figure missing)"
        ev["lots_affordable"] = retail_lots_affordable(int(lot), float(price), min_lots)
        ev["min_lots"] = min_lots
    else:
        ev = {"ev": None, "ev_if_allotted": None, "downside_if_allotted": None, "allotment": {"p_min_lot": None, "basis": "price or lot unknown"}}
    sim = similar_past(ipo, params)
    v = verdict(ipo, p_up, gain, ev, confidence, flags, feat)
    return {"p_up": p_up, "gain": gain, "similar": sim, "allotment": ev.get("allotment"),
            "ev": {k: ev.get(k) for k in ("ev", "ev_if_allotted", "downside_if_allotted", "invested_if_allotted", "lots_affordable", "min_lots")},
            "verdict": v, "confidence": confidence, "flags": sorted(set(flags)), "features": feat}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--ipos", default="data/ipos.json")
    ap.add_argument("--params", default="model/params.json")
    ap.add_argument("--out", default="data/scored.json")
    a = ap.parse_args(argv)
    with open(a.ipos, encoding="utf-8") as f:
        live = json.load(f)
    with open(a.params, encoding="utf-8") as f:
        params = json.load(f)
    today = (live.get("generated_at") or "")[:10] or None
    bad = 0
    for ipo in live["ipos"]:
        try:
            ipo["score"] = score_ipo(ipo, params, live.get("market"), today=today)
        except Exception as e:  # noqa: BLE001 - one malformed row must not abort the refresh
            bad += 1
            ipo["score"] = {"p_up": None, "gain": None, "similar": None, "allotment": {"p_min_lot": None, "basis": "row could not be scored"},
                            "ev": {"ev": None, "ev_if_allotted": None, "downside_if_allotted": None, "invested_if_allotted": None, "lots_affordable": None, "min_lots": None},
                            "verdict": {"tier": "nodata", "label": TIERS["nodata"]["label"], "reasons": [f"Could not score this row ({type(e).__name__})."], "warnings": [], "gamble": None},
                            "confidence": "none", "flags": ["score_error"], "features": None}
    if bad:
        print(f"warning: {bad} row(s) could not be scored; marked 'not enough data'")
    live["scored_with"] = {"fitted_at": params.get("fitted_at"), "n_rows": params.get("n_rows")}
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(live, f, ensure_ascii=False, indent=1)
        f.write("\n")
    tiers = {}
    for ipo in live["ipos"]:
        tiers[ipo["score"]["verdict"]["tier"]] = tiers.get(ipo["score"]["verdict"]["tier"], 0) + 1
    print(f"scored {len(live['ipos'])} IPOs: {tiers}")


if __name__ == "__main__":
    main()
