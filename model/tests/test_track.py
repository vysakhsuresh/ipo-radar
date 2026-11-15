"""Prediction ledger (append-only) and track record; data health checks."""
from __future__ import annotations

import copy
import json
import os
from datetime import datetime, timezone

from model import track, health
from model.calibrate import prior_params

HERE = os.path.dirname(os.path.abspath(__file__))


def params():
    return prior_params([])


def ipo(id_, status, **kw):
    base = {"id": id_, "name": id_.title(), "board": "mainboard", "status": status, "issue_price": 100.0, "lot_size": 150,
            "open_date": "2026-11-10", "close_date": "2026-11-12", "listing_date": "2026-11-17",
            "gmp": {"rs": 20.0, "as_of": "2026-11-12", "history": []},
            "subscription": {"qib": 50.0, "nii": 30.0, "retail": 10.0, "total": 30.0}}
    base.update(kw)
    return base


def test_closed_issue_is_locked_once_and_never_rewritten():
    p = params()
    live = {"generated_at": "2026-11-13T05:00:00Z", "ipos": [ipo("alpha-2026", "closed"), ipo("beta-2026", "open"), ipo("gamma-2026", "upcoming")]}
    ledger, n = track.lock_live({"rows": []}, live, p, "2026-11-13")
    assert n == 1 and ledger["rows"][0]["id"] == "alpha-2026" and ledger["rows"][0]["lock_stage"] == "close"
    row = ledger["rows"][0]
    for k in ("p_up", "gain_p10", "gain_p50", "gain_p90", "verdict_tier", "verdict_label", "gmp_pct", "sub_total", "sub_retail", "model_status", "locked_at"):
        assert k in row
    frozen = copy.deepcopy(ledger["rows"])

    # later the same IPO lists with very different inputs, and a fresh model: the locked row must not move
    live2 = {"generated_at": "2026-11-18T05:00:00Z", "ipos": [ipo("alpha-2026", "listed", gmp={"rs": -50.0, "as_of": "2026-11-17"},
                                                                  listing={"close": 80, "gain_pct": -20.0})]}
    ledger2, n2 = track.lock_live(ledger, live2, dict(p, status="calibrated"), "2026-11-18")
    ledger3, n3 = track.backfill(ledger2, live2["ipos"], p, "2026-11-18")
    assert n2 == 0 and n3 == 0 and ledger3["rows"] == frozen

    # merge_ledger refuses a conflicting row, by id or alias
    forged = dict(frozen[0], p_up=0.01)
    assert track.merge_ledger(ledger3, [forged])["rows"] == frozen
    assert track.merge_ledger(ledger3, [dict(forged, id="new-id", aliases=["alpha-2026"])])["rows"] == frozen


def test_listed_issue_locks_pre_listing_only_after_ship_date():
    p = params()
    old = ipo("old-2026", "listed", listing_date="2026-11-01", listing={"close": 110, "gain_pct": 10.0})
    new = ipo("new-2026", "listed", listing_date="2026-11-17", listing={"close": 110, "gain_pct": 10.0})
    ledger, n = track.lock_live({"rows": []}, {"ipos": [old, new]}, p, "2026-11-18", ship_date="2026-11-15")
    assert [r["id"] for r in ledger["rows"]] == ["new-2026"] and ledger["rows"][0]["lock_stage"] == "pre_listing"


def test_backfill_is_marked_and_uses_pre_listing_inputs_only():
    p = params()
    h = ipo("hist-2025", "listed", close_date="2025-06-10", listing_date="2025-06-13",
            gmp={"rs": 40.0, "as_of": "2025-06-13", "history": [{"date": "2025-06-09", "rs": 15.0}, {"date": "2025-06-12", "rs": 40.0}]},
            listing={"open": 130, "close": 125, "gain_pct": 25.0, "gain_basis": "close"})
    ledger, n = track.backfill({"rows": []}, [h], p, "2026-11-15")
    assert n == 1 and ledger["rows"][0]["lock_stage"] == "backfill"
    assert ledger["rows"][0]["gmp_pct"] == 15.0          # the quote dated after bidding closed is not used
    view = track.pre_listing_view(h)
    assert "listing" not in view and view["status"] == "closed"


