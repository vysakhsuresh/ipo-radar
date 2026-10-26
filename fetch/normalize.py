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
                 "fresh_issue_cr", "ofs_cr", "sector", "pe_post_issue", "lead_managers", "anchor_cr", "notes"]
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
    m = re.search(r"\b(\d{1,2})(?:st|nd|rd|th)?[-/ ,]+([A-Za-z]{3,9})\.?[-/ ,]+(\d{4}|\d{2})\b", t)
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

def category_key(label: Any) -> str | None:
    """Map a category label to qib / nii / bnii / snii / retail / employee / total."""
    low = " ".join(str(label or "").lower().split())
    if not low:
        return None
    if "employee" in low:
        return "employee"
    if low.startswith("total") or low.startswith("grand") or low == "overall":
        return "total"
    if "qualified" in low or "qib" in low:
        return "qib"
    if "bnii" in low or "b-nii" in low or "big" in low or "above" in low or "more than" in low or "> 10" in low:
        return "bnii"
    if "snii" in low or "s-nii" in low or "small" in low or "below" in low or "less than" in low or "up to" in low or "upto" in low:
        return "snii"
    if "retail" in low or "rii" in low or ("individual" in low and "non" not in low):
        return "retail"
    if ("non" in low and "institutional" in low) or "nii" in low or "hni" in low:
        return "nii"
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
    hist = sorted(_history_entries(gmp.get("history")), key=lambda h: h["date"])
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


def is_junk(row: dict) -> bool:
    """Rows that are not an IPO anyone can act on: a header parsed as a row, a
    withdrawn issue, or a dateless entry from an exchange's past/debt feed."""
    name = str(row.get("name") or "")
    if not name.strip() or _JUNK_NAME_RE.search(name):
        return True
    if not any(row.get(k) for k in ("open_date", "close_date", "listing_date")):
        return True
    return False
