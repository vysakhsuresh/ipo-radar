"""IPOWatch.in GMP page: a third, independent grey-market quote.

Structure as seen on 2026-11-15 (fixture: fetch/tests/fixtures/ipowatch_gmp.html):
the page is a Next.js app whose GMP table is drawn in the browser, but the server
embeds the rows in the React payload (`self.__next_f.push([1, "<chunk>"])` script
tags) as a JSON array under the key "initialIpos":

  {"name": "Crystal Crop Protection", "type": "Mainboard" | "NSE Emerge" | "BSE SME",
   "issueStatus": "Upcoming" | "Open" | "Closed" | ..., "issuePrice": 272,
   "priceBand": "₹259.00 - ₹272.00", "lotSize": "55 shares", "issueSize": "455.72 Cr",
   "openDate": "18 Nov 2026", "closeDate": "20 Nov 2026",
   "allotmentDate": "2026-11-23T00:00:00", "listingDate": "2026-11-26T00:00:00",
   "gmp": 27, "gmpDisplay": "₹27.00", "premiumPct": 9.93, ...}

A quote of 0 with gmpDisplay "—" means "not quoted". If the payload key moves,
the parser returns [] and the refresh carries on with the other two sources.
"""
from __future__ import annotations

import json
import re
from datetime import date
from typing import Any

from fetch.common import Http
from fetch.normalize import clean_name, parse_date, parse_price_band, crore, first_number

URL_GMP = "https://ipowatch.in/ipo-grey-market-premium-latest-ipo-gmp/"
_PUSH_RE = re.compile(r'self\.__next_f\.push\(\[1,\s*("(?:[^"\\]|\\.)*")\]\)', re.S)


def _payload(html: str) -> str:
    """The concatenated React flight chunks (each a JSON string literal)."""
    parts = []
    for m in _PUSH_RE.finditer(html or ""):
        try:
            parts.append(json.loads(m.group(1)))
        except ValueError:
            continue
    return "".join(parts)


def _initial_ipos(html: str) -> list[dict]:
    for text in (_payload(html), html or ""):
        i = text.find('"initialIpos":')
        if i < 0:
            continue
        try:
            arr, _ = json.JSONDecoder().raw_decode(text[i + len('"initialIpos":'):])
        except ValueError:
            continue
        if isinstance(arr, list):
            return [r for r in arr if isinstance(r, dict)]
    return []


def parse_gmp(html: str, url: str, today: date | None = None) -> list[dict]:
    """The GMP page -> partial rows {name, board, dates, band, lot, size, gmp{rs, pct, as_of}}."""
    out: list[dict] = []
    for it in _initial_ipos(html):
        name = clean_name(it.get("name"))
        if not name:
            continue
        r: dict[str, Any] = {"name": name}
        typ = str(it.get("type") or "").lower()
        if "sme" in typ or "emerge" in typ:
            r["board"] = "sme"
            r["exchange"] = "BSE SME" if "bse" in typ else "NSE SME"
        lo, hi = parse_price_band(it.get("priceBand"))
        if hi is not None:
            r["price_band_low"], r["price_band_high"] = lo, hi
        lot = first_number(it.get("lotSize"))
        if lot and lot > 0:
            r["lot_size"] = int(lot)
        size = crore(it.get("issueSize"))
        if size:
            r["issue_size_cr"] = size
        for key, src in (("open_date", "openDate"), ("close_date", "closeDate"), ("allotment_date", "allotmentDate"), ("listing_date", "listingDate")):
            d = parse_date(it.get(src), ref=today)
            if d:
                r[key] = d
        rs = first_number(it.get("gmp"))
        shown = str(it.get("gmpDisplay") or "").strip()
        quoted = rs is not None and not (rs == 0 and (not shown or shown in ("—", "-", "--")))
        if quoted:
            price = first_number(it.get("issuePrice")) or hi
            pct = round(100.0 * rs / price, 2) if price else None
            r["gmp"] = {"rs": rs, "pct": pct, "as_of": today.isoformat() if today else None}
        r["sources"] = {k: url for k in r if k not in ("sources",)}
        out.append(r)
    return out


def fetch(http: Http, today: date) -> list[dict]:
    html = http.get_html(URL_GMP)
    return parse_gmp(html, URL_GMP, today) if html else []
