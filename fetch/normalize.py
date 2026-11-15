"""Canonicalisation shared by the fetchers and tools/ingest_research.py.

Everything that turns a *partial* row from one source (NSE JSON, a Chittorgarh
table, an InvestorGain table, a researcher's JSON) into the IPO object in
data/SCHEMA.md lives here, so every path produces the same shape:

  canonical_row(parts, today, as_of)  partial row with canonical field names
                                      (or the research-tool flat keys) -> IPO
  merge(old, new)                     later wins per field, None never wins,
                                      GMP history is unioned by date
  derive_status(row, today)           upcoming / open / closed / listed from dates
  finalise_row(row, today)            re-derive the computed fields after a merge
                                      (issue_price fallback, GMP %, listing gain
                                      and basis, status, min_lots, min_investment)

Assumptions baked in:
  * `issue_price` is the final price when known, else the upper band, flagged
    `price_band_only`; GMP % and listing gain are always relative to it
  * listing gain is close vs issue price when the close is known (`gain_basis`
    "close"), else the debut price ("open"), else whatever the source reported
    ("reported") so the model can discount the weaker bases
  * an SME application is `min_lots_for("sme")` lots (2 since SEBI's 2025 rule);
    `min_investment = min_lots * lot_size * issue_price`
  * the row id is slugify(name, year of the first known of listing/open/close
    date, else today's year); parsers must strip "IPO"/"(SME)" from names so the
    three sites key to the same slug (see `clean_name`)
"""
from __future__ import annotations

import os
import re
import sys
from datetime import date, timedelta
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from fetch.common import slugify  # noqa: E402
from model.rules import min_lots_for  # noqa: E402

FIELDS_DIRECT = ["name", "board", "exchange", "open_date", "close_date", "allotment_date", "listing_date",
                 "price_band_low", "price_band_high", "issue_price", "lot_size", "issue_size_cr",
                 "fresh_issue_cr", "ofs_cr", "sector", "pe_post_issue", "lead_managers", "anchor_cr", "notes",
                 "symbol", "security_type", "refund_date", "demat_date", "face_value", "about", "registrar", "anchor",
                 "ipo_url", "gmp_url"]
SUB_KEYS = ("qib", "nii", "bnii", "snii", "retail", "employee", "total")
NA_TOKENS = {"", "-", "--", "—", "na", "n/a", "nil", "none", "null", "tbd", "tba", "not announced", "to be announced"}

_MONTHS = {m: i for i, m in enumerate(("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"), 1)}
_NUM_RE = re.compile(r"-?\d[\d,]*(?:\.\d+)?")
_PAREN_PCT_RE = re.compile(r"\(\s*(-?\d[\d,]*(?:\.\d+)?)\s*%\s*\)")
_NAME_STRIP_RE = re.compile(
    r"(\s*[\(\[]\s*(sme|nse sme|bse sme|nse emerge|emerge|mainboard|main board)\s*[\)\]]"
    r"|\s+(sme ipo|ipo|nse sme|bse sme|nse emerge|emerge|sme|fpo)"
    r"|\s+(open|closed|close|closes today|upcoming|listed|listing today|allotment|listing|new|today))+\s*$",
    re.IGNORECASE)


# ------------------------------------------------------------------ dates ---

def to_date(s: Any) -> date | None:
    """ISO 'YYYY-MM-DD[...]' string -> date, else None (unchanged from the ingest tool)."""
    if not s or not isinstance(s, str) or len(s) < 10:
        return None
    try:
        return date.fromisoformat(s[:10])
    except ValueError:
        return None


