"""Offline tests for the fetch package.

The fixtures under fixtures/ are hand-written in the page / payload structure
the parsers expect (see each source's docstring); they prove the parsers map
that structure to the canonical fields, not that the live sites still look
like this. `StubHttp` serves fixtures by URL so the fetch() orchestration and
fetch/run.py can be exercised end to end without a network.
"""
from __future__ import annotations

import json
import os
from datetime import date

import pytest

from fetch import history as history_mod
from fetch import normalize as nz
from fetch import run
from fetch.common import Provenance, load_json
from fetch.sources import chittorgarh as cg
from fetch.sources import investorgain as ig
from fetch.sources import market, nse

FIX = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")
TODAY = date(2026, 10, 26)


def fixture(name: str) -> str:
    with open(os.path.join(FIX, name), encoding="utf-8") as f:
        return f.read()


def fixture_json(name: str):
    return json.loads(fixture(name))


class StubHttp:
    """Serves fixture content by URL substring; records what was asked for."""

    def __init__(self, routes: dict[str, str]):
        self.routes = routes
        self.prov = Provenance()
        self.calls: list[str] = []

    def _lookup(self, url: str):
        self.calls.append(url)
        for key, name in self.routes.items():
            if key in url:
                self.prov.add(url, True, 200)
                return fixture(name)
        self.prov.add(url, False, 404, note="stub: no route")
        return None

    def get(self, url, **kw):
        return self._lookup(url)

    def get_html(self, url, **kw):
        return self._lookup(url)

    def get_json(self, url, **kw):
        body = self._lookup(url)
        return json.loads(body) if body else None


def full_stub() -> StubHttp:
    return StubHttp({
        nse.URL_CURRENT: "nse_current.json",
        nse.URL_UPCOMING: "nse_upcoming.json",
        "ipo-detail?symbol=LENSKART": "nse_detail.json",
        "ipo-active-category?symbol=LENSKART": "nse_active_category.json",
        cg.URL_MAINBOARD_LIST: "chittorgarh_mainboard_list.html",
        cg.URL_SME_LIST: "chittorgarh_sme_list.html",
        cg.URL_GMP: "chittorgarh_gmp.html",
        "/ipo_subscription/lenskart-solutions-ipo/": "chittorgarh_subscription.html",
        cg.URL_TRACKER_MAINBOARD: "chittorgarh_tracker.html",
        ig.URL_LIVE_GMP: "investorgain_live_gmp.html",
        "/gmp/lenskart-solutions-ipo-gmp/": "investorgain_gmp_history.html",
        ig.URL_GMP_PERFORMANCE: "investorgain_gmp_performance.html",
        market.URL_NSE_ALL: "nse_all_indices.json",
        market.URL_YF_NIFTY: "yahoo_chart.json",
        market.URL_YF_VIX: "yahoo_vix.json",
    })


def by_id(rows: list[dict]) -> dict[str, dict]:
    return {r["id"]: r for r in rows}


# ------------------------------------------------------------- normalize ---

def test_parse_date_formats():
    ref = date(2026, 10, 26)
    assert nz.parse_date("06-Nov-2024") == "2024-11-06"
    assert nz.parse_date("Nov 6, 2024") == "2024-11-06"
    assert nz.parse_date("6 Nov 2024") == "2024-11-06"
    assert nz.parse_date("2024-11-06") == "2024-11-06"
    assert nz.parse_date("06/11/2024") == "2024-11-06"
    assert nz.parse_date("Oct 23, 2026 5:00 PM") == "2026-10-23"
    assert nz.parse_date("31-Oct", ref=ref) == "2026-10-31"
    assert nz.parse_date("4-Jan", ref=ref) == "2027-01-04"          # year rolls forward near December
    assert nz.parse_date("15 Aug", ref=date(2027, 1, 10)) == "2026-08-15"  # and back in January
    assert nz.parse_date("-") is None and nz.parse_date(None) is None and nz.parse_date("TBA") is None


def test_price_band_and_numbers():
    assert nz.parse_price_band("Rs.371 to Rs.390") == (371.0, 390.0)
    assert nz.parse_price_band("₹66 – ₹70") == (66.0, 70.0)
    assert nz.parse_price_band("390") == (390.0, 390.0)
    assert nz.parse_price_band("-") == (None, None)
    assert nz.first_number("45 (11.19%)") == 45.0
    assert nz.first_number("₹ -5") == -5.0
    assert nz.pct_in_parens("447 (11.19%)") == 11.19
    assert nz.crore("₹ 11,327.43 Cr") == 11327.43
    assert nz.crore("350 L") == 3.5


