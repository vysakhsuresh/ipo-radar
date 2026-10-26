"""InvestorGain.com: the live IPO GMP report, per-IPO dated GMP pages and the
GMP-performance (past IPO) report.

Structure as understood in Oct 2026, UNVERIFIED LIVE (written without network
access to investorgain.com). Tables are located by header text; check the
header names first when a field goes missing:

  * live GMP report (/report/live-ipo-gmp/331/): headers like "IPO", "Price",
    "GMP(₹)", "Est Listing" (as "₹450 (12.5%)"), "Fire Rating" (an icon whose
    title carries the rating), "IPO Size", "Lot", "Open", "Close", "BoA Dt",
    "Listing", "GMP Updated", sometimes "Sub" (overall times subscribed). The
    IPO cell links to /gmp/<slug>-gmp/<id>/ and carries an "SME" badge and a
    status badge ("Open", "Closed", "Upcoming") outside the link text. Dates
    are day-month WITHOUT a year ("31-Oct"), so the year is inferred relative
    to today; an issue opening in December and listing in January is the known
    weak spot (the NSE/Chittorgarh dates win in the merge anyway).
  * per-IPO GMP page (the link above): a dated table with headers like "GMP
    Date", "IPO Price", "GMP", "Sub2 Sauda", "Estimated Listing Price",
    "Last Updated"; `parse_gmp_history` reads the date and GMP columns.
  * GMP performance / past-IPO report: URL_GMP_PERFORMANCE below is the best
    recollection of its address (report id UNVERIFIED; a 404 is logged and
    ignored). Expected headers: "IPO", "Issue Price", "GMP" (the last
    pre-listing quote), "Listing Price" / "Listing Open", "Listing Gain" and a
    listing date. This is the one source that gives a PRE-LISTING GMP next to
    the listing outcome, which is what the model calibrates on; if the URL is
    wrong, find the "IPO GMP performance" report in the site's Reports menu and
    fix URL_GMP_PERFORMANCE.

Returns canonical partial rows (see fetch/normalize.py) and nothing else.
"""
from __future__ import annotations

from datetime import date
from typing import Any
from urllib.parse import urljoin

from fetch.common import Http
from fetch.normalize import (clean_name, parse_date, parse_price_band, crore, first_number, pct_in_parens,
                             is_sme_marker, derive_status)
from fetch.sources.htmltable import Table, parse_tables

BASE = "https://www.investorgain.com/"
URL_LIVE_GMP = BASE + "report/live-ipo-gmp/331/"
URL_GMP_PERFORMANCE = BASE + "report/ipo-gmp-performance/376/"   # UNVERIFIED report id
NAME_PATTERNS = ("ipo name", "company", "ipo", "name")


def _name_col(t: Table) -> int | None:
    return t.col(*NAME_PATTERNS, exclude=("date", "price", "size", "gmp", "gain", "lot"))


def _name_cell(t: Table, row: list, idx: int | None) -> tuple[str | None, str | None, bool]:
    c = t.cell(row, idx)
    if c is None:
        return None, None, False
    raw = c.link_text or c.text
    name = clean_name(raw)
    href = urljoin(BASE, c.href) if c.href else None
    extra = c.text.replace(c.link_text or "", " ").strip()
    badges = " ".join(c.titles).strip()
    sme = bool(extra and is_sme_marker(extra)) or bool(badges and is_sme_marker(badges))
    if not sme and raw and raw != name and "sme" in raw.lower():
        sme = True
    return (name or None), href, sme


def _with_sources(row: dict, url: str) -> dict:
    row["sources"] = {k: url for k in row if k not in ("sources", "flags", "gmp_url", "symbol")}
    return row


# ---------------------------------------------------------------- parsers ---

def parse_live_gmp(html: str, url: str, today: date | None = None) -> list[dict]:
    """The live GMP table -> partial rows with gmp {rs, pct, as_of}, price, lot, size, dates."""
    out: list[dict] = []
    for t in parse_tables(html):
        nc = _name_col(t)
        gc = t.col("gmp", exclude=("updated", "date", "%", "pct", "trend", "time"))
        if nc is None or gc is None or not t.rows:
            continue
        pc = t.col("ipo price", "issue price", "price", exclude=("listing", "est", "gmp"))
        ec = t.col("est", "expected", exclude=("date",))
        sc = t.col("size")
        lot = t.col("lot")
        subc = t.col("sub", exclude=("sauda",))
        oc = t.col("open", exclude=("listing", "price"))
        cc = t.col("close", exclude=("listing", "price"))
        bc = t.col("boa", "allotment")
        lc = t.col("listing", exclude=("est", "price", "gain", "expected"))
        uc = t.col("gmp updated", "updated", "last", exclude=("open", "close", "listing"))
        for row in t.rows:
            name, href, sme = _name_cell(t, row, nc)
            if not name:
                continue
            r: dict[str, Any] = {"name": name}
            if sme:
                r["board"] = "sme"
            if href:
                r["gmp_url"] = href
            lo, hi = parse_price_band(t.text(row, pc))
            if hi is not None:
                r["price_band_low"], r["price_band_high"] = lo, hi
                if lo == hi:
                    r["issue_price"] = hi
            rs = first_number(t.text(row, gc))
            pct = pct_in_parens(t.text(row, ec)) if ec is not None else None
            if pct is None and rs is not None and hi:
                pct = round(100.0 * rs / hi, 2)
            size = crore(t.text(row, sc))
            if size:
                r["issue_size_cr"] = size
            ls = first_number(t.text(row, lot))
            if ls and ls > 0:
                r["lot_size"] = int(ls)
            for key, idx in (("open_date", oc), ("close_date", cc), ("allotment_date", bc), ("listing_date", lc)):
                d = parse_date(t.text(row, idx), ref=today)
                if d:
                    r[key] = d
            as_of = parse_date(t.text(row, uc), ref=today) or (today.isoformat() if today else None)
            r["gmp"] = {"rs": rs, "pct": pct, "as_of": as_of if rs is not None else None}
            if rs is None:
                r["flags"] = ["gmp_not_quoted"]
            total = first_number(t.text(row, subc)) if subc is not None else None
            if total is not None:
                r["subscription"] = {"total": total, "as_of": today.isoformat() if today else None}
            out.append(_with_sources(r, url))
        break
    return out


