"""Chittorgarh.com report pages: mainboard and SME IPO lists, the GMP report,
the per-IPO live subscription page and the two listing-performance trackers.

Structure as understood in Oct 2026, UNVERIFIED LIVE (written without network
access to chittorgarh.com). Every table is located by header text, never by
column position, so a reordered column is harmless; a renamed header is the
thing to check when a parser returns rows with a missing field:

  * list reports (/report/mainboard-ipo-list-in-india-bse-nse/19/ and
    /report/sme-ipo-list-in-india-bse-sme-nse-emerge/84/): one <table> with
    headers like "Issuer Company", "Open Date", "Close Date", "Listing Date",
    "Issue Price (Rs)", "Issue Size (Rs Cr.)", "Lot Size", "Exchange" /
    "Listing At". The company cell links to /ipo/<slug>/<id>/ and the
    subscription page is /ipo_subscription/<slug>/<id>/. Dates read like
    "Oct 31, 2026"; prices like "382 to 402" (band) or "402" (final).
  * GMP report (/report/ipo_gmp_grey_market_premium/85/): headers like "IPO
    Name" / "Company", "IPO Price", "GMP" (rupees), "Est. Listing Price" as
    "447 (11.19%)", maybe "Listing Gain (%)", and a "Last Updated" / "GMP Date"
    column or an "as on <date>" line in the page text. SME issues are tagged
    "SME" in the name cell or an exchange/type column.
  * subscription page: a table with "Category" and "Subscription (times)"
    columns (QIB, NII, bNII, sNII, Retail, Employee, Total), optionally a
    day-wise table ("Date", "QIB", "NII", "Retail", "Total"), and a line
    "as on <date>" / "updated on <date>". The first table wins; the day-wise
    table's last row is the fallback.
  * performance trackers (/report/ipo-performance-tracker-listing-gain-on-ipo/21/
    and /report/ipo-listing-gain-sme-ipo-performance-tracker/23/, with
    ?year=YYYY): headers like "Issuer Company", "Listing Date", "Issue Price",
    "Listing Open" / "Open Price", "Listing Close" / "Close Price", "Listing
    Gain (%)" and often "Listing At". These carry NO GMP column.

If a report starts loading its table via XHR instead of server-side HTML,
parse_tables() will find nothing: look in the browser's network tab for the
JSON the page fetches and add a JSON branch.

Returns canonical partial rows (see fetch/normalize.py) and nothing else.
"""
from __future__ import annotations

import re
from datetime import date, timedelta

from bs4 import BeautifulSoup
from typing import Any
from urllib.parse import urljoin

from fetch.common import Http
from fetch import render
from fetch.normalize import (clean_name, parse_date, parse_price_band, crore, first_number, pct_in_parens,
                             exchange_label, is_sme_marker, category_key, derive_status, row_id, merge, to_date)
from fetch.sources.htmltable import Table, parse_tables, find_text

BASE = "https://www.chittorgarh.com/"
# Paths as the site's own navigation links them (read from an Actions run on 2026-10-26).
# A wrong report path does not 404 on this site: it silently serves another page with no
# tables, so every path here was taken from the live nav, and the GMP page is discovered
# from the nav at run time (`discover_link`) rather than hard-coded.
URL_MAINBOARD_LIST = BASE + "report/ipo-in-india-list-main-board-sme/82/mainboard/"
URL_SME_LIST = BASE + "report/ipo-in-india-list-main-board-sme/82/sme/"
URL_SUBSCRIPTION_LIVE = BASE + "report/ipo-subscription-status-live-bidding-data-bse-nse/21/"
URL_TRACKER_MAINBOARD = BASE + "report/ipo-perf-tracker/236/mainboard/"
URL_TRACKER_SME = BASE + "report/ipo-perf-tracker/236/sme/"
URL_GMP = BASE + "report/ipo-gmp-grey-market-premium/97/"      # first guess; the nav link wins when found
URL_GMP_CANDIDATES = (URL_GMP, BASE + "ipo/ipo_gmp/")
GMP_LINK_RE = r"grey\s*market\s*premium|\bgmp\b"


