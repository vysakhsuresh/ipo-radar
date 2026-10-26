"""Fit the listing-gain model on data/history.json and write model/params.json.

Two models, both small and explainable:
  * logistic:  P(listing-day close > issue price)
  * ridge:     expected listing-day gain %, with residual quantiles per board
               so the page can show a P10–P90 range instead of a false point

Plus an *empirical* table: for each GMP% bucket × board, how many past IPOs
listed up and the median gain. The page shows it beside the model as a sanity
check a reader can verify by hand.

Honesty rules:
  * every reported metric is out-of-fold (5-fold CV), never in-sample
  * the number of rows per board and the date range go into params.json and
    onto the page, so nobody mistakes a 120-row fit for a law of nature
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
from datetime import datetime, timezone

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from model.features import FEATURE_NAMES, features, vector, gmp_pct_of  # noqa: E402
from model.fit import (fit_logistic, fit_ridge, cv_logistic, cv_ridge, brier, auc,  # noqa: E402
                       log_loss, reliability, expected_calibration_error, predict_ridge)
from model.prior import (PRIOR_LOGISTIC_RAW, PRIOR_GAIN_RAW, PRIOR_RESID, MIN_ROWS_TO_CALIBRATE)  # noqa: E402

GMP_BUCKETS = [(-1e9, 0.0, "GMP ≤ 0%"), (0.0, 5.0, "0–5%"), (5.0, 10.0, "5–10%"), (10.0, 20.0, "10–20%"),
               (20.0, 40.0, "20–40%"), (40.0, 1e9, "> 40%")]


def usable(row: dict) -> bool:
    lst = row.get("listing") or {}
    return row.get("issue_price") not in (None, 0) and lst.get("gain_pct") is not None


def informative(row: dict) -> bool:
    """Has at least one model input (a GMP quote or a subscription figure).
    Outcome-only rows (a name and a listing gain from a year-end roundup) feed
    the base rates and the empirical table, but fitting on them would only
    teach the model that 'the researcher found no GMP' predicts something."""
    g = row.get("gmp") or {}
    sub = row.get("subscription") or {}
    return (g.get("rs") is not None or g.get("pct") is not None
            or any(sub.get(k) is not None for k in ("qib", "nii", "retail", "total")))


def build_matrix(rows: list[dict]):
    X = np.array([vector(features(r)) for r in rows], dtype=float)
    y_up = np.array([1.0 if (r["listing"]["gain_pct"] or 0) > 0 else 0.0 for r in rows])
    y_gain = np.array([float(r["listing"]["gain_pct"]) for r in rows])
    return X, y_up, y_gain


def standardise(X: np.ndarray):
    mean = X.mean(axis=0)
    scale = X.std(axis=0)
    scale[scale < 1e-6] = 1.0      # a (near-)constant column keeps its raw scale
    return (X - mean) / scale, mean, scale


def _clean(obj):
    """NaN/inf are not JSON; the page reads this file in JavaScript."""
    if isinstance(obj, float):
        return None if (math.isnan(obj) or math.isinf(obj)) else obj
    if isinstance(obj, dict):
        return {k: _clean(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_clean(v) for v in obj]
    return obj


def empirical_table(rows: list[dict]) -> list[dict]:
    out = []
    for board in ("mainboard", "sme"):
        for lo, hi, label in GMP_BUCKETS:
            sel = []
            for r in rows:
                if r.get("board") != board:
                    continue
                g = gmp_pct_of(r)
                if g is None:
                    continue
                if lo <= g < hi:
                    sel.append(float(r["listing"]["gain_pct"]))
            if not sel:
                out.append({"board": board, "bucket": label, "lo": lo, "hi": hi, "n": 0})
                continue
            arr = np.array(sel)
            out.append({"board": board, "bucket": label, "lo": lo, "hi": hi, "n": int(len(arr)),
                        "n_up": int((arr > 0).sum()), "p_up": float((arr > 0).mean()),
                        "median_gain": float(np.median(arr)), "p10_gain": float(np.percentile(arr, 10)),
                        "p90_gain": float(np.percentile(arr, 90)), "mean_gain": float(arr.mean())})
    # rows with no GMP at all
    for board in ("mainboard", "sme"):
        sel = [float(r["listing"]["gain_pct"]) for r in rows if r.get("board") == board and gmp_pct_of(r) is None]
        if sel:
            arr = np.array(sel)
            out.append({"board": board, "bucket": "no GMP quote", "lo": None, "hi": None, "n": int(len(arr)),
                        "n_up": int((arr > 0).sum()), "p_up": float((arr > 0).mean()),
                        "median_gain": float(np.median(arr)), "p10_gain": float(np.percentile(arr, 10)),
                        "p90_gain": float(np.percentile(arr, 90)), "mean_gain": float(arr.mean())})
    return out


def choose_l2(X, y, prior, grid=(10.0, 30.0, 100.0, 300.0, 1000.0)) -> float:
    """Floor of 10 (prior sd ≈ 0.3 per standardised coefficient): with a few hundred
    rows the data can move a weight, with 120 it mostly cannot."""
    best, best_ll = grid[0], float("inf")
    for l2 in grid:
        oof = cv_logistic(X, y, l2, prior=prior)
        ll = log_loss(oof, y)
        if ll < best_ll:
            best, best_ll = l2, ll
    return best


def choose_l2_ridge(X, y, prior, grid=(100.0, 300.0, 1000.0, 3000.0)) -> float:
    best, best_mse = grid[0], float("inf")
    for l2 in grid:
        oof = cv_ridge(X, y, l2, prior=prior)
        mse = float(np.mean((oof - y) ** 2))
        if mse < best_mse:
            best, best_mse = l2, mse
    return best


def raw_to_std(raw: dict, mean: np.ndarray, scale: np.ndarray) -> np.ndarray:
    """Convert raw-scale coefficients to the standardised space used for fitting:
    w_std_i = w_raw_i * scale_i ;  b_std = b_raw + Σ w_raw_i * mean_i."""
    w = np.array([raw[f] for f in FEATURE_NAMES], dtype=float)
    return np.concatenate([w * scale, [raw["intercept"] + float(w @ mean)]])


def prior_params(rows: list[dict]) -> dict:
    """params.json built from the prior alone (plus whatever empirical table the rows allow)."""
    k = len(FEATURE_NAMES)
    mean, scale = np.zeros(k), np.ones(k)
    lg = raw_to_std(PRIOR_LOGISTIC_RAW, mean, scale)
    gn = raw_to_std(PRIOR_GAIN_RAW, mean, scale)
    dates = sorted(r.get("listing_date") for r in rows if r.get("listing_date"))
    boards = np.array([r.get("board") for r in rows]) if rows else np.array([])
    y_up = np.array([1.0 if (r["listing"]["gain_pct"] or 0) > 0 else 0.0 for r in rows]) if rows else np.array([])
    y_gain = np.array([float(r["listing"]["gain_pct"]) for r in rows]) if rows else np.array([])
    base_rate = {board: {"n": int((boards == board).sum()) if rows else 0,
                         "p_up": float(y_up[boards == board].mean()) if rows and (boards == board).sum() else None,
                         "median_gain": float(np.median(y_gain[boards == board])) if rows and (boards == board).sum() else None}
                 for board in ("mainboard", "sme")}
    return {
        "version": 1, "status": "prior",
        "fitted_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "feature_names": FEATURE_NAMES, "n_rows": int(len(rows)),
        "min_rows_to_calibrate": MIN_ROWS_TO_CALIBRATE,
        "date_range": [dates[0] if dates else None, dates[-1] if dates else None],
        "base_rate": base_rate,
        "logistic": {"coef": lg[:-1].tolist(), "intercept": float(lg[-1]), "mean": mean.tolist(), "scale": scale.tolist(), "l2": None},
        "gain": {"coef": gn[:-1].tolist(), "intercept": float(gn[-1]), "l2": None, "resid_quantiles": PRIOR_RESID},
        "metrics": None,
        "empirical": empirical_table(rows),
        "coef_table": [{"feature": f, "coef_std": float(PRIOR_LOGISTIC_RAW[f]), "coef_raw": float(PRIOR_LOGISTIC_RAW[f])} for f in FEATURE_NAMES],
        "prior": {"logistic_raw": PRIOR_LOGISTIC_RAW, "gain_raw": PRIOR_GAIN_RAW},
    }


def basis_counts(rows: list[dict]) -> dict:
    out = {"close": 0, "open": 0, "reported": 0}
    for r in rows:
        b = (r.get("listing") or {}).get("gain_basis") or "close"
        out[b if b in out else "reported"] += 1
    return out


def calibrate(rows: list[dict]) -> dict:
    all_rows = [r for r in rows if usable(r)]
    rows = [r for r in all_rows if informative(r)]
    bc = basis_counts(rows)
    # debut-price gains (SME rows where no close was found) do not count toward
    # the threshold: the model's target is the listing-day close
    if bc["close"] + bc["reported"] < MIN_ROWS_TO_CALIBRATE:
        out = prior_params(all_rows)
        out["n_rows_informative"] = len(rows)
        out["basis_counts"] = bc
        return _clean(out)
    X, y_up, y_gain = build_matrix(rows)
    Xs, mean, scale = standardise(X)
    prior_lg = raw_to_std(PRIOR_LOGISTIC_RAW, mean, scale)
    prior_gn = raw_to_std(PRIOR_GAIN_RAW, mean, scale)

    l2 = choose_l2(Xs, y_up, prior_lg)
    coef, b = fit_logistic(Xs, y_up, l2=l2, prior=prior_lg)
    oof = cv_logistic(Xs, y_up, l2, prior=prior_lg)

    l2g = choose_l2_ridge(Xs, y_gain, prior_gn)
    gcoef, gb = fit_ridge(Xs, y_gain, l2=l2g, prior=prior_gn)
    oofg = cv_ridge(Xs, y_gain, l2g, prior=prior_gn)
    resid = y_gain - oofg
    boards = np.array([r.get("board") for r in rows])
    resid_q = {}
    for board in ("mainboard", "sme"):
        m = boards == board
        if m.sum() >= 15:
            rq = resid[m]
            resid_q[board] = {"p10": float(np.percentile(rq, 10)), "p25": float(np.percentile(rq, 25)),
                              "p50": float(np.percentile(rq, 50)), "p75": float(np.percentile(rq, 75)),
                              "p90": float(np.percentile(rq, 90)), "n": int(m.sum())}
        else:
            resid_q[board] = dict(PRIOR_RESID[board], n=int(m.sum()))

    dates = sorted(r.get("listing_date") for r in rows if r.get("listing_date"))
    base_rate = {board: {"n": int((boards == board).sum()),
                         "p_up": float(y_up[boards == board].mean()) if (boards == board).sum() else None,
                         "median_gain": float(np.median(y_gain[boards == board])) if (boards == board).sum() else None}
                 for board in ("mainboard", "sme")}
    naive_brier = float(np.mean((y_up.mean() - y_up) ** 2))

    return {
        "version": 1, "status": "calibrated",
        "fitted_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "feature_names": FEATURE_NAMES,
        "n_rows": int(len(rows)),
        "min_rows_to_calibrate": MIN_ROWS_TO_CALIBRATE,
        "date_range": [dates[0] if dates else None, dates[-1] if dates else None],
        "base_rate": base_rate,
        "logistic": {"coef": coef.tolist(), "intercept": float(b), "mean": mean.tolist(), "scale": scale.tolist(), "l2": l2},
        "gain": {"coef": gcoef.tolist(), "intercept": float(gb), "l2": l2g, "resid_quantiles": resid_q},
        "metrics": {
            "cv_folds": 5,
            "auc": auc(oof, y_up), "brier": brier(oof, y_up), "brier_naive": naive_brier,
            "log_loss": log_loss(oof, y_up), "ece": expected_calibration_error(oof, y_up),
            "reliability": reliability(oof, y_up, 8),
            "gain_mae": float(np.mean(np.abs(resid))), "gain_rmse": float(math.sqrt(np.mean(resid ** 2))),
            "gain_mae_naive": float(np.mean(np.abs(y_gain - np.median(y_gain)))),
        },
        "empirical": empirical_table(rows),
        "coef_table": [{"feature": f, "coef_std": float(c), "coef_raw": float(c / s)}
                       for f, c, s in zip(FEATURE_NAMES, coef, scale)],
        "prior": {"logistic_raw": PRIOR_LOGISTIC_RAW, "gain_raw": PRIOR_GAIN_RAW},
        "basis_counts": bc,
        "n_rows_informative": len(rows),
        "n_rows_all": len(all_rows),
    }


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--history", default="data/history.json")
    ap.add_argument("--out", default="model/params.json")
    a = ap.parse_args(argv)
    with open(a.history, encoding="utf-8") as f:
        hist = json.load(f)
    rows = hist["rows"] if isinstance(hist, dict) else hist
    params = _clean(calibrate(rows))
    os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(params, f, indent=1)
        f.write("\n")
    m = params["metrics"]
    if m is None:
        print(f"PRIOR weights written: {params['n_rows']} listings with outcomes, "
              f"{params.get('n_rows_informative', 0)} with GMP or subscription data "
              f"(need {MIN_ROWS_TO_CALIBRATE} close-basis informative rows to calibrate)")
    else:
        print(f"fitted on {params['n_rows']} rows {params['date_range']}; CV AUC {m['auc']:.3f}, "
              f"Brier {m['brier']:.3f} (naive {m['brier_naive']:.3f}), ECE {m['ece']:.3f}, "
              f"gain MAE {m['gain_mae']:.1f}pp (naive {m['gain_mae_naive']:.1f}pp)")


if __name__ == "__main__":
    main()