def test_track_record_metrics():
    p = params()
    rows = [
        {"id": "a", "name": "A", "board": "mainboard", "lock_stage": "close", "p_up": 0.9, "gain_p10": 0, "gain_p50": 20, "gain_p90": 40, "verdict_tier": "apply", "gmp_pct": 25},
        {"id": "b", "name": "B", "board": "mainboard", "lock_stage": "close", "p_up": 0.7, "gain_p10": -5, "gain_p50": 5, "gain_p90": 15, "verdict_tier": "lean", "gmp_pct": 8},
        {"id": "c", "name": "C", "board": "sme", "lock_stage": "backfill", "p_up": 0.3, "gain_p10": -20, "gain_p50": -2, "gain_p90": 10, "verdict_tier": "avoid", "gmp_pct": 0},
        {"id": "d", "name": "D", "board": "mainboard", "lock_stage": "close", "p_up": 0.5, "gain_p10": -5, "gain_p50": 1, "gain_p90": 9, "verdict_tier": "coinflip", "gmp_pct": 3},
    ]
    hist = [{"id": "a", "listing_date": "2026-11-20", "listing": {"gain_pct": 30.0}},
            {"id": "b", "listing_date": "2026-11-19", "listing": {"gain_pct": -6.0}},
            {"id": "c", "listing_date": "2026-11-18", "listing": {"gain_pct": -10.0}}]
    tr = track.build_track_record({"rows": rows}, hist, None, p)
    assert tr["n"] == 3 and tr["n_locked"] == 2 and tr["n_backfill"] == 1 and tr["n_pending"] == 1
    assert tr["hit_rate"] == 0.5                                    # apply A up, lean B down
    assert tr["by_verdict"]["apply"] == {"n": 1, "n_up": 1, "mean_gain": 30.0, "median_gain": 30.0}
    assert tr["by_verdict"]["avoid"]["n"] == 1 and tr["by_verdict"]["watch"]["n"] == 0
    assert round(tr["brier"], 4) == round(((0.9 - 1) ** 2 + (0.7 - 0) ** 2 + (0.3 - 0) ** 2) / 3, 4)
    assert tr["base_rate"] == round(1 / 3, 4) and tr["range_coverage"] == round(2 / 3, 4)
    assert [r["id"] for r in tr["rows"]] == ["a", "b", "c"]          # newest first
    assert tr["by_board"]["sme"]["n"] == 1 and tr["locked_only"]["n"] == 2
    assert sum(b["n"] for b in tr["calibration"]) == 3
    assert len(json.dumps(tr)) < 300_000


# --------------------------------------------------------------- health ---

def test_health_checks_flag_bad_rows_and_stale_sources():
    now = datetime(2026, 11, 15, 12, 0, tzinfo=timezone.utc)
    live = {"ipos": [
        ipo("bad-2026", "closed", gmp={"rs": 400.0}, open_date="2026-11-12", close_date="2026-11-10", listing_date="2026-11-09",
            price_band_low=90.0, price_band_high=95.0),
        ipo("sme-2026", "closed", board="sme", min_lots=1, subscription={"qib": 2.0, "total": 3.0}),
        ipo("ok-2026", "upcoming", board="mainboard", min_lots=1),
    ], "source_status": {
        "nse": {"ok": True, "last_ok_at": "2026-11-15T11:00:00Z", "rows": 120, "typical_rows": 110},
        "ipowatch": {"ok": False, "last_ok_at": "2026-11-13T11:00:00Z", "rows": 0, "typical_rows": 4},
        "chittorgarh": {"ok": False, "last_ok_at": "2026-11-15T09:00:00Z", "rows": 0, "typical_rows": 100},
    }}
    prev = {"ipos": [ipo("sme-2026", "closed", board="sme", subscription={"qib": 5.0, "total": 3.0})]}
    h = health.check(live, prev, now)
    codes = {(i["ipo_id"], i["code"]) for i in h["issues"]}
    assert ("bad-2026", "gmp_implausible") in codes and ("bad-2026", "open_after_close") in codes
    assert ("bad-2026", "listing_before_close") in codes and ("bad-2026", "price_outside_band") in codes
    assert ("sme-2026", "sme_min_lots") in codes and ("sme-2026", "subscription_decreased") in codes
    assert (None, "source_stale") in codes and (None, "source_empty") in codes
    assert h["ok"] is False and live["ipos"][2]["health_flags"] == []
    assert "gmp_implausible" in live["ipos"][0]["health_flags"]
    assert {s["name"] for s in h["sources"]} == {"nse", "ipowatch", "chittorgarh"}
    assert all(i["msg"] and i["level"] in ("warn", "error") for i in h["issues"])
