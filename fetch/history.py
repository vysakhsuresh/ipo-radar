"""Build or refresh data/history.json (listed IPOs with outcomes) from the
performance trackers, then fill in the pre-listing inputs the model needs.

  python -m fetch.history --years 2024 2025 2026 [--out data] [--no-pages] [--no-gmp] [--no-yahoo]

What each step contributes (structure as seen live on 2026-11-15):

  * Chittorgarh performance trackers (report 236, mainboard and SME), read from
    the JSON endpoint behind the page (`chittorgarh.api_tables`; the current
    year comes whole, earlier years five rows a page): issue price, listing date,
    listing-day CLOSE and gain, issue size, NSE symbol, the IPO page URL.
  * InvestorGain GMP-performance report (URL unverified; ignored when it 404s).
  * --pages (default on): each IPO's Chittorgarh page: bidding dates, final
    category-wise subscription (QIB / NII / bNII / sNII / retail or "Individual
    Investors" / employee / total), lot, board ("Listing At"), fresh/OFS split,
    registrar, listing-day open/close. One request per IPO; cached.
  * --gmp (default on): InvestorGain's dated GMP series for each IPO (matched
    through the site's own URL list by name and bidding dates). The row's GMP
    is the last quote dated BEFORE the listing day, never a post-listing one.
  * --yahoo (default on): the listing-day open and close from Yahoo's daily
    chart for rows that only have a debut (open) price.

Nothing is invented: a step that fails or finds nothing leaves the field empty.
Rows are keyed by slug and merged into history.json (a value from a source
overwrites an older value, None never does; a GMP already there is kept unless
a dated pre-listing series replaces it); rows naming the same IPO are merged.
Exit status is 0 even when a source fails; the summary line says what each gave.
"""
from __future__ import annotations

import argparse
import os
import sys
from datetime import date, timedelta
from typing import Any, Callable

from fetch.common import Http, Provenance, dump_json, load_json, now_iso, today as today_iso
from fetch.normalize import (canonical_row, finalise_row, merge, row_id, dedupe, name_key, to_date, junk_reason,
                             registrar_info, SUB_KEYS)
from fetch.sources import chittorgarh, investorgain, market

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


HISTORY_DROP = ("about", "post_listing", "health_flags", "score")


def compact_for_history(r: dict) -> dict:
    """history.json is downloaded by the app, so keep it lean: one `sources` entry per
    distinct URL (the first field that came from it) and no prose / live-only fields."""
    for k in HISTORY_DROP:
        r.pop(k, None)
    srcs = r.get("sources") or {}
    seen: set = set()
    slim = {}
    for k, u in srcs.items():
        if u in seen:
            continue
        seen.add(u)
        slim[k] = u
    r["sources"] = slim
    return r


def merge_into_history(hist: dict, rows: list[dict], today: date) -> dict:
    by_id = {r["id"]: r for r in hist.get("rows", []) if r.get("id")}
    for r in rows:
        by_id[r["id"]] = finalise_row(merge(by_id.get(r["id"], {}), r), today)
    merged, _alias = dedupe(list(by_id.values()))
    out = []
    for r in merged:
        finalise_row(r, today)
        compact_for_history(r)
        if not (r.get("listing") and r["listing"].get("gain_pct") is not None):
            continue
        if junk_reason(r) in ("non-equity security type", "non-equity name", "non-equity symbol", "price is a debt face value",
                              "listing long after close (migration or relisting)"):
            continue
        out.append(r)
    out.sort(key=lambda r: (r.get("listing_date") or "0000", r["name"]))
    return {"generated_at": now_iso(), "rows": out}


# ------------------------------------------------------------- enrichment ---

def _has_sub(r: dict) -> bool:
    s = r.get("subscription") or {}
    return any(s.get(k) is not None for k in ("qib", "nii", "retail"))


def enrich_from_pages(http: Http, rows: list[dict], today: date, limit: int = 2000) -> int:
    """Fill bidding dates, final subscription, lot, board and facts from each IPO's Chittorgarh page."""
    n = 0
    for r in rows:
        url = r.get("ipo_url") or next((u for u in (r.get("sources") or {}).values()
                                        if isinstance(u, str) and "chittorgarh.com/ipo/" in u), None)
        if not url or n >= limit:
            continue
        if _has_sub(r) and r.get("close_date") and r.get("lot_size") and r.get("registrar"):
            continue
        n += 1
        try:
            got = chittorgarh.parse_ipo_page(http.get_html(url), url, today)
        except Exception as e:  # noqa: BLE001
            http.prov.add(url, False, note=f"{type(e).__name__}: {e}")
            continue
        if not got:
            continue
        r["ipo_url"] = url
        page_listing = got.pop("listing", None) or {}
        got.pop("name", None)
        srcs = got.pop("sources", {}) or {}
        sub = got.pop("subscription", None)
        for k, v in got.items():
            if v is None:
                continue
            if k in ("issue_price",) and r.get(k):
                continue                      # the tracker's final price stays
            if k == "listing_date" and r.get(k):
                continue
            r[k] = v
        if sub and not _has_sub(r):
            r["subscription"] = {**(r.get("subscription") or {}), **sub}
            r.setdefault("sources", {})["subscription"] = url
        lst = dict(r.get("listing") or {})
        if lst.get("open") is None and page_listing.get("open") is not None:
            lst["open"] = page_listing["open"]
        if lst.get("close") is None and page_listing.get("close") is not None:
            lst["close"] = page_listing["close"]
        for k in ("high", "low"):
            if lst.get(k) is None and page_listing.get(k) is not None:
                lst[k] = page_listing[k]
        if lst:
            r["listing"] = lst
        reg = registrar_info(r.get("registrar"))
        if reg:
            r["registrar"] = reg
        r.setdefault("sources", {}).update({k: v for k, v in srcs.items() if k not in (r.get("sources") or {})})
        finalise_row(r, today)
    return n