def html_with_tables(http: Http, url: str) -> str | None:
    """Static HTML if it carries a <table>; otherwise the headless-rendered page
    (Chittorgarh builds its report tables with JavaScript)."""
    html = http.get_html(url)
    if html and parse_tables(html):
        return html
    rendered = render.render_html(url)
    if rendered and parse_tables(rendered):
        http.prov.add(url, True, 200, note="rendered in headless browser")
        return rendered
    if rendered is None and not render.available():
        http.prov.add(url, False, None, note="no tables in static HTML and no headless browser available")
    return html


def discover_link(html: str, pattern: str) -> str | None:
    """Absolute href of the first <a> whose text matches `pattern` (case-insensitive)."""
    soup = BeautifulSoup(html, "lxml")
    rx = re.compile(pattern, re.I)
    for a in soup.find_all("a", href=True):
        if rx.search(a.get_text(" ", strip=True) or ""):
            href = a["href"]
            if href.startswith("http"):
                return href
            if href.startswith("/"):
                return BASE.rstrip("/") + href
    return None
AS_ON_RE = r"(?:as on|as of|updated on|last updated(?: on)?)\s*:?\s*([A-Za-z]{3,9}\.? \d{1,2},? \d{4}|\d{1,2}[-/ ][A-Za-z]{3,9}[-/ ,]+\d{2,4}|\d{4}-\d{2}-\d{2})"

NAME_PATTERNS = ("issuer", "company", "ipo name", "ipo", "name")


def _name_col(t: Table) -> int | None:
    return t.col(*NAME_PATTERNS, exclude=("date", "price", "size", "gmp", "gain", "lot"))


def _name_cell(t: Table, row: list, idx: int | None) -> tuple[str | None, str | None, bool]:
    """(clean company name, IPO page url, sme-marker seen in the cell)."""
    c = t.cell(row, idx)
    if c is None:
        return None, None, False
    raw = c.link_text or c.text
    name = clean_name(raw)
    href = urljoin(BASE, c.href) if c.href else None
    extra = c.text.replace(c.link_text or "", " ")
    return (name or None), href, is_sme_marker(extra) if extra.strip() else False


def _with_sources(row: dict, url: str) -> dict:
    row["sources"] = {k: url for k in row if k not in ("sources", "flags", "ipo_url", "symbol")}
    return row


# ---------------------------------------------------------------- parsers ---

def parse_list(html: str, board: str, url: str, today: date | None = None) -> list[dict]:
    """The mainboard / SME list report -> partial rows with dates, band, size, lot, exchange."""
    out: list[dict] = []
    for t in parse_tables(html):
        nc = _name_col(t)
        oc = t.col("open date", "issue open", "open", exclude=("listing", "price"))
        if nc is None or oc is None or not t.rows:
            continue
        cc = t.col("close date", "issue close", "close", exclude=("listing", "price"))
        lc = t.col("listing date", "listing", exclude=("price", "gain", "open", "close", "listing at", "listed at"))
        ac = t.col("allotment")
        pc = t.col("issue price", "price band", "price", exclude=("listing", "est"))
        sc = t.col("issue size", "size")
        lot = t.col("lot size", "market lot", "lot")
        xc = t.col("exchange", "listing at", "listed at", "platform")
        for row in t.rows:
            name, href, sme_in_cell = _name_cell(t, row, nc)
            if not name:
                continue
            r: dict[str, Any] = {"name": name, "board": board}
            if href:
                r["ipo_url"] = href
            for key, idx in (("open_date", oc), ("close_date", cc), ("listing_date", lc), ("allotment_date", ac)):
                d = parse_date(t.text(row, idx), ref=today)
                if d:
                    r[key] = d
            lo, hi = parse_price_band(t.text(row, pc))
            if hi is not None:
                r["price_band_low"], r["price_band_high"] = lo, hi
                if lo == hi:
                    r["issue_price"] = hi
            size = crore(t.text(row, sc))
            if size:
                r["issue_size_cr"] = size
            ls = first_number(t.text(row, lot))
            if ls and ls > 0:
                r["lot_size"] = int(ls)
            ex = exchange_label(t.text(row, xc), sme=(board == "sme"))
            if ex:
                r["exchange"] = ex
                if "SME" in ex:
                    r["board"] = "sme"
            elif sme_in_cell:
                r["board"] = "sme"
            out.append(_with_sources(r, url))
        break
    return out


