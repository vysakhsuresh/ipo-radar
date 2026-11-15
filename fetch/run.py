"""Refresh data/ipos.json (the live pipeline) and data/history.json.

  python -m fetch.run --out data [--today YYYY-MM-DD] [--no-cache]
                      [--build-history --history-years 2024,2025,2026]

Every source runs inside try/except: a site that is down costs its rows, not
the run, and shows up as ok=false in the `sources` list of ipos.json. The
process exits 0 even on partial failure (the workflow also sets
continue-on-error) and prints one summary line.

Merge precedence (fetch/normalize.merge: later wins, None never wins):
  * dates, price band, lot size, issue size, subscription: NSE (the exchange)
    over the Chittorgarh list, over InvestorGain
  * GMP: InvestorGain over Chittorgarh (NSE has none, so it never clobbers)
  * listing outcome: the Chittorgarh performance tracker over anything else
GMP history accrues across runs: the previous ipos.json is the starting pool,
dated series from the trackers are unioned by date, and today's quote is
appended under its as_of date (`accrue_gmp_history`).

Pipeline = not-yet-listed issues + listings of the last 30 days. Every listed
row with an outcome also goes into history.json (append-only, merged by id).
A previous row that no source mentioned this run and that has no dates at all
is dropped (a withdrawn GMP-only entry); everything else ages out by status.
"""
from __future__ import annotations

import argparse
import os
import sys
import traceback
from datetime import date, timedelta
from typing import Any, Callable

from fetch.common import Http, Provenance, dump_json, load_json, now_iso, slugify, today as today_iso
from fetch.normalize import (canonical_row, finalise_row, merge, derive_status, accrue_gmp_history,
                             subscription_day, quality_flags, within_days, strip_empty_groups, junk_reason, clean_name, year_for,
                             dedupe, resolve_board, infer_board, gmp_consensus, fill_timeline, registrar_info, to_date,
                             NSE_HOLIDAYS)
from fetch.sources import chittorgarh, investorgain, ipowatch, market, nse
from fetch import history as history_mod

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PIPELINE_DAYS = 30
SourceFn = Callable[[Http, date], list[dict]]

# Lowest to highest priority per field group; a source not named ranks lowest.
PRECEDENCE: dict[str, tuple[str, ...]] = {
    "gmp": ("ipowatch", "chittorgarh", "investorgain"),
    "subscription": ("investorgain", "chittorgarh", "nse"),
    "listing": ("investorgain", "nse", "chittorgarh", "chittorgarh_tracker"),
    "issue_size_cr": ("nse", "investorgain", "chittorgarh"),   # NSE gives a share count, the aggregators give rupees
    "*": ("ipowatch", "investorgain", "chittorgarh", "chittorgarh_tracker", "nse"),
}
GROUPED = tuple(k for k in PRECEDENCE if k != "*")


def default_sources() -> list[tuple[str, SourceFn]]:
    return [
        ("nse", nse.fetch),
        ("chittorgarh", chittorgarh.fetch),
        ("chittorgarh_tracker", lambda http, today: chittorgarh.fetch_trackers(http, chittorgarh.tracker_years(today), today)),
        ("investorgain", investorgain.fetch),
        ("ipowatch", ipowatch.fetch),
    ]


POST_LISTING_DAYS = 200
POST_LISTING_MAX_FETCH = 60
IPO_SOURCES = ("nse", "chittorgarh", "chittorgarh_tracker", "investorgain", "ipowatch")


def gmp_quotes(partials: list[tuple[str, dict]]) -> list[dict]:
    """Each source's GMP quote in a group of partial rows: [{source, rs, as_of, url}]."""
    out = []
    for src, p in partials:
        g = p.get("gmp") or {}
        if g.get("rs") is None:
            continue
        url = (p.get("sources") or {}).get("gmp") or (p.get("sources") or {}).get("gmp_history") or (p.get("sources") or {}).get("name")
        out.append({"source": src, "rs": g.get("rs"), "as_of": g.get("as_of"), "url": url})
    return out


