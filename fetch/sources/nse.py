"""NSE India's IPO JSON endpoints: current, upcoming and past public issues plus
the per-issue detail and category-wise bid (subscription) tables.

Structure as understood in Oct 2026, UNVERIFIED LIVE (this was written without
network access to nseindia.com). What is assumed, and what to check if it breaks:

  * nseindia.com refuses API calls without the cookies its home page sets, so
    `fetch()` first GETs https://www.nseindia.com/ and the IPO listing page with
    a browser User-Agent (no cache), then calls the API with
    Referer: https://www.nseindia.com/market-data/all-upcoming-issues-ipo and
    Accept: application/json. A 401/403 on every API call means the cookie
    dance changed (check whether the site now needs a JS-set cookie such as
    `nsit`/`nseappid`, in which case NSE is out of reach for a plain client).
  * endpoints: /api/ipo-current-issue, /api/all-upcoming-issues?category=ipo,
    /api/public-past-issues, /api/ipo-detail?symbol=X&series=EQ|SME and
    /api/ipo-active-category?symbol=X. Each returns either a JSON list or a
    {"data": [...]} wrapper; a {"<anything>": [...]} wrapper is also accepted.
  * list rows carry keys like symbol, companyName, series ("EQ" mainboard,
    "SM"/"ST"/"SME" for NSE Emerge), issueStartDate / issueEndDate
    ("06-Nov-2024"), issuePrice ("371 to 390" or a single number), lotSize,
    issueSize (a share count, not rupees), noOfTimes (overall subscription),
    status, isBse ("1" when also listed on BSE), and sometimes listingDate.
    Keys are looked up case-insensitively by several aliases; if the parser
    returns rows with no dates, print one raw row and extend the alias lists in
    `_ALIASES`.
  * the detail payload nests an "issueInfo"-like dict and a category table
    (rows with "category" and "noOfTotalMeant"-like keys: QIB / Non
    Institutional / Retail / Employees / Total). `_flatten` walks the nesting
    so the exact wrapper names do not matter.
  * BSE-only SME issues never appear here; Chittorgarh covers them.

Returns canonical partial rows (see fetch/normalize.py) and nothing else.
"""
from __future__ import annotations

from datetime import date
from typing import Any, Iterable

from fetch.common import Http, num
from fetch.normalize import (clean_name, pretty_case, parse_date, parse_price_band, is_sme_marker,
                             derive_status, category_key)

HOME = "https://www.nseindia.com/"
REFERER = "https://www.nseindia.com/market-data/all-upcoming-issues-ipo"
API = "https://www.nseindia.com/api/"
URL_CURRENT = API + "ipo-current-issue"
URL_UPCOMING = API + "all-upcoming-issues?category=ipo"
URL_PAST = API + "public-past-issues"
URL_DETAIL = API + "ipo-detail?symbol={symbol}&series={series}"
URL_CATEGORY = API + "ipo-active-category?symbol={symbol}"
HEADERS = {"Accept": "application/json, text/plain, */*", "Referer": REFERER, "X-Requested-With": "XMLHttpRequest"}

_ALIASES: dict[str, tuple[str, ...]] = {
    "name": ("companyName", "company", "name", "issuerName", "issuer"),
    "symbol": ("symbol", "scripCode", "nseSymbol"),
    "series": ("series", "seriesName"),
    "open_date": ("issueStartDate", "startDate", "openDate", "issueOpenDate", "biddingStartDate", "issuePeriodStart", "bidOpenDate"),
    "close_date": ("issueEndDate", "endDate", "closeDate", "issueCloseDate", "biddingEndDate", "issuePeriodEnd", "bidCloseDate"),
    "listing_date": ("listingDate", "dateOfListing", "listingDt", "tentativeListingDate", "listing"),
    "allotment_date": ("allotmentDate", "basisOfAllotmentDate", "boaDate"),
    "price": ("issuePrice", "priceBand", "priceRange", "price", "issuePriceRange"),
    "lot": ("lotSize", "marketLot", "minBidQty", "minimumOrderQuantity", "minOrderQty", "bidLot"),
    "size_shares": ("issueSize", "totalIssueSize", "issueSizeShares", "noOfSharesOffered", "totalSharesOffered"),
    "size_cr": ("issueSizeCr", "issueSizeInCr", "issueSizeRsCr", "sizeCr"),
    "sub_total": ("noOfTimes", "subscription", "timesSubscribed", "subscriptionTimes", "totalTimes"),
    "status": ("status", "issueStatus"),
    "is_bse": ("isBse", "bse", "listedOnBse"),
    "sme": ("isSme", "sme", "category", "segment", "platform", "issueType", "type", "market", "board"),
    "times": ("noOfTotalMeant", "noOfTimes", "timesSubscribed", "subscription", "times"),
    "category": ("category", "categoryName", "investorCategory"),
    "updated": ("updateTime", "updatedTime", "asOn", "timestamp", "lastUpdated"),
}