def parse_gmp_report(html: str, url: str, today: date | None = None) -> list[dict]:
    """The GMP report -> partial rows with gmp {rs, pct, as_of} (+ issue price and dates when shown)."""
    out: list[dict] = []
    page_as_of = parse_date(find_text(html, AS_ON_RE), ref=today)
    for t in parse_tables(html):
        nc = _name_col(t)
        gc = t.col("gmp", exclude=("date", "updated", "%", "pct", "percent", "time", "trend"))
        if nc is None or gc is None or not t.rows:
            continue
        pc = t.col("ipo price", "issue price", "price band", "price", exclude=("listing", "est", "expected", "gmp"))
        ec = t.col("est", "expected", "listing price", exclude=("date", "gain"))
        pctc = t.col("listing gain", "gain", "%", exclude=("est. listing price",))
        uc = t.col("updated", "as on", "gmp date", "date", exclude=("open", "close", "listing", "ipo date"))
        oc = t.col("open", exclude=("listing", "price"))
        cc = t.col("close", exclude=("listing", "price"))
        lc = t.col("listing date", exclude=("price",))
        tc = t.col("type", "board", "exchange", "listing at", "segment")
        for row in t.rows:
            name, href, sme_in_cell = _name_cell(t, row, nc)
            if not name:
                continue
            rs = first_number(t.text(row, gc))
            r: dict[str, Any] = {"name": name}
            if href:
                r["ipo_url"] = href
            if sme_in_cell or is_sme_marker(t.text(row, tc)):
                r["board"] = "sme"
            elif t.text(row, tc) and ("main" in t.text(row, tc).lower() or "nse" in t.text(row, tc).lower() or "bse" in t.text(row, tc).lower()):
                r["board"] = "mainboard"
            price = first_number(t.text(row, pc))
            if price:
                lo, hi = parse_price_band(t.text(row, pc))
                r["price_band_low"], r["price_band_high"] = lo, hi
                if lo == hi:
                    r["issue_price"] = hi
            pct = first_number(t.text(row, pctc)) if pctc is not None and pctc != ec else None
            if pct is None:
                pct = pct_in_parens(t.text(row, ec)) if ec is not None else None
            if pct is None and rs is not None and price:
                pct = round(100.0 * rs / price, 2)
            as_of = parse_date(t.text(row, uc), ref=today) or page_as_of or (today.isoformat() if today else None)
            for key, idx in (("open_date", oc), ("close_date", cc), ("listing_date", lc)):
                d = parse_date(t.text(row, idx), ref=today)
                if d:
                    r[key] = d
            if rs is not None:
                r["gmp"] = {"rs": rs, "pct": pct, "as_of": as_of}
            else:
                r["gmp"] = {"rs": None, "pct": None, "as_of": None}
                r["flags"] = ["gmp_not_quoted"]
            out.append(_with_sources(r, url))
        break
    return out