def regroup(pool: dict[str, dict], partials: dict[str, list[tuple[str, dict]]]) -> tuple[dict[str, dict], dict[str, list[tuple[str, dict]]], dict[str, str]]:
    """Merge ids that name the same IPO ('Zetwerk', 'Zetwerk Manufacturing Business Ltd',
    'Zetwerk Manufacturing Businesses Limited') across the previous pool and this run's
    partial rows. Returns the re-keyed pool and partials and the alias map."""
    reps: dict[str, dict] = {rid: dict(r) for rid, r in pool.items()}
    for rid, parts in partials.items():
        m: dict = dict(reps.get(rid) or {})
        for _src, p in parts:
            m = merge(m, {k: v for k, v in p.items() if k not in ("sources",)})
        m["id"] = rid
        reps[rid] = m
    _rows, alias = dedupe(list(reps.values()))
    new_pool: dict[str, dict] = {}
    for rid in sorted(pool, key=lambda i: len(pool[i])):
        k = alias.get(rid, rid)
        row = dict(pool[rid], id=k)
        new_pool[k] = merge(new_pool[k], row) if k in new_pool else row
    for old, k in alias.items():
        if k in new_pool:
            new_pool[k]["aliases"] = sorted(set(new_pool[k].get("aliases") or []) | {old})
    new_parts: dict[str, list[tuple[str, dict]]] = {}
    for rid, parts in partials.items():
        k = alias.get(rid, rid)
        new_parts.setdefault(k, []).extend((src, dict(p, id=k)) for src, p in parts)
        if k != rid:
            new_pool.setdefault(k, {"id": k})
            new_pool[k]["aliases"] = sorted(set(new_pool[k].get("aliases") or []) | {rid})
    return new_pool, new_parts, alias


def update_source_status(prev: dict, summary_sources: dict, now: str) -> dict:
    """{name: {ok, last_ok_at, rows, typical_rows, last_note}} carried across runs, so the
    health check can tell a source that has been silent for a day from one blip."""
    out = {k: dict(v) for k, v in (prev or {}).items() if isinstance(v, dict)}
    for name, v in summary_sources.items():
        st = out.get(name, {"ok": False, "last_ok_at": None, "rows": 0, "typical_rows": None})
        st["ok"] = bool(v.get("ok"))
        st["rows"] = int(v.get("rows") or 0)
        st["last_note"] = v.get("note") or ""
        st["checked_at"] = now
        if st["ok"]:
            st["last_ok_at"] = now
            t = st.get("typical_rows")
            st["typical_rows"] = st["rows"] if not t else round(0.8 * t + 0.2 * st["rows"], 1)
        out[name] = st
    return out


def canonical_pool(rows: list[dict], today: date) -> dict[str, dict]:
    """Key stored rows by the id their cleaned name gives today, merging rows that an older
    id rule kept apart ('Foo & Bar' next to 'Foo and Bar Ltd. (Foo and Bar IPO)')."""
    pool: dict[str, dict] = {}
    for r in rows:
        if not r.get("id"):
            continue
        name = clean_name(r.get("name") or r["id"])
        nid = slugify(name, year_for(r, today)) if name else r["id"]
        row = dict(r, id=nid, name=name or r.get("name"))
        pool[nid] = merge(pool[nid], row) if nid in pool else row
    return pool


def combine(prev: dict, partials: list[tuple[str, dict]]) -> dict:
    """Merge canonical partial rows from several sources onto the previous row, by field group."""
    out = dict(prev)
    for group, order in PRECEDENCE.items():
        rank = {s: i for i, s in enumerate(order)}

        def key(sp: tuple[str, dict]) -> int:
            # an estimated issue size (NSE share count x upper band) never beats a reported one
            if group == "issue_size_cr" and "issue_size_estimated" in (sp[1].get("flags") or []):
                return -2
            return rank.get(sp[0], -1)

        for src, part in sorted(partials, key=key):
            if group == "*":
                piece = {k: v for k, v in part.items() if k not in GROUPED}
            else:
                piece = {group: part.get(group)}
            out = merge(out, piece)
    reported = any(p.get("issue_size_cr") is not None and "issue_size_estimated" not in (p.get("flags") or []) for _, p in partials)
    if reported and "issue_size_estimated" in (out.get("flags") or []):
        out["flags"] = [f for f in out["flags"] if f != "issue_size_estimated"]
    return out