def _match_gmp_url(r: dict, index: list[dict]) -> str | None:
    if r.get("gmp_url"):
        return r["gmp_url"]
    key = name_key(r.get("name"))
    if not key:
        return None
    first = key.split()[0]
    od, cd = r.get("open_date"), r.get("close_date")
    best = None
    for it in index:
        k2 = name_key(it.get("name"))
        if not k2:
            continue
        same_dates = (od and it.get("open_date") == od) or (cd and it.get("close_date") == cd)
        if k2 == key and (same_dates or not (od or cd)):
            return it["url"]
        if same_dates and (k2.split()[0] == first or key.startswith(k2) or k2.startswith(key)):
            best = best or it["url"]
    return best


def enrich_gmp(http: Http, rows: list[dict], today: date, limit: int = 2000) -> int:
    """Attach InvestorGain's dated GMP series and set the row's GMP to the last quote before listing."""
    index = investorgain.gmp_url_index(http)
    if not index:
        return 0
    n = 0
    for r in rows:
        ld = to_date(r.get("listing_date"))
        if not ld or n >= limit:
            continue
        g = r.get("gmp") or {}
        if len(g.get("history") or []) >= 2 and g.get("rs") is not None:
            continue
        url = _match_gmp_url(r, index)
        if not url:
            continue
        n += 1
        hist = investorgain.gmp_history(http, url, ld)
        pre = [h for h in hist if h["date"] < ld.isoformat()]
        if not pre:
            continue
        price = r.get("issue_price")
        last = pre[-1]
        r["gmp"] = {**g, "history": pre, "rs": last["rs"], "as_of": last["date"],
                    "pct": round(100.0 * last["rs"] / price, 2) if price else None}
        r["gmp_url"] = url
        r.setdefault("sources", {})["gmp_history"] = url
        r.setdefault("flags", [])
        r["flags"] = sorted(set(r["flags"]) | {"gmp_pre_listing"})
    return n


def enrich_nse_categories(http: Http, rows: list[dict], today: date, limit: int = 2000) -> int:
    """Category-wise final subscription (QIB / NII / bNII / sNII / retail) from NSE's
    ipo-detail for listings whose Chittorgarh page shows only the total (it hides the
    split for older issues). NSE's SME books carry no 'offered' figure, so in practice
    this fills main-board rows."""
    from fetch.sources import nse
    n = 0
    warmed = False
    for r in rows:
        s = r.get("subscription") or {}
        if not r.get("symbol") or s.get("qib") is not None or n >= limit:
            continue
        if not warmed:
            nse.warm_up(http)
            warmed = True
        n += 1
        series = "SME" if r.get("board") == "sme" else "EQ"
        url = nse.URL_DETAIL.format(symbol=r["symbol"], series=series)
        try:
            cats = nse.parse_categories(http.get_json(url, headers=nse.HEADERS, retries=1) or {})
        except Exception:  # noqa: BLE001
            continue
        cats = {k: v for k, v in cats.items() if v is not None}
        if cats.get("qib") is None or cats.get("total") is None:
            continue
        r["subscription"] = {**s, **{k: v for k, v in cats.items() if k != "total" or s.get("total") is None},
                             "as_of": s.get("as_of") or r.get("close_date")}
        r.setdefault("sources", {})["subscription_categories"] = url
        finalise_row(r, today)
    return n


def drop_post_listing_gmp(rows: list[dict]) -> int:
    """A GMP stamped on or after the listing day is not a pre-listing input. Use the last
    dated quote before listing when there is one; otherwise flag the row so the
    quote's timing is known to be uncertain."""
    n = 0
    for r in rows:
        g, ld = r.get("gmp") or {}, r.get("listing_date")
        if g.get("rs") is None or not ld or not g.get("as_of") or str(g["as_of"]) < ld:
            continue
        pre = [h for h in (g.get("history") or []) if h.get("date") and h["date"] < ld]
        if pre:
            price = r.get("issue_price")
            r["gmp"] = {**g, "rs": pre[-1]["rs"], "as_of": pre[-1]["date"],
                        "pct": round(100.0 * pre[-1]["rs"] / price, 2) if price else g.get("pct")}
        else:
            r["flags"] = sorted(set(r.get("flags") or []) | {"gmp_date_unknown"})
        n += 1
    return n