def parse_subscription_report(html: str, url: str, today: date | None = None) -> list[dict]:
    """The live 'subscription status' report: one row per current issue with the
    category multiples -> partial rows {name, subscription{qib,nii,retail,total}}."""
    out: list[dict] = []
    page_as_of = parse_date(find_text(html, AS_ON_RE), ref=today)
    for t in parse_tables(html):
        nc = _name_col(t)
        qc = t.col("qib", exclude=("ex",))
        tc = t.col("total", exclude=("amount", "value", "crore", "cr"))
        if nc is None or (qc is None and tc is None) or not t.rows:
            continue
        nii = t.col("nii", "hni", "non-institutional", exclude=("b", "s", "big", "small"))
        bn = t.col("bnii", "bhni", "big")
        sn = t.col("snii", "shni", "small")
        rc = t.col("rii", "retail", "individual", exclude=("non",))
        ec = t.col("employee", "emp")
        dc = t.col("day", "date", "as on", "updated", exclude=("open", "close", "listing"))
        for row in t.rows:
            name, href, sme_in_cell = _name_cell(t, row, nc)
            if not name:
                continue
            sub = {k: first_number(t.text(row, idx)) for k, idx in (("qib", qc), ("nii", nii), ("bnii", bn), ("snii", sn), ("retail", rc), ("employee", ec), ("total", tc)) if idx is not None}
            if not any(v is not None for v in sub.values()):
                continue
            if sub.get("nii") is None and (sub.get("bnii") is not None or sub.get("snii") is not None):
                vals = [v for v in (sub.get("bnii"), sub.get("snii")) if v is not None]
                sub["nii"] = sum(vals) / len(vals)
            sub["as_of"] = parse_date(t.text(row, dc), ref=today) or page_as_of or (today.isoformat() if today else None)
            r: dict[str, Any] = {"name": name, "subscription": sub}
            if href:
                r["ipo_url"] = href
            if sme_in_cell:
                r["board"] = "sme"
            out.append(_with_sources(r, url))
        if out:
            break
    return out


def parse_subscription(html: str, url: str, today: date | None = None) -> dict | None:
    """A per-IPO subscription page -> {qib, nii, bnii, snii, retail, employee, total, as_of} or None."""
    as_of = parse_date(find_text(html, AS_ON_RE), ref=today)
    tables = parse_tables(html)
    sub: dict[str, Any] = {}
    for t in tables:
        cc = t.col("category", "investor", "investors")
        vc = t.col("subscription (times)", "subscription", "times", "subscribed")
        if cc is None or vc is None or cc == vc or not t.rows:
            continue
        for row in t.rows:
            key = category_key(t.text(row, cc))
            v = first_number(t.text(row, vc))
            if key and v is not None and sub.get(key) is None:
                sub[key] = v
        if sub:
            break
    if not sub:
        # day-wise table: last row holds the latest figures
        for t in tables:
            dc = t.col("date", "day")
            cols = {k: t.col(k) for k in ("qib", "nii", "retail", "employee", "total")}
            if dc is None or all(v is None for v in cols.values()) or not t.rows:
                continue
            last = t.rows[-1]
            for key, idx in cols.items():
                v = first_number(t.text(last, idx))
                if v is not None:
                    sub[key] = v
            d = parse_date(t.text(last, dc), ref=today)
            if d:
                as_of = as_of or d
            if sub:
                break
    if not sub:
        return None
    sub["as_of"] = as_of or (today.isoformat() if today else None)
    return sub


def parse_tracker(html: str, board: str, url: str, today: date | None = None) -> list[dict]:
    """A performance tracker page -> partial rows with issue_price and listing {open, close, high, low, gain_pct}."""
    out: list[dict] = []
    for t in parse_tables(html):
        nc = _name_col(t)
        ipc = t.col("issue price", "offer price", "ipo price", "price", exclude=("listing", "open", "close", "current", "last", "market", "cmp"))
        if nc is None or ipc is None or not t.rows:
            continue
        ldc = t.col("listing date", "listed on", "date")
        oc = t.col("listing open", "open price", "listing price", "debut", "open", exclude=("date", "close", "current", "day high", "low"))
        clc = t.col("listing close", "close price", "last trade", "closing", "close", exclude=("date", "open", "current"))
        hc = t.col("listing high", "day high", "high", exclude=("52", "current"))
        lwc = t.col("listing low", "day low", "low", exclude=("52", "current", "allow"))
        gc = t.col("listing gain", "listing day gain", "gain", "%", exclude=("current", "today", "cmp", "profit", "loss", "est"))
        xc = t.col("listing at", "exchange")
        for row in t.rows:
            name, href, sme_in_cell = _name_cell(t, row, nc)
            if not name:
                continue
            price = first_number(t.text(row, ipc))
            lo, lc, hi, lw = (first_number(t.text(row, i)) for i in (oc, clc, hc, lwc))
            gain = first_number(t.text(row, gc)) if gc not in (None, oc, clc) else None
            if price is None and lo is None and lc is None and gain is None:
                continue
            r: dict[str, Any] = {"name": name, "board": board}
            if href:
                r["ipo_url"] = href
            d = parse_date(t.text(row, ldc), ref=today)
            if d:
                r["listing_date"] = d
            if price:
                r["issue_price"] = price
            ex = exchange_label(t.text(row, xc), sme=(board == "sme"))
            if ex:
                r["exchange"] = ex
                if "SME" in ex:
                    r["board"] = "sme"
            elif sme_in_cell:
                r["board"] = "sme"
            if lo is not None or lc is not None or gain is not None:
                r["listing"] = {"open": lo, "close": lc, "high": hi, "low": lw, "gain_pct": gain}
            out.append(_with_sources(r, url))
        break
    return out


