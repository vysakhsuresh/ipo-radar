"""Market backdrop: Nifty 50 level with 1-week / 1-month / 3-month changes, and
India VIX.

Structure as understood in Oct 2026, UNVERIFIED LIVE (written without network
access). Two sources, each optional:

  * NSE: /api/allIndices returns {"data": [{"index": "NIFTY 50", "last": ...,
    "percentChange": ..., "perChange30d": ..., "perChange365d": ...}, ...,
    {"index": "INDIA VIX", "last": ...}], "timestamp": "26-Oct-2026 15:30:00"};
    /api/equity-stockIndices?index=NIFTY%2050 returns {"data": [{"symbol":
    "NIFTY 50", "lastPrice": ..., "perChange30d": ...}, ...], "timestamp": ...}
    (the first row is the index itself). Needs the same cookie warm-up as the
    IPO endpoints (fetch/sources/nse.py). Key names are matched by alias.
  * Yahoo Finance chart API: /v8/finance/chart/%5ENSEI?range=3mo&interval=1d
    returns {"chart": {"result": [{"timestamp": [...], "indicators": {"quote":
    [{"close": [...]}]}}]}}; the same for %5EINDIAVIX. Daily closes let us
    compute all three changes ourselves. Yahoo sometimes answers 429 to
    unauthenticated clients; the retry in Http covers the occasional one.

The 1-week / 1-month / 3-month changes are last close vs the last close on or
before 7 / 30 / 91 calendar days earlier. Returns
{"nifty", "nifty_1w_pct", "nifty_1m_pct", "nifty_3m_pct", "vix", "as_of"} with
None for anything no source gave.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any

from fetch.common import Http, num
from fetch.normalize import parse_date

URL_NSE_ALL = "https://www.nseindia.com/api/allIndices"
URL_NSE_NIFTY = "https://www.nseindia.com/api/equity-stockIndices?index=NIFTY%2050"
URL_YF_NIFTY = "https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?range=3mo&interval=1d"
URL_YF_VIX = "https://query1.finance.yahoo.com/v8/finance/chart/%5EINDIAVIX?range=5d&interval=1d"
YF_HEADERS = {"Accept": "application/json"}
KEYS = ("nifty", "nifty_1w_pct", "nifty_1m_pct", "nifty_3m_pct", "vix", "as_of")


def empty() -> dict[str, Any]:
    return {k: None for k in KEYS}


def _norm(k: Any) -> str:
    return "".join(ch for ch in str(k).lower() if ch.isalnum())


def _pick(d: dict, *aliases: str) -> Any:
    flat = {_norm(k): v for k, v in d.items()}
    for a in aliases:
        v = flat.get(_norm(a))
        if v not in (None, "", "-"):
            return v
    return None


def _rows(obj: Any) -> list[dict]:
    if isinstance(obj, list):
        return [r for r in obj if isinstance(r, dict)]
    if isinstance(obj, dict):
        for k in ("data", "indices", "result"):
            if isinstance(obj.get(k), list):
                return [r for r in obj[k] if isinstance(r, dict)]
    return []


def parse_nse_all_indices(obj: Any, today: date | None = None) -> dict[str, Any]:
    """allIndices (or equity-stockIndices) payload -> {nifty, nifty_1m_pct, vix, as_of} (missing -> absent)."""
    out: dict[str, Any] = {}
    for r in _rows(obj):
        name = str(_pick(r, "index", "indexSymbol", "symbol", "indexName", "identifier") or "").strip().upper()
        last = num(_pick(r, "last", "lastPrice", "ltp", "close", "closePrice"))
        if name in ("NIFTY 50", "NIFTY50") and last and "nifty" not in out:
            out["nifty"] = last
            m1 = num(_pick(r, "perChange30d", "perChange30D", "change30d", "pChange30d"))
            if m1 is not None:
                out["nifty_1m_pct"] = m1
        elif name in ("INDIA VIX", "INDIAVIX") and last and "vix" not in out:
            out["vix"] = last
    if out and isinstance(obj, dict):
        ts = parse_date(_pick(obj, "timestamp", "asOn", "updateTime", "date"), ref=today)
        if ts:
            out["as_of"] = ts
    return out


def parse_yahoo_chart(obj: Any) -> list[tuple[str, float]]:
    """Yahoo chart payload -> [(ISO date, close), ...] in date order, skipping null closes."""
    try:
        res = obj["chart"]["result"][0]
        ts = res.get("timestamp") or []
        closes = res["indicators"]["quote"][0].get("close") or []
    except (KeyError, IndexError, TypeError):
        return []
    out = []
    for t, c in zip(ts, closes):
        if c is None or t is None:
            continue
        try:
            d = datetime.fromtimestamp(int(t), tz=timezone.utc).date().isoformat()
            out.append((d, float(c)))
        except (ValueError, OverflowError, TypeError):
            continue
    out.sort()
    return out


def changes(series: list[tuple[str, float]], as_of: date | None = None) -> dict[str, Any]:
    """Last close and % change vs the last close on or before 7/30/91 days earlier."""
    if not series:
        return {}
    last_d, last_c = series[-1]
    if as_of and last_d > as_of.isoformat():
        series = [s for s in series if s[0] <= as_of.isoformat()]
        if not series:
            return {}
        last_d, last_c = series[-1]
    out: dict[str, Any] = {"nifty": round(last_c, 2), "as_of": last_d}
    ref = date.fromisoformat(last_d)
    for key, days in (("nifty_1w_pct", 7), ("nifty_1m_pct", 30), ("nifty_3m_pct", 91)):
        cutoff = (ref - timedelta(days=days)).isoformat()
        older = [c for d, c in series if d <= cutoff]
        if older and older[-1]:
            out[key] = round(100.0 * (last_c / older[-1] - 1.0), 2)
    return out


def fetch(http: Http, today: date) -> dict[str, Any]:
    """NSE first (level, 1m change, VIX), Yahoo for the 1w/3m changes and as a fallback for everything."""
    out = empty()
    try:
        from fetch.sources.nse import warm_up, HEADERS
        warm_up(http)
        for url in (URL_NSE_ALL, URL_NSE_NIFTY):
            got = parse_nse_all_indices(http.get_json(url, headers=HEADERS), today)
            for k, v in got.items():
                if out.get(k) is None:
                    out[k] = v
            if out["nifty"] is not None and out["vix"] is not None:
                break
    except Exception as e:  # noqa: BLE001 - a market source must never abort the run
        http.prov.add(URL_NSE_ALL, False, note=f"{type(e).__name__}: {e}")
    try:
        series = parse_yahoo_chart(http.get_json(URL_YF_NIFTY, headers=YF_HEADERS))
        ch = changes(series, today)
        for k, v in ch.items():
            if out.get(k) is None:
                out[k] = v
        if out["vix"] is None:
            vix = parse_yahoo_chart(http.get_json(URL_YF_VIX, headers=YF_HEADERS))
            if vix:
                out["vix"] = round(vix[-1][1], 2)
    except Exception as e:  # noqa: BLE001
        http.prov.add(URL_YF_NIFTY, False, note=f"{type(e).__name__}: {e}")
    if out["as_of"] is None and out["nifty"] is not None:
        out["as_of"] = today.isoformat()
    return out