def enrich_yahoo(http: Http, rows: list[dict], today: date, limit: int = 2000) -> int:
    """Listing-day open and close from Yahoo for rows with only a debut price (or none)."""
    n = 0
    for r in rows:
        lst = r.get("listing") or {}
        if lst.get("close") is not None or not r.get("symbol") or n >= limit:
            continue
        n += 1
        try:
            got = market.fetch_post_listing(http, r["symbol"], r.get("board"), r.get("listing_date"), r.get("issue_price"),
                                            min(today, (to_date(r.get("listing_date")) or today) + timedelta(days=10)))
        except Exception:  # noqa: BLE001
            got = None
        if not got or got.get("listing_close") is None:
            continue
        lst = dict(lst)
        lst["close"] = got["listing_close"]
        if lst.get("open") is None:
            lst["open"] = got.get("listing_open")
        r["listing"] = lst
        r.setdefault("sources", {})["listing_close"] = "https://finance.yahoo.com/quote/" + got.get("ticker", "")
        finalise_row(r, today)
    return n


def gating_count(rows: list[dict]) -> dict:
    """How many rows the calibration threshold counts (same rule as model/calibrate.py)."""
    def informative(r):
        g, s = r.get("gmp") or {}, r.get("subscription") or {}
        return g.get("rs") is not None or g.get("pct") is not None or any(s.get(k) is not None for k in ("qib", "nii", "retail", "total"))
    usable = [r for r in rows if r.get("issue_price") and (r.get("listing") or {}).get("gain_pct") is not None]
    inf = [r for r in usable if informative(r)]
    gating = [r for r in inf if ((r.get("listing") or {}).get("gain_basis") or "close") in ("close", "reported")]
    return {"usable": len(usable), "informative": len(inf), "gating": len(gating)}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--years", nargs="+", type=int, default=None, help="tracker years, default: last three")
    ap.add_argument("--out", default=os.path.join(ROOT, "data"))
    ap.add_argument("--today", default=today_iso())
    ap.add_argument("--no-cache", action="store_true")
    ap.add_argument("--subscriptions", action="store_true", help="(legacy) per-IPO subscription pages; --pages covers it")
    ap.add_argument("--no-pages", action="store_true", help="skip the per-IPO Chittorgarh pages")
    ap.add_argument("--no-gmp", action="store_true", help="skip the per-IPO InvestorGain GMP series")
    ap.add_argument("--no-yahoo", action="store_true", help="skip Yahoo listing-day closes")
    ap.add_argument("--no-nse", action="store_true", help="skip NSE category-wise subscription")
    ap.add_argument("--limit", type=int, default=2000, help="max requests per enrichment step")
    a = ap.parse_args(argv)
    today = date.fromisoformat(a.today)
    years = a.years or [today.year - 2, today.year - 1, today.year]
    prov = Provenance()
    http = Http(prov, cache=not a.no_cache)
    log: dict[str, Any] = {}
    path = os.path.join(a.out, "history.json")
    hist = load_json(path, {"generated_at": None, "rows": []})
    before = len(hist.get("rows", []))
    g0 = gating_count(hist.get("rows", []))
    rows: list[dict] = []
    try:
        rows = build_history(http, years, today, with_subscription=a.subscriptions, log=log)
        hist = merge_into_history(hist, rows, today)
        allrows = hist["rows"]
        if not a.no_pages:
            log["chittorgarh_pages"] = {"ok": True, "rows": enrich_from_pages(http, allrows, today, a.limit)}
        if not a.no_gmp:
            log["investorgain_gmp_series"] = {"ok": True, "rows": enrich_gmp(http, allrows, today, a.limit)}
        if not a.no_nse:
            log["nse_categories"] = {"ok": True, "rows": enrich_nse_categories(http, allrows, today, a.limit)}
        if not a.no_yahoo:
            log["yahoo_listing_close"] = {"ok": True, "rows": enrich_yahoo(http, allrows, today, a.limit)}
        log["post_listing_gmp_fixed"] = {"ok": True, "rows": drop_post_listing_gmp(allrows)}
        hist = merge_into_history(hist, [], today)
        dump_json(path, hist)
    except Exception as e:  # noqa: BLE001
        log["build"] = {"ok": False, "note": f"{type(e).__name__}: {e}"}
    with_gmp = sum(1 for r in hist.get("rows", []) if (r.get("gmp") or {}).get("rs") is not None)
    g1 = gating_count(hist.get("rows", []))
    src = ", ".join(f"{k} {'ok' if v.get('ok') else 'FAIL'} {v.get('rows', 0)}" for k, v in log.items())
    print(f"history {today}: years {years} -> {len(rows)} tracker rows with outcomes, history.json {before} -> {len(hist.get('rows', []))} "
          f"({with_gmp} with a GMP); calibration-gating rows {g0['gating']} -> {g1['gating']}; sources: {src}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