# -------------------------------------------------------------- utilities ---

def _norm(k: Any) -> str:
    return "".join(ch for ch in str(k).lower() if ch.isalnum())


def _flatten(obj: Any, out: dict[str, Any] | None = None) -> dict[str, Any]:
    """Leaf values keyed by normalised key; outer keys win over nested ones."""
    out = {} if out is None else out
    if isinstance(obj, dict):
        nested = []
        for k, v in obj.items():
            if isinstance(v, (dict, list)):
                nested.append(v)
            else:
                out.setdefault(_norm(k), v)
        for v in nested:
            _flatten(v, out)
    elif isinstance(obj, list):
        for v in obj:
            if isinstance(v, dict):
                _flatten(v, out)
    return out


def _pick(flat: dict[str, Any], field: str) -> Any:
    for a in _ALIASES[field]:
        v = flat.get(_norm(a))
        if v is not None and str(v).strip() not in ("", "-", "--", "null", "NA", "N/A"):
            return v
    return None


def _rows(obj: Any) -> list[dict]:
    """Accept a list, {"data": [...]}, or any dict whose first list-of-dicts value is the table."""
    if isinstance(obj, list):
        return [r for r in obj if isinstance(r, dict)]
    if isinstance(obj, dict):
        for key in ("data", "currentIssues", "upcomingIssues", "pastIssues", "issues", "records", "dataList", "result"):
            if isinstance(obj.get(key), list):
                return [r for r in obj[key] if isinstance(r, dict)]
        for v in obj.values():
            if isinstance(v, list) and v and all(isinstance(r, dict) for r in v):
                return v
    return []


def _is_sme(flat: dict[str, Any]) -> bool:
    series = _pick(flat, "series")
    if series is not None and str(series).strip().upper() in ("SM", "ST", "SME"):
        return True
    if series is not None and str(series).strip().upper() == "EQ":
        return False
    return is_sme_marker(*(flat.get(_norm(a)) for a in _ALIASES["sme"]))


def parse_categories(obj: Any) -> dict[str, float | None]:
    """Category-wise bid table -> {qib, nii, bnii, snii, retail, employee, total} (times subscribed)."""
    out: dict[str, float | None] = {}
    rows = _category_rows(obj)
    for r in rows:
        flat = _flatten(r)
        key = category_key(_pick(flat, "category"))
        if not key:
            continue
        v = num(_pick(flat, "times"))
        if v is not None and out.get(key) is None:
            out[key] = v
    return out


def _category_rows(obj: Any) -> list[dict]:
    if isinstance(obj, list):
        if obj and all(isinstance(r, dict) for r in obj) and any(_pick(_flatten(r), "category") is not None for r in obj):
            return obj
        for v in obj:
            found = _category_rows(v)
            if found:
                return found
    elif isinstance(obj, dict):
        for v in obj.values():
            found = _category_rows(v)
            if found:
                return found
    return []


# ---------------------------------------------------------------- parsing ---