def test_clean_name_and_category_key():
    assert nz.clean_name("Lenskart Solutions IPO") == "Lenskart Solutions"
    assert nz.clean_name("Foo Ltd SME IPO Open") == "Foo Ltd"
    assert nz.clean_name("Foo (SME)") == "Foo"
    assert nz.pretty_case("FX MULTITECH LIMITED") == "FX Multitech Limited"
    labels = ["Qualified Institutional Buyers(QIBs)", "Non Institutional Investors", "bNII (bids above ₹10L)",
              "sNII (bids below ₹10L)", "Retail Individual Investors(RIIs)", "Employees", "Total", "Others"]
    assert [nz.category_key(x) for x in labels] == ["qib", "nii", "bnii", "snii", "retail", "employee", "total", None]


def test_canonical_row_nested_shape_derives_fields():
    parts = {"name": "Foo Ltd", "board": "sme", "open_date": "2026-10-20", "close_date": "2026-10-22",
             "price_band_low": 100, "price_band_high": 110, "lot_size": 1200,
             "gmp": {"rs": 11, "as_of": "2026-10-21", "history": [{"date": "2026-10-20", "rs": 9}]},
             "subscription": {"qib": 2.5, "total": 10.0, "as_of": "2026-10-22"},
             "listing": {"open": 120, "close": 125}, "sources": {"gmp": "https://x"}}
    row = nz.canonical_row(parts, date(2026, 10, 26), as_of="2026-10-26", default_board=None)
    assert row["id"] == "foo-2026"
    assert row["issue_price"] == 110 and "price_band_only" in row["flags"]
    assert row["min_lots"] == 2 and row["min_investment"] == 2 * 1200 * 110
    assert row["gmp"]["pct"] == 10.0 and row["gmp"]["history"][-1]["rs"] == 9.0 and row["gmp"]["as_of"] == "2026-10-20"
    assert row["subscription"]["qib"] == 2.5 and row["subscription"]["as_of"] == "2026-10-22"
    assert row["listing"]["gain_pct"] == 13.64 and row["listing"]["gain_basis"] == "close"
    assert row["status"] == "listed" and row["sources"] == {"gmp": "https://x"}


def test_canonical_row_board_default_and_merge_history_union():
    row = nz.canonical_row({"name": "Bar"}, TODAY, as_of=None, default_board=None)
    assert "board" not in row and "min_lots" not in row
    old = {"gmp": {"rs": 10, "history": [{"date": "2026-10-20", "rs": 10.0}]}, "flags": ["a"]}
    new = {"gmp": {"rs": None, "history": [{"date": "2026-10-21", "rs": 12.0}]}, "flags": ["b"], "name": None}
    m = nz.merge(old, new)
    assert m["gmp"]["rs"] == 10 and [h["date"] for h in m["gmp"]["history"]] == ["2026-10-20", "2026-10-21"]
    assert m["flags"] == ["a", "b"] and "name" not in m


# ------------------------------------------------------------------- NSE ---

def test_nse_issue_list_plain_list_and_sme_series():
    rows = nse.parse_issue_list(fixture_json("nse_current.json"), nse.URL_CURRENT, TODAY)
    assert [r["name"] for r in rows] == ["Lenskart Solutions Limited", "FX Multitech Limited"]
    lk, fx = rows
    assert lk["board"] == "mainboard" and lk["exchange"] == "NSE,BSE" and lk["symbol"] == "LENSKART"
    assert lk["open_date"] == "2026-10-31" and lk["close_date"] == "2026-11-04"
    assert (lk["price_band_low"], lk["price_band_high"]) == (382.0, 402.0) and "issue_price" not in lk
    assert lk["lot_size"] == 37 and lk["subscription"]["total"] == 1.41
    assert lk["issue_size_cr"] == pytest.approx(7276.2) and "issue_size_estimated" in lk["flags"]
    assert fx["board"] == "sme" and fx["exchange"] == "NSE SME" and fx["issue_price"] == 116.0 and fx["lot_size"] == 1200
    assert lk["sources"]["open_date"] == nse.URL_CURRENT


