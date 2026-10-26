"""Build or refresh data/history.json (listed IPOs with outcomes) from the
performance trackers.

  python -m fetch.history --years 2024 2025 2026 [--out data] [--subscriptions]

What each source contributes (structure as understood in Oct 2026, unverified
live; see the per-source docstrings):

  * Chittorgarh performance trackers (mainboard id 21, SME id 23, ?year=YYYY):
    issue price, listing open / close, listing gain, listing date, exchange.
    They carry NO GMP column.
  * InvestorGain GMP-performance report (URL unverified): the last PRE-LISTING
    GMP per IPO plus the listing price / gain. THIS IS THE VALUABLE COLUMN: the
    model is calibrated on "GMP the day before listing -> listing-day gain",
    so a history row without a pre-listing GMP only trains the subscription
    and size features. If that report cannot be fetched, GMP history still
    accrues the honest way: every routine refresh (fetch/run.py) stores the
    current GMP quote in data/ipos.json, and when the issue lists, the row
    (with its last quote and dated series) moves into history.json. So after
    a few months of scheduled runs the recent history is complete even if no
    tracker ever gives a GMP.
  * Chittorgarh per-IPO subscription pages (--subscriptions; one request per
    IPO, slow): final QIB / NII / bNII / sNII / retail / employee / total.

Rows are keyed by slug (fetch/normalize.row_id) and merged into the existing
history.json: a value from a tracker overwrites an older value, None never does,
and a GMP that is already there is never erased. Exit status is 0 even when a
source fails; the summary line says how many rows each source gave.
"""
from __future__ import annotations

import argparse
import os
import sys
from datetime import date
from typing import Any, Callable

from fetch.common import Http, Provenance, dump_json, load_json, now_iso, today as today_iso
from fetch.normalize import canonical_row, finalise_row, merge, row_id
from fetch.sources import chittorgarh, investorgain

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _safe(name: str, fn: Callable[[], list[dict]], log: dict[str, Any]) -> list[dict]:
    try:
        rows = fn()
        log[name] = {"ok": True, "rows": len(rows)}
        return rows
    except Exception as e:  # noqa: BLE001 - one source must not abort the build
        log[name] = {"ok": False, "rows": 0, "note": f"{type(e).__name__}: {e}"}
        return []


def build_history(http: Http, years: list[int] | tuple[int, ...], today: date,
                  with_subscription: bool = False, log: dict[str, Any] | None = None) -> list[dict]:
    """Canonical rows (only those with a listing outcome) for the given tracker years."""
    log = {} if log is None else log
    perf = _safe("investorgain_gmp_performance", lambda: investorgain.fetch_gmp_performance(http, today, years), log)
    trackers = _safe("chittorgarh_trackers", lambda: chittorgarh.fetch_trackers(http, years, today), log)
    pool: dict[str, dict] = {}
    urls: dict[str, str] = {}
    # GMP-performance first, trackers second: the tracker's open/close wins for the outcome,
    # while its (absent) GMP cannot erase the pre-listing quote.
    for parts in perf + trackers:
        rid = row_id(parts, today)
        if parts.get("ipo_url"):
            urls[rid] = parts["ipo_url"]
        row = canonical_row(parts, today, as_of=None, default_board=None)
        pool[rid] = merge(pool[rid], row) if rid in pool else row
    if with_subscription:
        for rid, row in pool.items():
            sub = row.get("subscription") or {}
            url = chittorgarh.subscription_url(urls.get(rid))
            if not url or any(sub.get(k) is not None for k in ("qib", "nii", "retail", "total")):
                continue
            html = http.get_html(url)
            got = chittorgarh.parse_subscription(html, url, today) if html else None
            if got:
                row["subscription"] = {**sub, **got}
                row.setdefault("sources", {})["subscription"] = url
    out = []
    for row in pool.values():
        row.setdefault("board", "mainboard")
        finalise_row(row, today)
        if row.get("listing") and row["listing"].get("gain_pct") is not None:
            out.append(row)
    out.sort(key=lambda r: (r.get("listing_date") or "0000", r["name"]))
    return out


def merge_into_history(hist: dict, rows: list[dict], today: date) -> dict:
    by_id = {r["id"]: r for r in hist.get("rows", []) if r.get("id")}
    for r in rows:
        by_id[r["id"]] = finalise_row(merge(by_id.get(r["id"], {}), r), today)
    out = [r for r in by_id.values() if r.get("listing") and r["listing"].get("gain_pct") is not None]
    out.sort(key=lambda r: (r.get("listing_date") or "0000", r["name"]))
    return {"generated_at": now_iso(), "rows": out}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--years", nargs="+", type=int, default=None, help="tracker years, default: last three")
    ap.add_argument("--out", default=os.path.join(ROOT, "data"))
    ap.add_argument("--today", default=today_iso())
    ap.add_argument("--no-cache", action="store_true")
    ap.add_argument("--subscriptions", action="store_true", help="also fetch final subscription per IPO (slow)")
    a = ap.parse_args(argv)
    today = date.fromisoformat(a.today)
    years = a.years or [today.year - 2, today.year - 1, today.year]
    prov = Provenance()
    http = Http(prov, cache=not a.no_cache)
    log: dict[str, Any] = {}
    path = os.path.join(a.out, "history.json")
    hist = load_json(path, {"generated_at": None, "rows": []})
    before = len(hist.get("rows", []))
    try:
        rows = build_history(http, years, today, with_subscription=a.subscriptions, log=log)
        hist = merge_into_history(hist, rows, today)
        dump_json(path, hist)
    except Exception as e:  # noqa: BLE001
        log["build"] = {"ok": False, "note": f"{type(e).__name__}: {e}"}
        rows = []
    with_gmp = sum(1 for r in hist.get("rows", []) if (r.get("gmp") or {}).get("rs") is not None)
    src = ", ".join(f"{k} {'ok' if v.get('ok') else 'FAIL'} {v.get('rows', 0)}" for k, v in log.items())
    print(f"history {today}: years {years} -> {len(rows)} rows with outcomes, history.json {before} -> {len(hist.get('rows', []))} "
          f"({with_gmp} with a GMP); sources: {src}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