def row_from(raw: dict, url: str, today: date | None = None) -> dict | None:
    """One NSE issue dict (list row or detail payload) -> canonical partial row."""
    flat = _flatten(raw)
    name = _pick(flat, "name")
    if not name:
        return None
    sme = _is_sme(flat)
    row: dict[str, Any] = {"name": clean_name(pretty_case(str(name))), "board": "sme" if sme else "mainboard"}
    sym = _pick(flat, "symbol")
    if sym:
        row["symbol"] = str(sym).strip()
        row["series"] = str(_pick(flat, "series") or ("SME" if sme else "EQ")).strip()
    is_bse = _pick(flat, "is_bse")
    row["exchange"] = "NSE SME" if sme else ("NSE,BSE" if is_sme_marker(is_bse) else "NSE")
    for k in ("open_date", "close_date", "listing_date", "allotment_date"):
        d = parse_date(_pick(flat, k), ref=today)
        if d:
            row[k] = d
    lo, hi = parse_price_band(_pick(flat, "price"))
    if hi is not None:
        row["price_band_low"], row["price_band_high"] = lo, hi
        if lo == hi:
            row["issue_price"] = hi
    lot = num(_pick(flat, "lot"))
    if lot and lot > 0:
        row["lot_size"] = int(lot)
    size_cr = num(_pick(flat, "size_cr"))
    if size_cr:
        row["issue_size_cr"] = size_cr
    else:
        shares = num(_pick(flat, "size_shares"))
        if shares and hi and shares >= 10_000:
            row["issue_size_cr"] = round(shares * hi / 1e7, 2)
            row["flags"] = ["issue_size_estimated"]
    total = num(_pick(flat, "sub_total"))
    cats = parse_categories(raw)
    if cats or total is not None:
        sub = dict(cats)
        if total is not None and sub.get("total") is None:
            sub["total"] = total
        upd = parse_date(_pick(flat, "updated"), ref=today)
        if upd:
            sub["as_of"] = upd
        row["subscription"] = sub
    row["sources"] = {k: url for k in row if k not in ("symbol", "series", "flags", "sources")}
    return row


def parse_issue_list(obj: Any, url: str, today: date | None = None, board: str | None = None) -> list[dict]:
    rows = []
    for raw in _rows(obj):
        r = row_from(raw, url, today)
        if r is None:
            continue
        if board:
            r["board"] = board
            r["exchange"] = "NSE SME" if board == "sme" else r.get("exchange")
        rows.append(r)
    return rows


def parse_detail(obj: Any, url: str, today: date | None = None) -> dict | None:
    return row_from(obj, url, today) if isinstance(obj, (dict, list)) else None


# ---------------------------------------------------------------- fetching ---

def warm_up(http: Http) -> None:
    """Collect the cookies nseindia.com requires before any /api call."""
    http.get(HOME, allow_cache=False, retries=2)
    http.get(REFERER, allow_cache=False, retries=1)


def fetch(http: Http, today: date, with_detail: bool = True) -> list[dict]:
    """All current + upcoming (+ recent past) NSE issues as canonical partial rows."""
    warm_up(http)
    by_key: dict[str, dict] = {}
    order: list[str] = []
    for url in (URL_CURRENT, URL_UPCOMING, URL_PAST):
        obj = http.get_json(url, headers=HEADERS)
        if obj is None:
            continue
        for r in parse_issue_list(obj, url, today):
            key = r.get("symbol") or r["name"].lower()
            if key in by_key:
                by_key[key] = _merge_partial(by_key[key], r)
            else:
                by_key[key] = r
                order.append(key)
    rows = [by_key[k] for k in order]
    if not with_detail:
        return rows
    for r in rows:
        if not r.get("symbol"):
            continue
        status = derive_status(r, today)
        if status == "listed":
            continue
        detail_url = URL_DETAIL.format(symbol=r["symbol"], series=r.get("series", "EQ"))
        d = parse_detail(http.get_json(detail_url, headers=HEADERS), detail_url, today)
        if d:
            _merge_partial(r, d)
        if status in ("open", "closed"):
            cat_url = URL_CATEGORY.format(symbol=r["symbol"])
            obj = http.get_json(cat_url, headers=HEADERS)
            cats = parse_categories(obj) if obj is not None else {}
            if cats:
                sub = dict(r.get("subscription") or {})
                sub.update({k: v for k, v in cats.items() if v is not None})
                upd = parse_date(_pick(_flatten(obj), "updated"), ref=today)
                if upd:
                    sub["as_of"] = upd
                r["subscription"] = sub
                r.setdefault("sources", {})["subscription"] = cat_url
    return rows


def _merge_partial(base: dict, new: dict) -> dict:
    """Fill gaps in `base` from `new`; the detail endpoint is trusted over the list for dates and prices."""
    for k, v in new.items():
        if v in (None, "", [], {}):
            continue
        if k in ("subscription", "sources"):
            d = dict(base.get(k) or {})
            d.update({kk: vv for kk, vv in v.items() if vv is not None})
            base[k] = d
        elif k == "flags":
            base[k] = sorted(set(base.get("flags", [])) | set(v))
        elif k in ("open_date", "close_date", "listing_date", "allotment_date", "price_band_low", "price_band_high",
                   "issue_price", "lot_size") or base.get(k) in (None, ""):
            base[k] = v
    return base


def symbols(rows: Iterable[dict]) -> list[str]:
    return [r["symbol"] for r in rows if r.get("symbol")]