def test_nse_issue_list_data_wrapper_and_blanks():
    rows = nse.parse_issue_list(fixture_json("nse_upcoming.json"), nse.URL_UPCOMING, TODAY)
    assert len(rows) == 1 and rows[0]["name"] == "Pine Labs Limited"
    assert rows[0]["open_date"] == "2026-11-10" and "price_band_high" not in rows[0] and "lot_size" not in rows[0]
    assert nse.parse_issue_list({"unexpected": "shape"}, nse.URL_UPCOMING, TODAY) == []
    assert nse.parse_issue_list(None, nse.URL_UPCOMING, TODAY) == []


def test_nse_detail_and_category_table():
    d = nse.parse_detail(fixture_json("nse_detail.json"), "detail-url", TODAY)
    assert d["listing_date"] == "2026-11-10" and d["lot_size"] == 37 and d["price_band_high"] == 402.0
    assert d["subscription"] == {"qib": 4.0, "nii": 2.0, "retail": 0.75, "employee": 1.5, "total": 2.86, "as_of": "2026-11-03"}
    cats = nse.parse_categories(fixture_json("nse_active_category.json"))
    assert cats == {"qib": 6.0, "nii": 3.0, "retail": 1.2, "total": 4.3}
    assert nse.parse_categories({"nothing": []}) == {}


def test_nse_fetch_merges_detail_and_live_categories():
    http = full_stub()
    rows = nse.fetch(http, date(2026, 11, 2))
    lk = next(r for r in rows if r["symbol"] == "LENSKART")
    assert lk["listing_date"] == "2026-11-10"                      # from the detail endpoint
    assert lk["subscription"]["qib"] == 6.0 and lk["subscription"]["as_of"] == "2026-11-04"  # active-category wins
    assert lk["sources"]["subscription"].endswith("ipo-active-category?symbol=LENSKART")
    assert any(u == nse.HOME for u in http.calls)                 # cookie warm-up happened
    assert {r["symbol"] for r in rows} == {"LENSKART", "FXMULTI", "PINELABS"}


# ----------------------------------------------------------- Chittorgarh ---

def test_chittorgarh_mainboard_list():
    rows = by_id({**r, "id": nz.row_id(r, TODAY)} for r in cg.parse_list(fixture("chittorgarh_mainboard_list.html"), "mainboard", cg.URL_MAINBOARD_LIST, TODAY))
    assert set(rows) == {"lenskart-solutions-2026", "zetwerk-manufacturing-businesses-2026", "groww-2026"}
    lk = rows["lenskart-solutions-2026"]
    assert lk["open_date"] == "2026-10-31" and lk["close_date"] == "2026-11-04" and lk["listing_date"] == "2026-11-10"
    assert (lk["price_band_low"], lk["price_band_high"]) == (382.0, 402.0) and lk["lot_size"] == 37
    assert lk["issue_size_cr"] == 7278.02 and lk["exchange"] == "NSE,BSE"
    assert lk["ipo_url"] == "https://www.chittorgarh.com/ipo/lenskart-solutions-ipo/3122/"
    zw = rows["zetwerk-manufacturing-businesses-2026"]
    assert zw["issue_price"] == 151.0 and zw["ipo_url"].startswith("https://www.chittorgarh.com/ipo/zetwerk-ipo/")
    gr = rows["groww-2026"]
    assert "price_band_high" not in gr and "lot_size" not in gr and "listing_date" not in gr


def test_chittorgarh_sme_list_exchange_and_board():
    rows = cg.parse_list(fixture("chittorgarh_sme_list.html"), "sme", cg.URL_SME_LIST, TODAY)
    fx, mw = rows
    assert fx["board"] == "sme" and fx["exchange"] == "BSE SME" and fx["issue_size_cr"] == 45.24
    assert mw["exchange"] == "NSE SME" and mw["issue_size_cr"] == 24.5 and mw["issue_price"] == 60.0 and mw["lot_size"] == 2000


def test_chittorgarh_gmp_report():
    rows = by_id({**r, "id": nz.row_id(r, TODAY)} for r in cg.parse_gmp_report(fixture("chittorgarh_gmp.html"), cg.URL_GMP, TODAY))
    lk = rows["lenskart-solutions-2026"]
    assert lk["gmp"] == {"rs": 45.0, "pct": 11.19, "as_of": "2026-10-26"} and lk["board"] == "mainboard"
    mw = rows["midwest-tubes-2026"]
    assert mw["board"] == "sme" and mw["gmp"]["rs"] == -3.0 and mw["gmp"]["pct"] == -5.0 and mw["gmp"]["as_of"] == "2026-10-25"
    gr = rows["groww-2026"]
    assert gr["gmp"]["rs"] is None and "gmp_not_quoted" in gr["flags"]