def parse_gmp_history(html: str, today: date | None = None) -> list[dict]:
    """A per-IPO GMP page -> [{"date": ISO, "rs": float}, ...] sorted by date."""
    seen: dict[str, dict] = {}
    for t in parse_tables(html):
        dc = t.col("gmp date", "date", exclude=("updated", "listing", "open", "close"))
        gc = t.col("gmp", exclude=("date", "updated", "%", "pct", "trend", "time", "est"))
        if dc is None or gc is None or dc == gc or not t.rows:
            continue
        for row in t.rows:
            d = parse_date(t.text(row, dc), ref=today)
            rs = first_number(t.text(row, gc))
            if d and rs is not None:
                seen[d] = {"date": d, "rs": rs}
        if seen:
            break
    return sorted(seen.values(), key=lambda h: h["date"])


def parse_gmp_performance(html: str, url: str, today: date | None = None) -> list[dict]:
    """The GMP-performance report -> partial rows with issue_price, pre-listing gmp.rs and listing {open, gain_pct}."""
    out: list[dict] = []
    for t in parse_tables(html):
        nc = _name_col(t)
        gc = t.col("gmp", exclude=("updated", "date", "%", "pct", "trend", "time", "est"))
        ipc = t.col("issue price", "ipo price", "price", exclude=("listing", "est", "gmp", "open", "close"))
        if nc is None or gc is None or ipc is None or not t.rows:
            continue
        oc = t.col("listing price", "listing open", "listed at", "open price", "open", exclude=("est", "date", "expected"))
        gainc = t.col("listing gain", "actual", "gain", exclude=("est", "expected", "gmp"))
        ldc = t.col("listing date", "listed on", "date", exclude=("gmp",))
        tc = t.col("type", "board", "exchange", "listing at")
        for row in t.rows:
            name, href, sme = _name_cell(t, row, nc)
            if not name:
                continue
            price = first_number(t.text(row, ipc))
            rs = first_number(t.text(row, gc))
            lo = first_number(t.text(row, oc)) if oc not in (None, ipc) else None
            gain = first_number(t.text(row, gainc)) if gainc not in (None, oc, ipc) else None
            r: dict[str, Any] = {"name": name}
            if sme or is_sme_marker(t.text(row, tc)):
                r["board"] = "sme"
            if href:
                r["gmp_url"] = href
            d = parse_date(t.text(row, ldc), ref=today)
            if d:
                r["listing_date"] = d
            if price:
                r["issue_price"] = price
            if rs is not None:
                r["gmp"] = {"rs": rs, "pct": (round(100.0 * rs / price, 2) if price else None), "as_of": d}
            if lo is not None or gain is not None:
                r["listing"] = {"open": lo, "close": None, "gain_pct": gain}
            out.append(_with_sources(r, url))
        break
    return out


# --------------------------------------------------------------- fetching ---

def gmp_history(http: Http, url: str, today: date | None = None) -> list[dict]:
    html = http.get_html(url)
    return parse_gmp_history(html, today) if html else []


def fetch(http: Http, today: date, with_history: bool = True, max_history_pages: int = 40) -> list[dict]:
    """Live GMP rows; for not-yet-listed issues also the dated GMP series from the per-IPO page."""
    html = http.get_html(URL_LIVE_GMP)
    rows = parse_live_gmp(html, URL_LIVE_GMP, today) if html else []
    if with_history:
        n = 0
        for r in rows:
            if n >= max_history_pages or not r.get("gmp_url") or derive_status(r, today) == "listed":
                continue
            hist = gmp_history(http, r["gmp_url"], today)
            n += 1
            if hist:
                r["gmp"] = {**(r.get("gmp") or {}), "history": hist}
                r.setdefault("sources", {})["gmp_history"] = r["gmp_url"]
    return rows


def fetch_gmp_performance(http: Http, today: date, years: list[int] | tuple[int, ...] = ()) -> list[dict]:
    """Past IPOs with their last pre-listing GMP (UNVERIFIED URL; empty on failure)."""
    out: list[dict] = []
    urls = [f"{URL_GMP_PERFORMANCE}?year={y}" for y in years] or [URL_GMP_PERFORMANCE]
    for url in urls:
        html = http.get_html(url)
        if html:
            out.extend(parse_gmp_performance(html, url, today))
    return out