def subscription_url(ipo_url: str | None) -> str | None:
    if not ipo_url or "/ipo/" not in ipo_url:
        return None
    return ipo_url.replace("/ipo/", "/ipo_subscription/", 1)


# --------------------------------------------------------------- fetching ---

def fetch(http: Http, today: date, with_subscription: bool = True) -> list[dict]:
    """Lists + GMP report (+ live subscription for open/just-closed issues) as partial rows."""
    rows: dict[str, dict] = {}

    def add(parts: dict) -> None:
        key = row_id(parts, today)
        rows[key] = merge(rows[key], parts) if key in rows else parts

    nav_html = None
    for url, board in ((URL_MAINBOARD_LIST, "mainboard"), (URL_SME_LIST, "sme")):
        html = html_with_tables(http, url)
        if html:
            nav_html = nav_html or html
            for p in parse_list(html, board, url, today):
                add(p)
    gmp_urls = []
    if nav_html:
        found = discover_link(nav_html, GMP_LINK_RE)
        if found and "chittorgarh.com" in found:
            gmp_urls.append(found)
    gmp_urls += [u for u in URL_GMP_CANDIDATES if u not in gmp_urls]
    for url in gmp_urls:
        html = html_with_tables(http, url)
        parsed = parse_gmp_report(html, url, today) if html else []
        if parsed:
            for p in parsed:
                add(p)
            break
    if with_subscription:
        html = html_with_tables(http, URL_SUBSCRIPTION_LIVE)
        got = parse_subscription_report(html, URL_SUBSCRIPTION_LIVE, today) if html else []
        for p in got:
            add(p)
        if not got:  # fall back to each issue's own page
            for p in list(rows.values()):
                st = derive_status(p, today)
                cd = to_date(p.get("close_date"))
                if st not in ("open", "closed") or not p.get("ipo_url"):
                    continue
                if st == "closed" and cd and cd < today - timedelta(days=10):
                    continue
                url = subscription_url(p["ipo_url"])
                html = http.get_html(url) if url else None
                sub = parse_subscription(html, url, today) if html else None
                if sub:
                    p["subscription"] = {**(p.get("subscription") or {}), **sub}
                    p.setdefault("sources", {})["subscription"] = url
    return list(rows.values())


def fetch_trackers(http: Http, years: list[int] | tuple[int, ...], today: date) -> list[dict]:
    """Listing outcomes for the given years from both performance trackers."""
    out: list[dict] = []
    for year in years:
        for base, board in ((URL_TRACKER_MAINBOARD, "mainboard"), (URL_TRACKER_SME, "sme")):
            # the year selector's URL shape is not known for certain: try the path form, then the query form
            for url in (f"{base}{year}/", f"{base}?year={year}"):
                html = html_with_tables(http, url)
                got = parse_tracker(html, board, url, today) if html else []
                if got:
                    out.extend(got)
                    break
    return out


def tracker_years(today: date) -> list[int]:
    """Years whose trackers a routine run reads: this year, plus last year in January."""
    return [today.year - 1, today.year] if today.month == 1 else [today.year]