def test_chittorgarh_subscription_page_and_daywise_fallback():
    sub = cg.parse_subscription(fixture("chittorgarh_subscription.html"), "u", TODAY)
    assert sub == {"qib": 6.0, "nii": 3.0, "bnii": 3.5, "snii": 2.0, "retail": 1.2, "employee": 1.5, "total": 4.3, "as_of": "2026-11-04"}
    html = fixture("chittorgarh_subscription.html")
    only_daywise = html[: html.index("<table")] + html[html.index("<h2>"):]
    sub2 = cg.parse_subscription(only_daywise, "u", TODAY)
    assert sub2["qib"] == 6.0 and sub2["total"] == 4.3 and sub2["as_of"] == "2026-11-04" and "bnii" not in sub2
    assert cg.parse_subscription("<html><body>no tables</body></html>", "u", TODAY) is None
    assert cg.subscription_url("https://www.chittorgarh.com/ipo/groww-ipo/3101/") == "https://www.chittorgarh.com/ipo_subscription/groww-ipo/3101/"


def test_chittorgarh_tracker():
    rows = by_id({**r, "id": nz.row_id(r, TODAY)} for r in cg.parse_tracker(fixture("chittorgarh_tracker.html"), "mainboard", cg.URL_TRACKER_MAINBOARD, TODAY))
    zw = rows["zetwerk-manufacturing-businesses-2026"]
    assert zw["issue_price"] == 151.0 and zw["listing_date"] == "2026-10-23"
    assert zw["listing"] == {"open": 159.25, "close": 138.25, "high": None, "low": None, "gain_pct": -8.44}
    assert rows["tata-capital-2026"]["listing"]["close"] == 331.5
    mw = rows["midwest-tubes-2026"]
    assert "listing" not in mw and mw["board"] == "sme" and mw["exchange"] == "NSE SME"


def test_chittorgarh_fetch_adds_live_subscription_for_open_issue():
    http = full_stub()
    rows = by_id({**r, "id": nz.row_id(r, date(2026, 11, 2))} for r in cg.fetch(http, date(2026, 11, 2)))
    lk = rows["lenskart-solutions-2026"]
    assert lk["subscription"]["qib"] == 6.0 and lk["sources"]["subscription"].startswith("https://www.chittorgarh.com/ipo_subscription/")
    assert lk["gmp"]["rs"] == 45.0 and lk["lot_size"] == 37          # list + GMP report merged by slug
    assert rows["midwest-tubes-2026"]["board"] == "sme"
    assert not any("/ipo_subscription/groww" in u for u in http.calls)  # upcoming: no subscription page


# ----------------------------------------------------------- InvestorGain ---

def test_investorgain_live_gmp():
    rows = by_id({**r, "id": nz.row_id(r, TODAY)} for r in ig.parse_live_gmp(fixture("investorgain_live_gmp.html"), ig.URL_LIVE_GMP, TODAY))
    lk = rows["lenskart-solutions-2026"]
    assert lk["gmp"] == {"rs": 47.0, "pct": 11.69, "as_of": "2026-10-26"}
    assert lk["issue_price"] == 402.0 and lk["lot_size"] == 37 and lk["issue_size_cr"] == 7278.02
    assert (lk["open_date"], lk["close_date"], lk["allotment_date"], lk["listing_date"]) == ("2026-10-31", "2026-11-04", "2026-11-06", "2026-11-10")
    assert lk["gmp_url"] == "https://www.investorgain.com/gmp/lenskart-solutions-ipo-gmp/2301/" and "board" not in lk
    mw = rows["midwest-tubes-2026"]
    assert mw["board"] == "sme" and mw["gmp"]["rs"] == -2.0 and mw["gmp"]["pct"] == -3.33
    gr = rows["groww-2026"]
    assert gr["gmp"]["rs"] is None and "gmp_not_quoted" in gr["flags"] and gr["open_date"] == "2026-11-05"


