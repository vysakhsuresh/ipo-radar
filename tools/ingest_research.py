#!/usr/bin/env python3
"""Turn researcher output (the ROWS schema used by the research workflow) into the
canonical data files, merging with what is already there.

  python tools/ingest_research.py sweep1.json [more.json ...] --today 2026-10-26

Rules:
  * rows are keyed by slug(name, year of listing/open date); a later file wins
    for any field it actually has (None never overwrites a value)
  * listing gain is close vs issue price when the close is known, otherwise the
    debut (open) price, flagged `gain_basis: "open"` so the model can discount it
  * status is derived from dates and --today, never trusted from the source
  * the pipeline file keeps not-yet-listed issues plus listings of the last 30
    days; the history file keeps every listed issue with an outcome, forever
"""
import argparse
import json
import os
import sys
from datetime import date, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from fetch.common import load_json, dump_json  # noqa: E402
from fetch.normalize import (FIELDS_DIRECT, to_date, derive_status, merge, canonical_row)  # noqa: E402,F401


def canonical(r: dict, today: date, as_of: str | None) -> dict:
    """Research row -> IPO object. Thin wrapper over fetch.normalize.canonical_row
    with the historical default of "mainboard" when the row names no board."""
    return canonical_row(r, today, as_of, default_board="mainboard")


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--today", default=date.today().isoformat())
    ap.add_argument("--data", default=os.path.join(ROOT, "data"))
    a = ap.parse_args(argv)
    today = date.fromisoformat(a.today)

    ipos_path, hist_path = os.path.join(a.data, "ipos.json"), os.path.join(a.data, "history.json")
    live = load_json(ipos_path, {"generated_at": None, "market": {}, "sources": [], "ipos": []})
    hist = load_json(hist_path, {"generated_at": None, "rows": []})
    pool = {r["id"]: r for r in live["ipos"]}
    for r in hist["rows"]:
        pool[r["id"]] = merge(pool.get(r["id"], {}), r)

    n_in = 0
    for f in a.files:
        blob = json.load(open(f, encoding="utf-8"))
        groups = blob.values() if isinstance(blob, dict) and "rows" not in blob else [blob]
        for g in groups:
            as_of = g.get("as_of") or a.today
            for r in g.get("rows", []):
                if not r.get("name"):
                    continue
                c = canonical(r, today, as_of)
                pool[c["id"]] = merge(pool.get(c["id"], {}), c)
                n_in += 1
    # re-derive status for everything with today's date
    for r in pool.values():
        r["status"] = derive_status(r, today)
    cutoff = (today - timedelta(days=30)).isoformat()

    def junk(r: dict) -> bool:
        """A name with nothing usable, or a 'closed' issue so old it must have listed by now."""
        g = r.get("gmp") or {}
        if r.get("issue_price") is None and g.get("rs") is None and not r.get("listing") and not r.get("open_date"):
            return True
        cd = to_date(r.get("close_date"))
        if r["status"] == "closed" and cd and (today - cd).days > 15 and not r.get("listing"):
            return True
        return False

    pipeline = [r for r in pool.values() if not junk(r) and (r["status"] != "listed" or (r.get("listing_date") or "0000") >= cutoff)]
    history = [r for r in pool.values() if r["status"] == "listed" and r.get("listing") and r["listing"].get("gain_pct") is not None]
    pipeline.sort(key=lambda r: (r.get("listing_date") or r.get("close_date") or "9999", r["name"]))
    history.sort(key=lambda r: (r.get("listing_date") or "0000", r["name"]))
    live["ipos"] = pipeline
    live["generated_at"] = live.get("generated_at") or (a.today + "T00:00:00Z")
    hist["rows"] = history
    hist["generated_at"] = a.today + "T00:00:00Z"
    dump_json(ipos_path, live)
    dump_json(hist_path, hist)
    print(f"ingested {n_in} rows → pipeline {len(pipeline)} (not listed: {sum(1 for r in pipeline if r['status'] != 'listed')}), history {len(history)} with outcomes")


if __name__ == "__main__":
    main()