def parse_date(s: Any, ref: date | None = None) -> str | None:
    """Parse the date formats the sites use into ISO, or None.

    Handles '06-Nov-2024', '6 Nov 2024', 'Nov 6, 2024', 'November 6, 2024',
    '2024-11-06', '06/11/2024' and '06-11-2024' (day first, Indian convention),
    '06-Nov-24', and day-month without a year such as '6-Nov' or '6 Nov' (as on
    InvestorGain), for which the year is the one that puts the date within about
    200 days of `ref` (today). Trailing times ('... 10:30 AM') are ignored.
    """
    if s is None:
        return None
    if isinstance(s, date):
        return s.isoformat()
    t = re.sub(r"\s+", " ", str(s)).strip().replace("Sept ", "Sep ").replace("Sept-", "Sep-")
    if t.lower() in NA_TOKENS:
        return None
    m = re.search(r"(\d{4})-(\d{1,2})-(\d{1,2})", t)
    if m:
        return _iso(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    # a two-digit year must not be the hour of a time ('26-Nov 14:02' is 26 Nov, not 2014)
    m = re.search(r"\b(\d{1,2})(?:st|nd|rd|th)?[-/ ,]+([A-Za-z]{3,9})\.?[-/ ,]+(\d{4}|\d{2}(?![:.]\d))\b", t)
    if m and m.group(2)[:3].lower() in _MONTHS:
        y = int(m.group(3))
        return _iso(y + 2000 if y < 100 else y, _MONTHS[m.group(2)[:3].lower()], int(m.group(1)))
    m = re.search(r"\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b", t)
    if m and m.group(1)[:3].lower() in _MONTHS:
        return _iso(int(m.group(3)), _MONTHS[m.group(1)[:3].lower()], int(m.group(2)))
    m = re.search(r"\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b", t)
    if m:
        return _iso(int(m.group(3)), int(m.group(2)), int(m.group(1)))
    m = re.search(r"\b(\d{1,2})(?:st|nd|rd|th)?[-/ ]+([A-Za-z]{3,9})\b", t)
    if m and m.group(2)[:3].lower() in _MONTHS:
        ref = ref or date.today()
        mon, day = _MONTHS[m.group(2)[:3].lower()], int(m.group(1))
        for year in (ref.year, ref.year + 1, ref.year - 1):
            try:
                d = date(year, mon, day)
            except ValueError:
                return None
            if abs((d - ref).days) <= 200:
                return d.isoformat()
        return None
    return None


def _iso(y: int, m: int, d: int) -> str | None:
    try:
        return date(y, m, d).isoformat()
    except ValueError:
        return None


# ---------------------------------------------------------------- numbers ---

def first_number(s: Any) -> float | None:
    """First number in a cell: '₹ 45', '45 (11.19%)', '3.59x', '-5' -> float; '--' -> None."""
    if s is None:
        return None
    if isinstance(s, (int, float)):
        return float(s)
    t = str(s).replace("₹", " ").replace("Rs.", " ").replace("Rs", " ")
    if t.strip().lower() in NA_TOKENS:
        return None
    m = _NUM_RE.search(t)
    if not m:
        return None
    try:
        return float(m.group(0).replace(",", ""))
    except ValueError:
        return None


def pct_in_parens(s: Any) -> float | None:
    """'447 (11.19%)' -> 11.19; None when there is no bracketed percentage."""
    if s is None:
        return None
    m = _PAREN_PCT_RE.search(str(s))
    return float(m.group(1).replace(",", "")) if m else None


def parse_price_band(s: Any) -> tuple[float | None, float | None]:
    """'Rs.371 to Rs.390', '371-390', '₹371 – ₹390' -> (371, 390); '390' -> (390, 390); '-' -> (None, None)."""
    if s is None:
        return (None, None)
    if isinstance(s, (int, float)):
        return (float(s), float(s))
    t = str(s).replace("₹", " ").replace("Rs.", " ").replace("Rs", " ")
    if t.strip().lower() in NA_TOKENS:
        return (None, None)
    nums = [float(x.replace(",", "")) for x in _NUM_RE.findall(t)]
    nums = [n for n in nums if n > 0]
    if not nums:
        return (None, None)
    if len(nums) == 1:
        return (nums[0], nums[0])
    lo, hi = nums[0], nums[1]
    return (min(lo, hi), max(lo, hi))


def crore(s: Any) -> float | None:
    """Issue sizes: '11,327.43', '₹ 45.24 Cr', '350 L' (lakh) -> crore."""
    if s is None:
        return None
    if isinstance(s, (int, float)):
        return float(s)
    t = str(s).replace("₹", " ").replace("Rs.", " ").replace("Rs", " ").replace(",", "")
    v = first_number(t)
    if v is None:
        return None
    low = t.lower()
    if re.search(r"\d\s*(l|lac|lakh|lakhs)\b", low):
        return round(v / 100.0, 4)
    return v


# ------------------------------------------------------------------ names ---

def clean_name(name: Any) -> str:
    """Strip the decorations sites add: 'Foo Ltd IPO', 'Foo (SME)', 'Foo SME IPO', 'Foo Open'.
    '&' becomes 'and' so the same issuer keys identically across sites."""
    t = re.sub(r"\s+", " ", str(name or "")).strip().replace(" & ", " and ")
    t = re.sub(r"\s*\([^)]*\b(ipo|fpo)\b[^)]*\)", "", t, flags=re.IGNORECASE)
    t = re.sub(r"\s+", " ", t)
    prev = None
    while prev != t:
        prev = t
        t = _NAME_STRIP_RE.sub("", t).strip(" -–:|")
    return t


def pretty_case(name: str) -> str:
    """'LENSKART SOLUTIONS LIMITED' -> 'Lenskart Solutions Limited'; keeps short acronyms (FX, HDB, LG)."""
    name = re.sub(r"\s+", " ", name or "").strip()
    if not name or name != name.upper():
        return name
    out = []
    for w in name.split(" "):
        if w.lower() in ("and", "of", "the", "for") and out:
            out.append(w.lower())
        elif len(w) <= 3 and w.isalpha():
            out.append(w)
        else:
            out.append(w[:1].upper() + w[1:].lower())
    return " ".join(out)


def is_sme_marker(*values: Any) -> bool:
    for v in values:
        if v is None:
            continue
        if isinstance(v, bool):
            if v:
                return True
            continue
        s = str(v).strip().lower()
        if s in ("sm", "st", "sme", "y", "yes", "true", "1") or "sme" in s or "emerge" in s:
            return True
    return False


def exchange_label(s: Any, sme: bool | None = None) -> str | None:
    """'BSE, NSE' -> 'NSE,BSE'; 'NSE Emerge' -> 'NSE SME'; 'BSE SME' -> 'BSE SME'; None when unknown."""
    if s is None:
        return None
    low = str(s).lower()
    nse, bse = "nse" in low, "bse" in low
    if sme or "sme" in low or "emerge" in low:
        if nse and not bse:
            return "NSE SME"
        if bse and not nse:
            return "BSE SME"
        return "NSE SME" if nse else ("BSE SME" if bse else None)
    if nse and bse:
        return "NSE,BSE"
    if nse:
        return "NSE"
    if bse:
        return "BSE"
    return None


# ----------------------------------------------------- subscription labels ---

_SNII_RE = re.compile(r"snii|s-nii|shni|s-hni|small|below|less than|(two|2)\s*lakh.*(up\s*to|upto|to)\s*(ten|10)\s*lakh|up\s*to\s*(rs\.?\s*|₹\s*)?(ten|10)\s*(lakh|l\b)|upto\s*(rs\.?\s*|₹\s*)?(ten|10)\s*(lakh|l\b)")
_BNII_RE = re.compile(r"bnii|b-nii|bhni|b-hni|big|above|more than\s*(rs\.?\s*|₹\s*)?(ten|10)\s*(lakh|l\b)|>\s*(rs\.?\s*|₹\s*)?10|more than")


def category_key(label: Any) -> str | None:
    """Map a category label to qib / nii / bnii / snii / retail / employee / total.

    Handles the exchange wording ("Non Institutional Investors(Bid amount of more than
    Two Lakh Rupees upto Ten Lakh Rupees)" is sNII, "...more than Ten Lakh Rupees" bNII)
    and the SME books, where the retail category is called "Individual Investors",
    "Individual Investors (IND category bidding for 2 Lots)" or "Retail Individual"."""
    low = " ".join(str(label or "").lower().split())
    if not low:
        return None
    if "employee" in low:
        return "employee"
    if low.startswith("total") or low.startswith("grand") or low == "overall":
        return "total"
    if "qualified" in low or "qib" in low:
        return "qib"
    if "anchor" in low or "market maker" in low:
        return None
    nii_like = ("nii" in low or "hni" in low or ("non" in low and "institutional" in low)
                or "other than rii" in low or "more than 2 lots" in low or "more than two lots" in low)
    if nii_like or not ("retail" in low or "rii" in low or "individual" in low):
        if _SNII_RE.search(low):
            return "snii"
        if _BNII_RE.search(low) and "lots" not in low:
            return "bnii"
    if nii_like:
        return "nii"
    if "retail" in low or "rii" in low or "individual" in low:
        return "retail"
    return None


# ---------------------------------------------------------- status & ids ---

def derive_status(row: dict, today: date) -> str:
    ld, cd, od = to_date(row.get("listing_date")), to_date(row.get("close_date")), to_date(row.get("open_date"))
    lst = row.get("listing") or {}
    if (ld and ld <= today) or any(lst.get(k) is not None for k in ("open", "close", "gain_pct")):
        return "listed"
    if cd and cd < today:
        return "closed"
    if od and od <= today and (cd is None or cd >= today):
        return "open"
    return "upcoming"


def year_for(parts: dict, today: date) -> int:
    for k in ("listing_date", "open_date", "close_date"):
        d = to_date(parts.get(k))
        if d:
            return d.year
    return today.year


def row_id(parts: dict, today: date) -> str:
    return slugify(parts["name"], year_for(parts, today))


# ------------------------------------------------------------ the builder ---

def _fill_issue_price(out: dict) -> None:
    if out.get("issue_price") is None and out.get("price_band_high") is not None:
        out["issue_price"] = out["price_band_high"]
        out.setdefault("flags", []).append("price_band_only")


def _history_entries(items: Any) -> list[dict]:
    hist = []
    for h in items or []:
        if not isinstance(h, dict) or not h.get("date"):
            continue
        rs = h.get("rs", h.get("gmp_rs"))
        if rs is None:
            continue
        try:
            hist.append({"date": str(h["date"])[:10], "rs": float(rs)})
        except (TypeError, ValueError):
            continue
    return hist


def canonical_row(parts: dict, today: date, as_of: str | None, default_board: str | None = "mainboard") -> dict:
    """Build an IPO object from a partial row.

    `parts` may use the canonical nested shape (`gmp`, `subscription`, `listing`,
    `sources` dicts) or the research tool's flat keys (`gmp_rs`, `gmp_pct`,
    `gmp_history`, `sub_qib`..., `listing_open`, `listing_close`,
    `listing_gain_pct`, `source_urls`); flat keys win when both are present.
    `as_of` is the default date stamp for GMP and subscription figures.
    `default_board` is used when nothing says SME or mainboard; pass None to leave
    the board unset so a later merge with a source that knows can decide (the
    orchestrator fills "mainboard" at the end).
    """
    if not parts.get("name"):
        raise ValueError("row without a name")
    out: dict[str, Any] = {"id": slugify(parts["name"], year_for(parts, today))}
    for k in FIELDS_DIRECT:
        v = parts.get(k)
        if v not in (None, "", []):
            out[k] = v
    board = str(parts.get("board") or "").lower()
    if board.startswith("sme"):
        out["board"] = "sme"
    elif board:
        out["board"] = "mainboard"
    elif is_sme_marker(parts.get("exchange")):
        out["board"] = "sme"
    elif default_board:
        out["board"] = default_board
    else:
        out.pop("board", None)
    if isinstance(parts.get("flags"), list):
        out["flags"] = [f for f in parts["flags"] if isinstance(f, str)]
    _fill_issue_price(out)
    # gmp
    g = parts.get("gmp") if isinstance(parts.get("gmp"), dict) else {}
    hist = _history_entries(parts.get("gmp_history")) + _history_entries(g.get("history"))
    seen = {h["date"]: h for h in hist}
    hist = sorted(seen.values(), key=lambda h: h["date"])
    rs = parts.get("gmp_rs", g.get("rs"))
    pct = parts.get("gmp_pct", g.get("pct"))
    gmp = {"rs": rs, "pct": pct, "as_of": (hist[-1]["date"] if hist else (g.get("as_of") or as_of)), "history": hist}
    out["gmp"] = gmp
    # subscription
    s = parts.get("subscription") if isinstance(parts.get("subscription"), dict) else {}
    sub = {k: parts.get("sub_" + k, s.get(k)) for k in SUB_KEYS}
    sub["as_of"] = s.get("as_of") or as_of
    sub["day"] = s.get("day")
    out["subscription"] = sub
    # listing
    lst = parts.get("listing") if isinstance(parts.get("listing"), dict) else {}
    lo, lc = parts.get("listing_open", lst.get("open")), parts.get("listing_close", lst.get("close"))
    gain = parts.get("listing_gain_pct", lst.get("gain_pct"))
    if lo is not None or lc is not None or gain is not None:
        out["listing"] = {"open": lo, "close": lc, "high": lst.get("high"), "low": lst.get("low"),
                          "gain_pct": gain, "gain_basis": lst.get("gain_basis")}
    else:
        out["listing"] = None
    # sources (assigned after finalise_row so the key order matches the ingest tool)
    srcs: dict[str, str] = {}
    if isinstance(parts.get("sources"), dict):
        srcs.update({str(k): v for k, v in parts["sources"].items() if isinstance(v, str)})
    for i, u in enumerate(parts.get("source_urls") or []):
        if isinstance(u, str) and u.startswith("http"):
            srcs["ref%d" % (i + 1)] = u
    finalise_row(out, today)
    out["sources"] = srcs
    return out


def repair_history_years(hist: list[dict], row: dict) -> list[dict]:
    """GMP pages print 'DD-Mon HH:MM' with no year; an older parser read the hour as a
    two-digit year ('26-Nov 14:02' -> 2014-11-26). Put such a quote back in the year
    that lands it nearest the issue's own dates (day and month are the source's);
    drop a quote that is nowhere near them."""
    ref = next((to_date(row.get(k)) for k in ("close_date", "open_date", "listing_date") if to_date(row.get(k))), None)
    if not ref:
        return hist
    out: dict[str, dict] = {}
    for h in hist:
        d = to_date(h["date"])
        if d is None:
            continue
        if abs((d - ref).days) > 120:
            best = None
            for y in (ref.year - 1, ref.year, ref.year + 1):
                try:
                    c = date(y, d.month, d.day)
                except ValueError:
                    continue
                if abs((c - ref).days) <= 60 and (best is None or abs((c - ref).days) < abs((best - ref).days)):
                    best = c
            if best is None:
                continue
            d = best
        out[d.isoformat()] = {"date": d.isoformat(), "rs": h["rs"]}
    return list(out.values())


def finalise_row(row: dict, today: date) -> dict:
    """Re-derive every computed field in place; safe to call after a merge.

    Computed: issue_price fallback (+flag), gmp.rs from history and gmp.pct from
    rs/issue_price, listing.gain_pct and gain_basis, status, min_lots,
    min_investment, sorted unique flags. Nothing a source gave is overwritten
    except listing.gain_pct when the open/close price lets us compute it.
    """
    _fill_issue_price(row)
    price = row.get("issue_price")
    gmp = dict(row.get("gmp") or {})
    hist = sorted(repair_history_years(_history_entries(gmp.get("history")), row), key=lambda h: h["date"])
    if gmp.get("as_of") and hist and to_date(gmp["as_of"]) and abs((to_date(gmp["as_of"]) - to_date(hist[-1]["date"])).days) > 200:
        gmp["as_of"] = hist[-1]["date"]
    gmp["history"] = hist
    gmp.setdefault("rs", None)
    gmp.setdefault("pct", None)
    gmp.setdefault("as_of", hist[-1]["date"] if hist else None)
    if gmp["rs"] is None and hist:
        gmp["rs"] = hist[-1]["rs"]
    if gmp["pct"] is None and gmp["rs"] is not None and price:
        gmp["pct"] = round(100.0 * gmp["rs"] / price, 2)
    row["gmp"] = gmp
    sub = dict(row.get("subscription") or {})
    for k in SUB_KEYS:
        sub.setdefault(k, None)
        if isinstance(sub[k], (int, float)) and not isinstance(sub[k], bool):
            sub[k] = round(float(sub[k]), 2)       # 128.3581512605042x reads as 128.36x
    sub.setdefault("as_of", None)
    sub.setdefault("day", None)
    row["subscription"] = sub
    lst = row.get("listing")
    if isinstance(lst, dict):
        lo, lc, gain = lst.get("open"), lst.get("close"), lst.get("gain_pct")
        basis = lst.get("gain_basis")
        if price:
            if lc is not None:
                gain, basis = round(100.0 * (lc - price) / price, 2), "close"
            elif lo is not None:
                gain, basis = round(100.0 * (lo - price) / price, 2), "open"
            elif gain is not None:
                basis = "reported"
        elif gain is not None and basis is None:
            basis = "reported"
        if lo is None and lc is None and gain is None:
            row["listing"] = None
        else:
            row["listing"] = {"open": lo, "close": lc, "high": lst.get("high"), "low": lst.get("low"),
                              "gain_pct": gain, "gain_basis": basis}
    else:
        row["listing"] = None
    row["status"] = derive_status(row, today)
    if row.get("board"):
        row["min_lots"] = min_lots_for(row["board"])
        if row.get("lot_size") and price:
            row["min_investment"] = row["min_lots"] * row["lot_size"] * price
    row.setdefault("sources", {})
    row["flags"] = sorted(set(f for f in row.get("flags", []) if isinstance(f, str)))
    return row


def merge(old: dict, new: dict) -> dict:
    """Field-wise merge: a value in `new` wins unless it is None; the nested
    gmp/subscription/listing/sources dicts merge key by key; gmp.history is
    unioned by date; flags are unioned."""
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


# ------------------------------------------------- post-merge helpers (run) ---

def accrue_gmp_history(row: dict) -> dict:
    """Append the current quote to gmp.history under its as_of date so the series
    grows across runs even when no source gives a dated table. Same-day re-runs
    overwrite the same date."""
    gmp = row.get("gmp") or {}
    if gmp.get("rs") is None or not gmp.get("as_of"):
        return row
    hist = {h["date"]: h for h in _history_entries(gmp.get("history"))}
    hist[str(gmp["as_of"])[:10]] = {"date": str(gmp["as_of"])[:10], "rs": float(gmp["rs"])}
    gmp["history"] = sorted(hist.values(), key=lambda h: h["date"])
    row["gmp"] = gmp
    return row


def subscription_day(row: dict) -> int | None:
    """Bidding day the subscription figures refer to: 1 on the open date, counting
    weekdays only (exchange holidays are not known here, so a holiday inside the
    bidding window overstates the day by one)."""
    sub = row.get("subscription") or {}
    if all(sub.get(k) is None for k in SUB_KEYS):
        return None
    od, cd, asof = to_date(row.get("open_date")), to_date(row.get("close_date")), to_date(sub.get("as_of"))
    if not od or not asof or asof < od:
        return None
    if cd and asof > cd:
        asof = cd
    day = sum(1 for i in range((asof - od).days + 1) if (od + timedelta(days=i)).weekday() < 5)
    return max(1, day)


def strip_empty_groups(row: dict) -> dict:
    """Drop a gmp / subscription group that carries no figures, so a source that
    knows nothing about GMP cannot re-date (or blank) another source's quote in
    a merge. Used by the orchestrator, not by the research ingest."""
    g = row.get("gmp") or {}
    if g.get("rs") is None and g.get("pct") is None and not g.get("history"):
        row["gmp"] = None
    s = row.get("subscription") or {}
    if all(s.get(k) is None for k in SUB_KEYS):
        row["subscription"] = None
    return row


def quality_flags(row: dict, today: date) -> list[str]:
    """Data-quality notes beyond what finalise_row sets (sub_partial, no_dates)."""
    flags = set(row.get("flags") or [])
    sub = row.get("subscription") or {}
    cats = [sub.get(k) for k in ("qib", "nii", "retail")]
    if any(c is not None for c in cats + [sub.get("total")]) and any(c is None for c in cats):
        flags.add("sub_partial")
    else:
        flags.discard("sub_partial")
    if not any(row.get(k) for k in ("open_date", "close_date", "listing_date")):
        flags.add("no_dates")
    else:
        flags.discard("no_dates")
    return sorted(flags)


def within_days(iso: str | None, today: date, days: int) -> bool:
    d = to_date(iso)
    return bool(d) and d >= today - timedelta(days=days)


_JUNK_NAME_RE = re.compile(r"(^\s*(name|company|issuer)\s*$|withdraw|cancell)", re.I)
# Debt, units of a trust, rights and partly-paid lines from the exchanges' past-issue feeds.
_NON_EQUITY_NAME_RE = re.compile(
    r"\b(ncds?|debentures?|bonds?|invit|reit|infrastructure investment trust|real estate investment trust"
    r"|rights issue|partly paid|commercial paper|municipal corporation)\b|\btrust\s*$", re.I)
_NON_EQUITY_SYMBOL_RE = re.compile(r"^\d|NCD|ZCB|\d{2}[A-Z]?$")
NON_EQUITY_TYPES = ("DEBT", "NCD", "BOND", "INVIT", "REIT", "RIGHTS")
EQUITY_MAX_PRICE = 10_000          # no Indian equity IPO has been priced near ₹10,000; debt is ₹1,000-₹1,00,000
RELISTING_GAP_DAYS = 60            # an IPO lists ~3 trading days after close; months later is a migration or relisting


def junk_reason(row: dict) -> str | None:
    """Why a row is not an equity IPO anyone can act on (None if it is one).

    Drops: a header parsed as a row; a withdrawn issue; a dateless entry; NSE
    debt / InvIT / REIT lines (by securityType, name or symbol pattern); a
    'price' of ₹10,000+ (a debenture's face value); an exchange row whose
    listing date is months after its bidding closed (an SME migrating to the
    main board, a partly-paid line or a debt series relisting — the source of
    'Ola Electric ₹11' and 'Baheti Recycling ₹774'); and a listed row with no
    lot, no listing outcome, no GMP and no subscription (nothing to show)."""
    name = str(row.get("name") or "")
    if not name.strip() or _JUNK_NAME_RE.search(name):
        return "not an issue"
    st = str(row.get("security_type") or "").upper()
    if st and any(st.startswith(x) for x in NON_EQUITY_TYPES):
        return "non-equity security type"
    if _NON_EQUITY_NAME_RE.search(name):
        return "non-equity name"
    sym = str(row.get("symbol") or "").strip().upper()
    if sym and re.search(r"^\d|NCD|ZCB", sym):
        return "non-equity symbol"
    if not any(row.get(k) for k in ("open_date", "close_date", "listing_date")):
        return "no dates"
    price = row.get("issue_price")
    if isinstance(price, (int, float)) and price >= EQUITY_MAX_PRICE:
        return "price is a debt face value"
    cd, ld = to_date(row.get("close_date")), to_date(row.get("listing_date"))
    if cd and ld and (ld - cd).days > RELISTING_GAP_DAYS:
        return "listing long after close (migration or relisting)"
    if ld and not cd and not row.get("open_date") and not row.get("lot_size"):
        lst = row.get("listing") or {}
        if lst.get("gain_pct") is None:
            return "listing date only"
    if row.get("status") == "listed" or (ld and not cd):
        lst = row.get("listing") or {}
        g, s = row.get("gmp") or {}, row.get("subscription") or {}
        if (not row.get("lot_size") and lst.get("gain_pct") is None and g.get("rs") is None
                and not any(s.get(k) is not None for k in SUB_KEYS)):
            return "listed with no usable data"
    return None


def is_junk(row: dict) -> bool:
    """Rows that are not an IPO anyone can act on (see `junk_reason`)."""
    return junk_reason(row) is not None


# ------------------------------------------------------ duplicate merging ---

_CORP_WORDS = {"ltd", "limited", "pvt", "private", "india", "the", "co", "company", "corp", "corporation", "and", "of", "inc"}


def name_key(name: Any) -> str:
    """A loose matching key: 'Zetwerk Manufacturing Businesses Limited', 'Zetwerk
    Manufacturing Business Ltd.' -> 'zetwerk manufacturing busines'. Lower-case,
    punctuation and '(India)' / Ltd / Limited / Private dropped, a trailing plural
    's' cut from every word."""
    t = clean_name(name).lower().replace("&", " and ")
    t = re.sub(r"[^a-z0-9 ]+", " ", t)
    words = []
    for w in t.split():
        if w in _CORP_WORDS:
            continue
        if len(w) > 4 and w.endswith("ses"):
            w = w[:-2]
        if len(w) > 3 and w.endswith("s"):
            w = w[:-1]
        words.append(w)
    return " ".join(words)


def _completeness(row: dict) -> int:
    n = sum(1 for k in FIELDS_DIRECT if row.get(k) not in (None, "", [], {}))
    n += sum(1 for k in SUB_KEYS if (row.get("subscription") or {}).get(k) is not None)
    n += 2 if (row.get("gmp") or {}).get("rs") is not None else 0
    n += 2 if (row.get("listing") or {}).get("gain_pct") is not None else 0
    return n


def same_issue(a: dict, b: dict) -> bool:
    """Two rows describe one IPO: same loose name key, or one key is a word-prefix of the
    other and the bidding dates or prices agree, or the open date and issue price match."""
    ka, kb = name_key(a.get("name")), name_key(b.get("name"))
    if not ka or not kb:
        return False

    def agree(f: str) -> bool | None:
        va, vb = a.get(f), b.get(f)
        if va in (None, "") or vb in (None, ""):
            return None
        return va == vb

    dates = [agree(f) for f in ("open_date", "close_date", "listing_date")]
    if any(d is False for d in dates):
        return False
    years = {str(r.get(f))[:4] for r in (a, b) for f in ("open_date", "close_date", "listing_date") if r.get(f)}
    if ka == kb:
        return len(years) <= 1 or any(d is True for d in dates)
    shorter, longer = sorted((ka, kb), key=len)
    prefix = longer.split()[: len(shorter.split())] == shorter.split()
    if prefix and (any(d is True for d in dates) or agree("issue_price") is True or agree("price_band_high") is True):
        return True
    return (agree("open_date") is True and (agree("issue_price") is True or agree("price_band_high") is True)
            and shorter.split()[0] == longer.split()[0])


def preferred_id(rows: list[dict]) -> str:
    """Deterministic id for a merged group: a row carrying an exchange symbol, then the
    longest (legal) name, then the alphabetically first id."""
    return sorted(rows, key=lambda r: (0 if r.get("symbol") else 1, -len(name_key(r.get("name")).split()),
                                       -len(str(r.get("name") or "")), r["id"]))[0]["id"]


def dedupe(rows: list[dict]) -> tuple[list[dict], dict[str, str]]:
    """Merge rows that are the same IPO (see `same_issue`). The most complete row is the
    base and the others fill its gaps. Returns (rows, {dropped id: kept id}) and records
    the dropped ids under `aliases` on the kept row."""
    groups: list[list[dict]] = []
    for r in rows:
        for g in groups:
            if any(same_issue(r, x) for x in g):
                g.append(r)
                break
        else:
            groups.append([r])
    out, alias = [], {}
    for g in groups:
        if len(g) == 1:
            out.append(g[0])
            continue
        keep = preferred_id(g)
        ordered = sorted(g, key=_completeness)              # least complete first, most complete last wins
        merged: dict = {}
        for r in ordered:
            merged = merge(merged, r)
        best = max(g, key=lambda r: (1 if r.get("symbol") else 0, len(str(r.get("name") or ""))))
        merged["id"], merged["name"] = keep, best.get("name")
        aliases = set(merged.get("aliases") or [])
        for r in g:
            aliases |= set(r.get("aliases") or [])
            if r["id"] != keep:
                aliases.add(r["id"])
                alias[r["id"]] = keep
        aliases.discard(keep)
        merged["aliases"] = sorted(aliases)
        out.append(merged)
    return out, alias


# ---------------------------------------------------------------- board ---

AUTHORITATIVE_BOARD_SOURCES = ("nse", "chittorgarh", "chittorgarh_tracker")


def resolve_board(partials: list[tuple[str, dict]], prev_board: str | None = None) -> tuple[str | None, str | None]:
    """(board, basis). Authoritative: NSE's securityType / series, Chittorgarh's SME list
    and tracker, an exchange label naming SME. Then any other source's SME badge.
    None when nothing says (the caller then applies `infer_board`)."""
    sme_auth = main_auth = sme_any = False
    for src, p in partials:
        b, ex = p.get("board"), str(p.get("exchange") or "")
        if "SME" in ex.upper():
            sme_auth = True
        if src in AUTHORITATIVE_BOARD_SOURCES:
            if b == "sme":
                sme_auth = True
            elif b == "mainboard" and (src != "nse" or p.get("security_type") or p.get("series")):
                main_auth = True
        elif b == "sme":
            sme_any = True
    if sme_auth:
        return "sme", "source"
    if main_auth:
        return "mainboard", "source"
    if sme_any:
        return "sme", "source"
    return None, None


def infer_board(row: dict) -> str | None:
    """Heuristic for a row no source classified: an SME application is ₹1 lakh+ at the
    minimum lot with lots of 400+ shares and a small issue; a mainboard lot is ₹15,000ish."""
    lot, price, size = row.get("lot_size"), row.get("issue_price") or row.get("price_band_high"), row.get("issue_size_cr")
    if not lot or not price:
        return None
    if lot >= 400 and lot * price >= 100_000 and (size is None or size < 150):
        return "sme"
    return "mainboard"


# ------------------------------------------------------------- GMP sources ---

GMP_FRESH_DAYS = 3


def gmp_consensus(row: dict, quotes: list[dict], today: date) -> dict:
    """Combine every source's latest quote into the row's gmp: `sources` keeps one entry
    per source ({source, rs, as_of, url}), `rs` is the median of the fresh quotes (no
    older than 3 days), `spread_rs` their max-min, `disagree` true when the spread is
    more than max(₹5, 25% of the median). With no fresh quote the precedence pick stays."""
    gmp = dict(row.get("gmp") or {})
    by_src = {q["source"]: q for q in (gmp.get("sources") or []) if isinstance(q, dict) and q.get("source")}
    for q in quotes:
        if q.get("rs") is None:
            continue
        old = by_src.get(q["source"])
        if old and str(old.get("as_of") or "") > str(q.get("as_of") or ""):
            continue
        by_src[q["source"]] = {"source": q["source"], "rs": float(q["rs"]), "as_of": q.get("as_of"), "url": q.get("url")}
    srcs = sorted(by_src.values(), key=lambda q: q["source"])
    gmp["sources"] = srcs
    fresh = []
    for q in srcs:
        d = to_date(q.get("as_of"))
        if d and 0 <= (today - d).days <= GMP_FRESH_DAYS:
            fresh.append(q)
    if fresh:
        vals = sorted(q["rs"] for q in fresh)
        n = len(vals)
        med = vals[n // 2] if n % 2 else (vals[n // 2 - 1] + vals[n // 2]) / 2.0
        gmp["rs"] = round(med, 2)
        gmp["as_of"] = max(str(q["as_of"]) for q in fresh)[:10]
        price = row.get("issue_price")
        gmp["pct"] = round(100.0 * gmp["rs"] / price, 2) if price else None
        spread = vals[-1] - vals[0]
        gmp["spread_rs"] = round(spread, 2)
        gmp["n_fresh"] = n
        gmp["disagree"] = bool(n >= 2 and spread > max(5.0, 0.25 * abs(med)))
    else:
        gmp.setdefault("spread_rs", None)
        gmp["n_fresh"] = 0
        gmp["disagree"] = False
    row["gmp"] = gmp
    return row


# ------------------------------------------------------- timeline & facts ---

# NSE trading holidays (weekday closures), from NSE's published lists. Used to
# derive the T+1 / T+2 / T+3 timeline when no source gives it; a missing holiday
# makes an estimate a day early, which is why such dates carry timeline_estimated.
NSE_HOLIDAYS = {
    "2025-02-26", "2025-03-14", "2025-03-31", "2025-04-10", "2025-04-14", "2025-04-18", "2025-05-01",
    "2025-08-15", "2025-08-27", "2025-10-02", "2025-10-21", "2025-10-22", "2025-11-05", "2025-12-25",
    # 2026: NSE /api/holiday-master?type=trading (CM segment), read 2026-11-15
    "2026-01-15", "2026-01-26", "2026-02-15", "2026-03-03", "2026-03-21", "2026-03-26", "2026-03-31",
    "2026-04-03", "2026-04-14", "2026-05-01", "2026-05-28", "2026-06-26", "2026-08-15", "2026-09-14",
    "2026-10-02", "2026-10-20", "2026-11-08", "2026-11-10", "2026-11-24", "2026-12-25",
}


def is_trading_day(d: date, holidays: set[str] | None = None) -> bool:
    return d.weekday() < 5 and d.isoformat() not in (holidays if holidays is not None else NSE_HOLIDAYS)


def add_trading_days(d: date, n: int, holidays: set[str] | None = None) -> date:
    cur = d
    while n > 0:
        cur += timedelta(days=1)
        if is_trading_day(cur, holidays):
            n -= 1
    return cur


def fill_timeline(row: dict, holidays: set[str] | None = None) -> dict:
    """SEBI's T+3 timetable from the close date T: basis of allotment T+1, refunds and
    demat credit T+2, listing T+3 (trading days). Only gaps are filled, and
    `timeline_estimated` says so; a source's dates always win."""
    cd = to_date(row.get("close_date"))
    if not cd:
        return row
    est = False
    for key, n in (("allotment_date", 1), ("refund_date", 2), ("demat_date", 2)):
        if not row.get(key):
            row[key] = add_trading_days(cd, n, holidays).isoformat()
            est = True
    if est:
        row["timeline_estimated"] = True
    elif "timeline_estimated" in row and row["timeline_estimated"]:
        row["timeline_estimated"] = False
    anchor = row.get("anchor")
    ad = to_date(row.get("allotment_date"))
    if isinstance(anchor, dict) and ad:
        if not anchor.get("lockin_50pct_date"):
            anchor["lockin_50pct_date"] = (ad + timedelta(days=30)).isoformat()
        if not anchor.get("lockin_rest_date"):
            anchor["lockin_rest_date"] = (ad + timedelta(days=90)).isoformat()
    return row


REGISTRARS = (
    (r"kfin|karvy", "KFin Technologies", "https://ipostatus.kfintech.com/"),
    (r"link\s*intime|mufg|in\.mpms", "MUFG Intime India (Link Intime)", "https://in.mpms.mufg.com/Initial_Offer/public-issues.html"),
    (r"bigshare", "Bigshare Services", "https://ipo.bigshareonline.com/IPO_Status.html"),
    (r"skyline", "Skyline Financial Services", "https://www.skylinerta.com/ipo.php"),
    (r"cameo", "Cameo Corporate Services", "https://ipo.cameoindia.com/"),
    (r"maashitla", "Maashitla Securities", "https://maashitla.com/allotment-status/public-issues"),
    (r"purva", "Purva Sharegistry", "https://www.purvashare.com/investor-service/ipo-query"),
    (r"integrated registry", "Integrated Registry Management Services", "https://www.integratedregistry.in/RegistrarsToSTA.aspx"),
    (r"kosmic", "Kosmic RTA", "https://www.kosmic.co.in/ipo-allotment-status"),
    (r"beetal", "Beetal Financial & Computer Services", "https://www.beetalfinancial.com/ipo-allotment-status"),
)


def registrar_info(name: Any) -> dict | None:
    """{name, status_url} for a registrar named by a source, with the registrar's own
    public allotment-status page when it is one we know; status_url None otherwise."""
    if isinstance(name, dict):
        name = name.get("name")
    if not name or not str(name).strip():
        return None
    raw = re.sub(r"\s+", " ", str(name)).strip()
    for pat, _canon, url in REGISTRARS:
        if re.search(pat, raw, re.I):
            return {"name": raw, "status_url": url}
    return {"name": raw, "status_url": None}