def test_investorgain_gmp_history_and_performance():
    hist = ig.parse_gmp_history(fixture("investorgain_gmp_history.html"), TODAY)
    assert hist == [{"date": "2026-10-24", "rs": 40.0}, {"date": "2026-10-25", "rs": 45.0}, {"date": "2026-10-26", "rs": 47.0}]
    perf = by_id({**r, "id": nz.row_id(r, TODAY)} for r in ig.parse_gmp_performance(fixture("investorgain_gmp_performance.html"), ig.URL_GMP_PERFORMANCE, TODAY))
    zw = perf["zetwerk-manufacturing-businesses-2026"]
    assert zw["issue_price"] == 151.0 and zw["gmp"]["rs"] == 1.0 and zw["gmp"]["pct"] == 0.66
    assert zw["listing"]["open"] == 159.25 and zw["listing"]["gain_pct"] == 5.46 and zw["listing_date"] == "2026-10-23"


def test_investorgain_fetch_attaches_dated_history():
    http = full_stub()
    rows = by_id({**r, "id": nz.row_id(r, TODAY)} for r in ig.fetch(http, TODAY))
    lk = rows["lenskart-solutions-2026"]
    assert [h["rs"] for h in lk["gmp"]["history"]] == [40.0, 45.0, 47.0] and lk["sources"]["gmp_history"] == lk["gmp_url"]
    assert "history" not in rows["groww-2026"].get("gmp", {})     # no route for its page -> nothing attached


# ----------------------------------------------------------------- market ---

def test_market_parsers_and_changes():
    got = market.parse_nse_all_indices(fixture_json("nse_all_indices.json"), TODAY)
    assert got == {"nifty": 25914.65, "nifty_1m_pct": 2.15, "vix": 11.84, "as_of": "2026-10-24"}
    series = market.parse_yahoo_chart(fixture_json("yahoo_chart.json"))
    assert len(series) == 65 and series[-1] == ("2026-10-23", 25900.0)   # the null close was skipped
    ch = market.changes(series, TODAY)
    assert ch["nifty"] == 25900.0 and ch["as_of"] == "2026-10-23"
    assert ch["nifty_1w_pct"] == pytest.approx(0.57, abs=0.01)
    assert ch["nifty_1m_pct"] == pytest.approx(2.55, abs=0.01)
    assert ch["nifty_3m_pct"] == pytest.approx(7.92, abs=0.01)
    assert market.parse_yahoo_chart({"chart": {"result": None}}) == []


def test_market_fetch_combines_nse_and_yahoo():
    m = market.fetch(full_stub(), TODAY)
    assert set(m) == set(market.KEYS)
    assert m["nifty"] == 25914.65 and m["nifty_1m_pct"] == 2.15 and m["vix"] == 11.84 and m["as_of"] == "2026-10-24"
    assert m["nifty_1w_pct"] == pytest.approx(0.57, abs=0.01) and m["nifty_3m_pct"] == pytest.approx(7.92, abs=0.01)
    m2 = market.fetch(StubHttp({market.URL_YF_NIFTY: "yahoo_chart.json", market.URL_YF_VIX: "yahoo_vix.json"}), TODAY)
    assert m2["nifty"] == 25900.0 and m2["vix"] == 11.84 and m2["as_of"] == "2026-10-23"
    assert market.fetch(StubHttp({}), TODAY) == market.empty()


# ------------------------------------------------------------------- run ---

def _gmp_source(rs: float, as_of: str):
    return lambda http, today: [{"name": "Lenskart Solutions", "open_date": "2026-10-31", "close_date": "2026-11-04",
                                 "price_band_high": 402, "lot_size": 37, "gmp": {"rs": rs, "as_of": as_of}}]


