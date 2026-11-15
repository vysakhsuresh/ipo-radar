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


# ------------------------------------------------- post-listing performance ---

URL_YF_STOCK = "https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?range={rng}&interval=1d"
# Trading sessions after the listing day (the listing day is session 0).
HORIZONS = (("d1", 0), ("w1", 4), ("m1", 20), ("m3", 62), ("m6", 124))


def yahoo_tickers(symbol: str | None, board: str | None) -> list[str]:
    """Yahoo's names for an NSE symbol: 'ZETWERK.NS' for the main board; NSE Emerge
    (SME) lines trade as 'VPFL-SM.NS' (checked 2026-11-15), with '.NS' as a fallback."""
    if not symbol:
        return []
    s = str(symbol).strip().upper().replace("&", "%26")
    return [f"{s}-SM.NS", f"{s}.NS"] if board == "sme" else [f"{s}.NS"]


def parse_yahoo_ohlc(obj: Any) -> list[dict]:
    """Yahoo chart payload -> [{date, open, high, low, close}] in date order (IST dates), null closes skipped."""
    try:
        res = obj["chart"]["result"][0]
        ts = res.get("timestamp") or []
        q = res["indicators"]["quote"][0]
        off = int((res.get("meta") or {}).get("gmtoffset") or 19800)
    except (KeyError, IndexError, TypeError, ValueError):
        return []
    out = []
    for i, t in enumerate(ts):
        try:
            closes = q.get("close") or []
            c = closes[i] if i < len(closes) else None
            if c is None or t is None:
                continue
            d = datetime.fromtimestamp(int(t) + off, tz=timezone.utc).date().isoformat()

            def pick(k: str):
                arr = q.get(k) or []
                return arr[i] if i < len(arr) else None
            out.append({"date": d, "open": pick("open"), "high": pick("high"), "low": pick("low"), "close": float(c)})
        except (ValueError, OverflowError, TypeError):
            continue
    out.sort(key=lambda r: r["date"])
    return out


def post_listing_from(series: list[dict], listing_date: str | None, issue_price: float | None) -> dict | None:
    """{last_price, as_of, d1, w1, m1, m3, m6}: % of the close at each horizon over the issue
    price (None until that many sessions have passed), counted from the first session on
    or after the listing date (d1 = listing-day close, w1 = 5th session, m1 = 21st,
    m3 = 63rd, m6 = 125th)."""
    if not series or not issue_price or not listing_date:
        return None
    sess = [r for r in series if r["date"] >= str(listing_date)[:10]]
    if not sess:
        return None
    out: dict[str, Any] = {"last_price": round(sess[-1]["close"], 2), "as_of": sess[-1]["date"]}
    try:
        gap = (date.fromisoformat(sess[0]["date"]) - date.fromisoformat(str(listing_date)[:10])).days
    except ValueError:
        gap = 99
    if gap > 6:
        # the chart does not reach back to the listing day: horizons would be measured from the wrong day
        out.update({k: None for k, _ in HORIZONS})
        out["listing_open"] = out["listing_close"] = None
        return out
    for key, n in HORIZONS:
        out[key] = round(100.0 * (sess[n]["close"] - issue_price) / issue_price, 2) if len(sess) > n else None
    out["listing_open"] = round(sess[0]["open"], 2) if sess[0].get("open") is not None else None
    out["listing_close"] = round(sess[0]["close"], 2)
    return out


URL_NSE_HIST = ("https://www.nseindia.com/api/historicalOR/generateSecurityWiseHistoricalData"
                "?from={frm}&to={to}&symbol={sym}&type=priceVolumeDeliverable&series=ALL")


def parse_nse_history(obj: Any) -> list[dict]:
    """NSE security-wise history ({"data": [{"mTIMESTAMP": "13-Nov-2026", "CH_OPENING_PRICE", "CH_CLOSING_PRICE",
    "CH_TRADE_HIGH_PRICE", "CH_TRADE_LOW_PRICE"}]}) -> [{date, open, high, low, close}] in date order."""
    out = []
    for r in _rows(obj):
        d = parse_date(r.get("mTIMESTAMP") or r.get("mtimestamp"))
        c = num(r.get("CH_CLOSING_PRICE", r.get("chClosingPrice")))
        if not d or c is None:
            continue
        out.append({"date": d, "open": num(r.get("CH_OPENING_PRICE", r.get("chOpeningPrice"))),
                    "high": num(r.get("CH_TRADE_HIGH_PRICE", r.get("chTradeHighPrice"))),
                    "low": num(r.get("CH_TRADE_LOW_PRICE", r.get("chTradeLowPrice"))), "close": c})
    by_date = {r["date"]: r for r in out}
    return [by_date[k] for k in sorted(by_date)]


_NSE_WARM: set[int] = set()


def fetch_post_listing(http: Http, symbol: str | None, board: str | None, listing_date: str | None,
                       issue_price: float | None, today: date) -> dict | None:
    """Post-listing performance: NSE's own daily history first (official closes; it
    covers new and SME listings Yahoo has no history for), Yahoo's chart as the
    fallback. None on any failure (non-fatal)."""
    ld = parse_date(listing_date)
    if not ld or not issue_price:
        return None
    if symbol:
        try:
            from fetch.sources.nse import warm_up, HEADERS
            if id(http) not in _NSE_WARM:
                warm_up(http)
                _NSE_WARM.add(id(http))
            start = date.fromisoformat(ld)
            end = min(today, start + timedelta(days=360))
            url = URL_NSE_HIST.format(frm=start.strftime("%d-%m-%Y"), to=end.strftime("%d-%m-%Y"), sym=str(symbol).strip().upper().replace("&", "%26"))
            got = post_listing_from(parse_nse_history(http.get_json(url, headers=HEADERS, retries=1)), ld, issue_price)
            if got and got.get("d1") is not None:
                got["ticker"] = f"NSE:{symbol}"
                return got
        except Exception:  # noqa: BLE001
            pass
    # a period1/period2 window came back with only the latest candle (2026-11-15); a range does not
    age = (today - date.fromisoformat(ld)).days
    rng = "1y" if age < 330 else ("2y" if age < 690 else "5y")
    for ticker in yahoo_tickers(symbol, board):
        try:
            obj = http.get_json(URL_YF_STOCK.format(ticker=ticker, rng=rng), headers=YF_HEADERS, retries=1)
        except Exception:  # noqa: BLE001
            obj = None
        got = post_listing_from(parse_yahoo_ohlc(obj), ld, issue_price) if obj else None
        if got:
            got["ticker"] = ticker
            return got
    return None