def refresh(out_dir: str, today: date, *, cache: bool = True, sources: list[tuple[str, SourceFn]] | None = None,
            market_fn: Callable[[Http, date], dict] | None = None, build_history: bool = False,
            history_years: list[int] | tuple[int, ...] = (), http: Http | None = None) -> dict[str, Any]:
    """Run the refresh and write the two files. Returns a summary dict (used by main and the tests)."""
    prov = Provenance()
    online = sources is None or http is not None     # injected test sources never trigger extra network calls
    http = http or Http(prov, cache=cache)
    prov = http.prov
    sources = default_sources() if sources is None else sources
    ipos_path, hist_path = os.path.join(out_dir, "ipos.json"), os.path.join(out_dir, "history.json")
    prev = load_json(ipos_path, {"generated_at": None, "market": {}, "sources": [], "ipos": []}) or {}
    hist = load_json(hist_path, {"generated_at": None, "rows": []}) or {}
    pool: dict[str, dict] = canonical_pool(prev.get("ipos", []), today)
    summary: dict[str, Any] = {"today": today.isoformat(), "sources": {}}

    # ---- market backdrop
    market_fn = market_fn or market.fetch
    try:
        mkt = market_fn(http, today) or {}
        if not isinstance(mkt, dict):
            mkt = {}
    except Exception as e:  # noqa: BLE001
        mkt = {}
        prov.add("source:market", False, note=f"{type(e).__name__}: {e}")
    if not mkt or mkt.get("nifty") is None:
        prev_mkt = prev.get("market") or {}
        mkt = {**market.empty(), **{k: v for k, v in prev_mkt.items() if v is not None}, **{k: v for k, v in mkt.items() if v is not None}}
        if prev_mkt:
            prov.add("source:market", False, note="carried forward from previous run")
    summary["market"] = mkt

    # ---- IPO sources
    partials: dict[str, list[tuple[str, dict]]] = {}
    for name, fn in sources:
        try:
            rows = fn(http, today) or []
            n = 0
            for parts in rows:
                try:
                    row = strip_empty_groups(canonical_row(parts, today, as_of=today.isoformat(), default_board=None))
                except Exception as e:  # noqa: BLE001 - one bad row must not sink the source
                    prov.add(f"source:{name}", False, note=f"row skipped: {type(e).__name__}: {e}")
                    continue
                partials.setdefault(row["id"], []).append((name, row))
                n += 1
            # zero rows means every page failed or parsed to nothing: not a success
            prov.add(f"source:{name}", n > 0, rows=n, note="" if n else "no rows")
            summary["sources"][name] = {"ok": n > 0, "rows": n, "note": "" if n else "no rows"}
        except Exception as e:  # noqa: BLE001
            prov.add(f"source:{name}", False, note=f"{type(e).__name__}: {e}")
            summary["sources"][name] = {"ok": False, "rows": 0, "note": f"{type(e).__name__}: {e}"}

    # ---- exchange holidays for the T+3 timetable (non-fatal)
    holidays = set(NSE_HOLIDAYS)
    try:
        if online:
            holidays |= nse.fetch_holidays(http)
    except Exception:  # noqa: BLE001
        pass

    # ---- merge onto the previous pool (same IPO under several names merged first)
    pool, partials, alias = regroup(pool, partials)
    summary["merged_aliases"] = len(alias)
    seen = set(partials)
    dropped: dict[str, int] = {}
    for rid, parts in partials.items():
        prev_board, prev_basis = (pool.get(rid) or {}).get("board"), (pool.get(rid) or {}).get("board_basis")
        row = combine(pool.get(rid, {}), parts)
        board, basis = resolve_board(parts)
        if board:
            row["board"], row["board_basis"] = board, basis
        elif prev_basis == "source" and prev_board:
            row["board"], row["board_basis"] = prev_board, prev_basis
        else:
            row.pop("board", None)
            row.pop("board_basis", None)
        quotes = gmp_quotes(parts)
        finalise_row(row, today)
        gmp_consensus(row, quotes, today)
        pool[rid] = row
    for rid in list(pool):
        row = pool[rid]
        if not row.get("board"):
            guess = infer_board(row)
            row["board"] = guess or "mainboard"
            row["board_basis"] = "inferred" if guess else "default"
            if guess:
                row.setdefault("flags", []).append("board_inferred")
        finalise_row(row, today)
        why = junk_reason(row)
        if why:
            dropped[why] = dropped.get(why, 0) + 1
            del pool[rid]
            continue
        accrue_gmp_history(row)
        if rid in seen:
            day = subscription_day(row)
            if day is not None:
                row["subscription"]["day"] = day
        fill_timeline(row, holidays)
        reg = registrar_info(row.get("registrar"))
        if reg:
            row["registrar"] = reg
        row["flags"] = quality_flags(row, today)
        row["status"] = derive_status(row, today)
    summary["dropped"] = dropped

    # ---- post-listing performance for recent listings (Yahoo; non-fatal, refreshed daily)
    n_pl = 0
    for row in pool.values():
        ld = to_date(row.get("listing_date"))
        if row["status"] != "listed" or not ld or ld < today - timedelta(days=POST_LISTING_DAYS) or not row.get("symbol"):
            continue
        pl = row.get("post_listing") or {}
        if not online or pl.get("checked") == today.isoformat() or n_pl >= POST_LISTING_MAX_FETCH:
            continue
        n_pl += 1
        try:
            got = market.fetch_post_listing(http, row["symbol"], row.get("board"), row.get("listing_date"), row.get("issue_price"), today)
        except Exception:  # noqa: BLE001
            got = None
        if got:
            got["checked"] = today.isoformat()
            row["post_listing"] = got
        elif pl:
            row["post_listing"] = dict(pl, checked=today.isoformat())

    # ---- split pipeline / history
    pipeline = [r for r in pool.values() if r["status"] != "listed" or within_days(r.get("listing_date"), today, PIPELINE_DAYS)]
    outcomes = [r for r in pool.values() if r["status"] == "listed" and r.get("listing") and r["listing"].get("gain_pct") is not None]
    pipeline.sort(key=lambda r: (r.get("listing_date") or r.get("close_date") or "9999", r["name"]))
    hist_rows = [dict(r, aliases=sorted(set(r.get("aliases") or []))) for r in outcomes]
    if build_history:
        years = list(history_years) or [today.year - 2, today.year - 1, today.year]
        log: dict[str, Any] = {}
        try:
            hist_rows += history_mod.build_history(http, years, today, log=log)
        except Exception as e:  # noqa: BLE001
            log["build"] = {"ok": False, "note": f"{type(e).__name__}: {e}"}
        for k, v in log.items():
            prov.add(f"source:{k}", bool(v.get("ok")), rows=int(v.get("rows", 0)), note=str(v.get("note", "")))
        summary["sources"].update(log)
    hist = history_mod.merge_into_history(hist, hist_rows, today)

    # ---- write
    # If no IPO source delivered a single row, the figures are the previous run's:
    # keep its timestamp so the page shows the data as stale instead of fresh.
    any_ipo_source_ok = any(v.get("ok") for k, v in summary["sources"].items() if k in dict(sources))
    generated_at = now_iso() if any_ipo_source_ok else (prev.get("generated_at") or now_iso())
    if not any_ipo_source_ok:
        prov.add("refresh", False, note="no IPO source returned rows; previous snapshot and its timestamp kept")
    status = update_source_status(prev.get("source_status") or {}, {k: v for k, v in summary["sources"].items() if k in dict(sources)}, now_iso())
    live = {"generated_at": generated_at, "market": mkt, "sources": prov.to_json(), "source_status": status, "ipos": pipeline}
    dump_json(ipos_path, live)
    dump_json(hist_path, hist)
    counts = {s: sum(1 for r in pipeline if r["status"] == s) for s in ("upcoming", "open", "closed", "listed")}
    summary.update({"pipeline": len(pipeline), "counts": counts, "history": len(hist["rows"]),
                    "sources_ok": sum(1 for v in summary["sources"].values() if v.get("ok")),
                    "sources_total": len(summary["sources"])})
    return summary