def test_run_keeps_gmp_history_across_runs_and_survives_a_failing_source(tmp_path):
    out = str(tmp_path)
    no_market = lambda http, today: {}  # noqa: E731
    s1 = run.refresh(out, date(2026, 10, 25), cache=False, sources=[("investorgain", _gmp_source(45, "2026-10-25"))], market_fn=no_market)
    row = by_id(load_json(os.path.join(out, "ipos.json"))["ipos"])["lenskart-solutions-2026"]
    assert row["gmp"]["history"] == [{"date": "2026-10-25", "rs": 45.0}] and row["gmp"]["pct"] == 11.19
    assert row["board"] == "mainboard" and row["min_lots"] == 1 and row["min_investment"] == 37 * 402
    assert s1["pipeline"] == 1

    s2 = run.refresh(out, date(2026, 10, 26), cache=False, sources=[("investorgain", _gmp_source(47, "2026-10-26"))], market_fn=no_market)
    row = by_id(load_json(os.path.join(out, "ipos.json"))["ipos"])["lenskart-solutions-2026"]
    assert [h["rs"] for h in row["gmp"]["history"]] == [45.0, 47.0] and row["gmp"]["rs"] == 47

    def boom(http, today):
        raise RuntimeError("site down")

    s3 = run.refresh(out, date(2026, 10, 27), cache=False, sources=[("investorgain", boom), ("nse", lambda h, t: [{"name": "Lenskart Solutions", "open_date": "2026-10-31", "lot_size": 37}])], market_fn=no_market)
    live = load_json(os.path.join(out, "ipos.json"))
    row = by_id(live["ipos"])["lenskart-solutions-2026"]
    assert [h["rs"] for h in row["gmp"]["history"]] == [45.0, 47.0] and row["gmp"]["rs"] == 47   # carried forward
    assert s3["sources"]["investorgain"]["ok"] is False and "site down" in s3["sources"]["investorgain"]["note"]
    assert s3["sources"]["nse"]["ok"] is True and s3["sources_ok"] == 1
    assert any(e["url"] == "source:investorgain" and not e["ok"] for e in live["sources"])
    assert live["generated_at"] and set(live["market"]) == set(market.KEYS)


def test_run_precedence_exchange_wins_dates_trackers_win_gmp(tmp_path):
    srcs = [
        ("investorgain", lambda h, t: [{"name": "Lenskart Solutions", "open_date": "2026-10-30", "close_date": "2026-11-03", "gmp": {"rs": 47, "as_of": "2026-10-26"}}]),
        ("chittorgarh", lambda h, t: [{"name": "Lenskart Solutions", "open_date": "2026-10-31", "close_date": "2026-11-05", "lot_size": 37,
                                       "gmp": {"rs": 45, "as_of": "2026-10-26"}, "subscription": {"qib": 3.0, "total": 1.5, "as_of": "2026-10-26"}}]),
        ("nse", lambda h, t: [{"name": "LENSKART SOLUTIONS LIMITED", "open_date": "2026-10-31", "close_date": "2026-11-04",
                               "price_band_low": 382, "price_band_high": 402, "subscription": {"total": 2.0, "as_of": "2026-10-26"}}]),
    ]
    run.refresh(str(tmp_path), TODAY, cache=False, sources=srcs, market_fn=lambda h, t: {})
    row = by_id(load_json(os.path.join(str(tmp_path), "ipos.json"))["ipos"])["lenskart-solutions-2026"]
    assert row["close_date"] == "2026-11-04" and row["open_date"] == "2026-10-31"       # NSE wins dates
    assert row["subscription"]["total"] == 2.0 and row["subscription"]["qib"] == 3.0     # NSE wins, gaps filled
    assert row["gmp"]["rs"] == 47 and row["gmp"]["pct"] == 11.69                        # InvestorGain wins GMP
    assert row["issue_price"] == 402 and row["lot_size"] == 37 and row["status"] == "upcoming"
    assert "sub_partial" in row["flags"]


def test_run_moves_listed_rows_to_history_and_keeps_history_append_only(tmp_path):
    out = str(tmp_path)
    with open(os.path.join(out, "history.json"), "w") as f:
        json.dump({"generated_at": None, "rows": [{"id": "old-ipo-2025", "name": "Old IPO", "board": "mainboard", "listing_date": "2025-03-03",
                                                   "issue_price": 100, "listing": {"open": 110, "close": 120, "gain_pct": 20.0, "gain_basis": "close"},
                                                   "gmp": {"rs": 15, "pct": 15.0, "as_of": "2025-03-02", "history": []}, "subscription": {}, "sources": {}, "flags": []}]}, f)
    tracker = lambda h, t: [  # noqa: E731
        {"name": "Zetwerk Manufacturing Businesses", "board": "mainboard", "listing_date": "2026-10-23", "issue_price": 151, "listing": {"open": 159.25, "close": 138.25}},
        {"name": "Summer Listing", "board": "sme", "listing_date": "2026-08-01", "issue_price": 50, "listing": {"open": 60, "close": None}},
    ]
    s = run.refresh(out, TODAY, cache=False, sources=[("chittorgarh_tracker", tracker)], market_fn=lambda h, t: {})
    live, hist = load_json(os.path.join(out, "ipos.json")), load_json(os.path.join(out, "history.json"))
    assert [r["id"] for r in live["ipos"]] == ["zetwerk-manufacturing-businesses-2026"]       # listed within 30 days stays
    h = by_id(hist["rows"])
    assert set(h) == {"old-ipo-2025", "summer-listing-2026", "zetwerk-manufacturing-businesses-2026"}
    assert h["zetwerk-manufacturing-businesses-2026"]["listing"]["gain_pct"] == -8.44 and h["zetwerk-manufacturing-businesses-2026"]["listing"]["gain_basis"] == "close"
    assert h["summer-listing-2026"]["listing"]["gain_basis"] == "open" and h["summer-listing-2026"]["min_lots"] == 2
    assert h["old-ipo-2025"]["gmp"]["rs"] == 15
    assert s["history"] == 3 and s["counts"]["listed"] == 1


