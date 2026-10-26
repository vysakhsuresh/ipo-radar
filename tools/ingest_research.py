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
from fetch.common import slugify, load_json, dump_json  # noqa: E402
from model.rules import min_lots_for  # noqa: E402

FIELDS_DIRECT = ["name", "board", "exchange", "open_date", "close_date", "allotment_date", "listing_date",
                 "price_band_low", "price_band_high", "issue_price", "lot_size", "issue_size_cr",
                 "fresh_issue_cr", "ofs_cr", "sector", "pe_post_issue", "lead_managers", "anchor_cr", "notes"]


def to_date(s):
    if not s or not isinstance(s, str) or len(s) < 10:
        return None
    try:
        return date.fromisoformat(s[:10])
    except ValueError:
        return None


def derive_status(row: dict, today: date) -> str:
    ld, cd, od = to_date(row.get("listing_date")), to_date(row.get("close_date")), to_date(row.get("open_date"))
    lst = row.get("listing") or {}
    if (ld and ld <= today) or lst.get("open") is not None or lst.get("close") is not None:
        return "listed"
    if cd and cd < today:
        return "closed"
    if od and od <= today and (cd is None or cd >= today):
        return "open"
    return "upcoming"


def canonical(r: dict, today: date, as_of: str | None) -> dict:
    year = None
    for k in ("listing_date", "open_date", "close_date"):
        d = to_date(r.get(k))
        if d:
            year = d.year
            break
    out = {"id": slugify(r["name"], year or today.year)}
    for k in FIELDS_DIRECT:
        v = r.get(k)
        if v not in (None, "", []):
            out[k] = v
    out["board"] = "sme" if str(r.get("board", "")).lower().startswith("sme") else "mainboard"
    if out.get("issue_price") is None and r.get("price_band_high") is not None:
        out["issue_price"] = r["price_band_high"]
        out.setdefault("flags", []).append("price_band_only")
    # gmp
    hist = []
    for h in r.get("gmp_history") or []:
        if h.get("gmp_rs") is not None and h.get("date"):
            hist.append({"date": h["date"][:10], "rs": float(h["gmp_rs"])})
    hist.sort(key=lambda h: h["date"])
    gmp = {"rs": r.get("gmp_rs"), "pct": r.get("gmp_pct"), "as_of": (hist[-1]["date"] if hist else as_of), "history": hist}
    if gmp["rs"] is None and hist:
        gmp["rs"] = hist[-1]["rs"]
    if gmp["pct"] is None and gmp["rs"] is not None and out.get("issue_price"):
        gmp["pct"] = round(100.0 * gmp["rs"] / out["issue_price"], 2)
    out["gmp"] = gmp
    # subscription
    sub = {k: r.get("sub_" + k) for k in ("qib", "nii", "bnii", "snii", "retail", "employee", "total")}
    sub["as_of"] = as_of
    sub["day"] = None
    out["subscription"] = sub
    # listing
    lo, lc = r.get("listing_open"), r.get("listing_close")
    gain = r.get("listing_gain_pct")
    basis = None
    if out.get("issue_price"):
        if lc is not None:
            gain = round(100.0 * (lc - out["issue_price"]) / out["issue_price"], 2)
            basis = "close"
        elif lo is not None:
            gain = round(100.0 * (lo - out["issue_price"]) / out["issue_price"], 2)
            basis = "open"
        elif gain is not None:
            basis = "reported"
    if lo is not None or lc is not None or gain is not None:
        out["listing"] = {"open": lo, "close": lc, "high": None, "low": None, "gain_pct": gain, "gain_basis": basis}
    else:
        out["listing"] = None
    out["status"] = derive_status(out, today)
    out["min_lots"] = min_lots_for(out["board"])
    if out.get("lot_size") and out.get("issue_price"):
        out["min_investment"] = out["min_lots"] * out["lot_size"] * out["issue_price"]
    # sources
    srcs = {}
    for i, u in enumerate(r.get("source_urls") or []):
        if isinstance(u, str) and u.startswith("http"):
            srcs["ref%d" % (i + 1)] = u
    out["sources"] = srcs
    out["flags"] = sorted(set(out.get("flags", [])))
    return out


def merge(old: dict, new: dict) -> dict:
    out = dict(old)
    for k, v in new.items():
        if k in ("gmp", "subscription", "listing", "sources"):
            if v is None:
                continue
            base = dict(old.get(k) or {})
            for kk, vv in v.items():
                if kk == "history":
                    seen = {h["date"]: h for h in (base.get("history") or [])}
                    for h in vv:
                        seen[h["date"]] = h
                    base["history"] = sorted(seen.values(), key=lambda h: h["date"])
                elif vv is not None:
                    base[kk] = vv
            out[k] = base
        elif k == "flags":
            out[k] = sorted(set(old.get("flags", [])) | set(v))
        elif v is not None:
            out[k] = v
    return out


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
    pipeline = [r for r in pool.values() if r["status"] != "listed" or (r.get("listing_date") or "0000") >= cutoff]
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