def summary_line(s: dict[str, Any]) -> str:
    c = s.get("counts", {})
    m = s.get("market") or {}
    srcs = ", ".join(f"{k}={'ok' if v.get('ok') else 'FAIL'}:{v.get('rows', 0)}" for k, v in s.get("sources", {}).items())
    return (f"refresh {s.get('today')}: pipeline {s.get('pipeline', 0)} (upcoming {c.get('upcoming', 0)}, open {c.get('open', 0)}, "
            f"closed {c.get('closed', 0)}, listed {c.get('listed', 0)}), history {s.get('history', 0)}, "
            f"nifty {m.get('nifty')} vix {m.get('vix')}, sources {s.get('sources_ok', 0)}/{s.get('sources_total', 0)} ok [{srcs}]")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Refresh the IPO pipeline and history files.")
    ap.add_argument("--out", default=os.path.join(ROOT, "data"))
    ap.add_argument("--today", default=today_iso())
    ap.add_argument("--no-cache", action="store_true")
    ap.add_argument("--build-history", action="store_true", help="also pull the performance trackers for --history-years")
    ap.add_argument("--history-years", default="", help="comma-separated years for --build-history, e.g. 2024,2025,2026")
    a = ap.parse_args(argv)
    today = date.fromisoformat(a.today)
    years = [int(y) for y in a.history_years.split(",") if y.strip()]
    try:
        s = refresh(a.out, today, cache=not a.no_cache, build_history=a.build_history, history_years=years)
        print(summary_line(s))
    except Exception as e:  # noqa: BLE001 - never fail the workflow step
        traceback.print_exc(file=sys.stderr)
        print(f"refresh {today}: FAILED before writing ({type(e).__name__}: {e}); previous data left untouched")
    return 0


if __name__ == "__main__":
    sys.exit(main())