def test_run_end_to_end_with_all_default_sources_on_fixtures(tmp_path):
    out = str(tmp_path)
    today = date(2026, 11, 2)
    s = run.refresh(out, today, cache=False, http=full_stub(), sources=run.default_sources())
    assert s["sources_ok"] == 4
    live = load_json(os.path.join(out, "ipos.json"))
    rows = by_id(live["ipos"])
    lk = rows["lenskart-solutions-2026"]
    assert lk["status"] == "open" and lk["board"] == "mainboard" and lk["exchange"] == "NSE,BSE"
    assert lk["issue_price"] == 402.0 and lk["lot_size"] == 37 and lk["listing_date"] == "2026-11-10"
    assert lk["subscription"]["qib"] == 6.0 and lk["subscription"]["bnii"] == 3.5 and lk["subscription"]["day"] == 3
    assert lk["gmp"]["rs"] == 47.0 and [h["rs"] for h in lk["gmp"]["history"]] == [40.0, 45.0, 47.0]
    assert lk["issue_size_cr"] == 7278.02                                   # Chittorgarh's rupee figure beats NSE's share-count estimate
    mw = rows["midwest-tubes-2026"]
    assert mw["board"] == "sme" and mw["min_lots"] == 2 and mw["gmp"]["rs"] == -2.0 and mw["status"] == "closed"
    assert rows["zetwerk-manufacturing-businesses-2026"]["status"] == "listed"
    assert by_id(load_json(os.path.join(out, "history.json"))["rows"])["zetwerk-manufacturing-businesses-2026"]["listing"]["gain_pct"] == -8.44
    assert live["market"]["nifty"] == 25914.65 and live["market"]["vix"] == 11.84
    assert any(e["url"] == "source:nse" and e["ok"] for e in live["sources"])


def test_run_main_exits_zero_even_when_everything_fails(tmp_path, monkeypatch, capsys):
    def boom(*a, **k):
        raise RuntimeError("no network")
    monkeypatch.setattr(run, "default_sources", lambda: [("nse", boom), ("chittorgarh", boom)])
    monkeypatch.setattr(run.market, "fetch", boom)
    assert run.main(["--out", str(tmp_path), "--today", "2026-10-26", "--no-cache"]) == 0
    out = capsys.readouterr().out
    assert out.startswith("refresh 2026-10-26:") and "sources 0/2 ok" in out
    live = load_json(os.path.join(str(tmp_path), "ipos.json"))
    assert live["ipos"] == [] and live["market"]["nifty"] is None


def test_history_build_merges_pre_listing_gmp_with_tracker_outcome():
    rows = by_id(history_mod.build_history(full_stub(), [2026], date(2026, 11, 2)))
    zw = rows["zetwerk-manufacturing-businesses-2026"]
    assert zw["gmp"]["rs"] == 1.0 and zw["gmp"]["pct"] == 0.66                      # from the GMP-performance report
    assert zw["listing"]["close"] == 138.25 and zw["listing"]["gain_pct"] == -8.44    # tracker's close wins the outcome
    assert "midwest-tubes-2026" not in rows                                          # no outcome yet
    merged = history_mod.merge_into_history({"rows": [{"id": "zetwerk-manufacturing-businesses-2026", "name": "Zetwerk", "board": "mainboard",
                                                       "issue_price": 151, "listing": {"close": 138.3, "gain_pct": -8.41},
                                                       "gmp": {"rs": 1.0}, "sources": {}, "flags": []}]}, list(rows.values()), date(2026, 11, 2))
    assert len(merged["rows"]) == 2 and by_id(merged["rows"])["zetwerk-manufacturing-businesses-2026"]["listing"]["close"] == 138.25
