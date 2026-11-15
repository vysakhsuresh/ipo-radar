"""Data-quality rules: non-IPO filtering, duplicate merging, board resolution,
SME subscription labels, multi-source GMP consensus, timeline, registrar,
post-listing performance and the new source parsers (fixtures captured live
on 2026-11-15)."""
from __future__ import annotations

import json
import os
from datetime import date

from fetch import normalize as nz
from fetch import run
from fetch.common import load_json
from fetch.sources import chittorgarh as cg
from fetch.sources import ipowatch, market, nse
from fetch.sources.htmltable import table_from_records

FIX = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")
TODAY = date(2026, 11, 15)


def fx(name):
    with open(os.path.join(FIX, name), encoding="utf-8") as f:
        return f.read()


# ------------------------------------------------------- category labels ---

def test_exchange_and_sme_category_labels():
    k = nz.category_key
    assert k("Non Institutional Investors(Bid amount of more than Two Lakh Rupees upto Ten Lakh Rupees)") == "snii"
    assert k("Non Institutional Investors(Bid amount of more than Ten Lakh Rupees)") == "bnii"
    assert k("Individual Investors (IND category bidding for 2 Lots)") == "retail"
    assert k("Individual Investor") == "retail" and k("Retail Individual") == "retail"
    assert k("Individual Investors (IND)") == "retail"
    assert k("Individuals(IND category bidding for more than 2 Lots)") == "nii"
    assert k("Individuals(Other than RIIs)") == "nii"
    assert k("HNI") == "nii" and k("bNII (> ₹10L)") == "bnii" and k("sNII (< ₹10L)") == "snii"
    assert k("Anchor Investors") is None and k("Market Maker") is None and k("Corporates") is None


def test_time_is_not_read_as_a_year_and_old_misreads_are_repaired():
    assert nz.parse_date("26-Nov 14:02", ref=TODAY) == "2026-11-26"
    assert nz.parse_date("06-Nov-24") == "2024-11-06"
    row = nz.finalise_row({"name": "X", "close_date": "2026-11-20",
                           "gmp": {"rs": 5, "as_of": "2014-11-19", "history": [{"date": "2014-11-19", "rs": 4}, {"date": "2026-11-18", "rs": 3},
                                                                              {"date": "2011-03-02", "rs": 9}]}}, TODAY)
    assert [h["date"] for h in row["gmp"]["history"]] == ["2026-11-18", "2026-11-19"] and row["gmp"]["as_of"] == "2026-11-19"


def test_subscription_multiples_rounded_to_two_places():
    row = nz.canonical_row({"name": "Bls Polymers", "open_date": "2026-10-27", "subscription": {"retail": 128.3581512605042, "total": 241.2249}},
                           TODAY, as_of="2026-10-29")
    assert row["subscription"]["retail"] == 128.36 and row["subscription"]["total"] == 241.22


# ------------------------------------------------------------- NSE feed ---

def test_nse_past_issues_drop_debt_invit_reit_and_use_security_type_for_board():
    rows = nse.parse_issue_list(json.loads(fx("nse_past_issues.json")), nse.URL_PAST, TODAY)
    by = {r["symbol"]: r for r in rows}
    assert "SMCG04" not in by and "857LTFL36" not in by            # DEBT
    assert "CUBEINVIT" not in by and "BAGMANE" not in by            # InvIT / REIT
    assert by["VPFL"]["board"] == "sme" and by["VPFL"]["open_date"] == "2026-11-02" and by["VPFL"]["close_date"] == "2026-11-04"
    assert by["BCSSL"]["board"] == "mainboard" and by["BCSSL"]["issue_price"] == 82.0
    ola = nz.canonical_row(by["OLAPP"], TODAY, as_of=None)       # Ola's 2024 IPO 'listing' on 2026-11-06 = a partly-paid line
    assert nz.junk_reason(ola) == "listing long after close (migration or relisting)"


def test_nse_detail_registrar_lot_face_value_and_sme_zero_books():
    d = nse.parse_detail(json.loads(fx("nse_detail_sme.json")), "u", TODAY)
    assert d["registrar"] == {"name": "Cameo Corporate Services Limited"}
    assert d["lot_size"] == 1200 and d["face_value"] == 10.0 and d["board"] == "sme"
    # NSE prints 0.00x for SME categories (no 'offered' figure): unknown, never zero
    assert all(v is None for k, v in (d.get("subscription") or {}).items() if k in nz.SUB_KEYS)
    m = nse.parse_categories(json.loads(fx("nse_detail_mainboard_bids.json")))
    assert m["qib"] == 4.73 and m["snii"] == 0.84 and m["bnii"] == 1.68 and m["retail"] == 0.73 and m["total"] == 3.06


# --------------------------------------------------------------- junk ---

def test_junk_rules():
    base = {"open_date": "2026-11-02", "close_date": "2026-11-04", "lot_size": 100}
    assert nz.junk_reason({**base, "name": "L&T Finance Limited", "issue_price": 99987}) == "price is a debt face value"
    assert nz.junk_reason({**base, "name": "Foo", "security_type": "DEBT"}) == "non-equity security type"
    assert nz.junk_reason({**base, "name": "Cube Highways Trust"}) == "non-equity name"
    assert nz.junk_reason({**base, "name": "Foo Finance", "symbol": "PFCZCB1"}) == "non-equity symbol"
    assert nz.junk_reason({"name": "Arham Technologies", "listing_date": "2026-10-30", "issue_price": 193, "status": "listed"}) is not None
    assert nz.junk_reason({**base, "name": "Vedant Poly Fabs", "issue_price": 94}) is None


# ---------------------------------------------------------- duplicates ---

def test_zetwerk_variants_merge_into_one_row_with_aliases():
    rows = [
        {"id": "zetwerk-2026", "name": "Zetwerk", "open_date": "2026-10-15", "issue_price": 151.0, "gmp": {"rs": 1.2}},
        {"id": "zetwerk-manufacturing-business-2026", "name": "Zetwerk Manufacturing Business Ltd", "open_date": "2026-10-15",
         "listing_date": "2026-10-23", "issue_price": 151.0, "listing": {"close": 138.25, "gain_pct": -8.44}},
        {"id": "zetwerk-manufacturing-businesses-2026", "name": "Zetwerk Manufacturing Businesses Limited", "symbol": "ZETWERK",
         "open_date": "2026-10-15", "close_date": "2026-10-19", "issue_price": 151.0, "lot_size": 99},
        {"id": "other-2026", "name": "Zeta Labs", "open_date": "2026-10-15", "issue_price": 90.0},
    ]
    out, alias = nz.dedupe(rows)
    assert len(out) == 2
    z = next(r for r in out if r["id"].startswith("zetwerk"))
    assert z["id"] == "zetwerk-manufacturing-businesses-2026"
    assert z["aliases"] == ["zetwerk-2026", "zetwerk-manufacturing-business-2026"]
    assert z["lot_size"] == 99 and z["listing"]["gain_pct"] == -8.44 and z["gmp"]["rs"] == 1.2
    assert nz.name_key("Zetwerk Manufacturing Businesses Limited") == nz.name_key("Zetwerk Manufacturing Business Ltd.")


def test_different_issues_with_similar_names_do_not_merge():
    a = {"id": "a", "name": "Shree Ram Industries", "open_date": "2026-01-05", "issue_price": 50}
    b = {"id": "b", "name": "Shree Ram Industries", "open_date": "2025-03-05", "issue_price": 80}
    assert not nz.same_issue(a, b)


# --------------------------------------------------------------- board ---

def test_board_resolution_prefers_authoritative_sources_then_heuristic():
    parts = [("investorgain", {"board": "mainboard"}), ("nse", {"board": "sme", "security_type": "SME"})]
    assert nz.resolve_board(parts) == ("sme", "source")
    assert nz.resolve_board([("chittorgarh", {"board": "mainboard"})]) == ("mainboard", "source")
    assert nz.resolve_board([("ipowatch", {})]) == (None, None)
    assert nz.infer_board({"lot_size": 1200, "issue_price": 120, "issue_size_cr": 34.56}) == "sme"      # HGS (India)
    assert nz.infer_board({"lot_size": 55, "issue_price": 271, "issue_size_cr": 712}) == "mainboard"


def test_sme_min_lots_is_two():
    row = nz.finalise_row({"name": "Watrana Rentals", "board": "sme", "lot_size": 600, "issue_price": 245}, TODAY)
    assert row["min_lots"] == 2 and row["min_investment"] == 2 * 600 * 245


# ----------------------------------------------------------------- GMP ---

def test_gmp_consensus_median_spread_disagree_and_stale_quotes_ignored():
    row = {"issue_price": 200.0, "gmp": {"rs": 30, "as_of": "2026-11-15"}}
    quotes = [{"source": "investorgain", "rs": 30, "as_of": "2026-11-15", "url": "a"},
              {"source": "chittorgarh", "rs": 28, "as_of": "2026-11-14", "url": "b"},
              {"source": "ipowatch", "rs": 10, "as_of": "2026-11-15", "url": "c"},
              {"source": "old", "rs": 90, "as_of": "2026-11-01", "url": "d"}]
    g = nz.gmp_consensus(row, quotes, TODAY)["gmp"]
    assert g["rs"] == 28.0 and g["pct"] == 14.0 and g["spread_rs"] == 20.0 and g["disagree"] is True
    assert g["n_fresh"] == 3 and len(g["sources"]) == 4 and g["as_of"] == "2026-11-15"
    calm = nz.gmp_consensus({"issue_price": 200.0}, quotes[:2], TODAY)["gmp"]
    assert calm["rs"] == 29.0 and calm["disagree"] is False


def test_ipowatch_parser_reads_the_embedded_payload():
    rows = {r["name"]: r for r in ipowatch.parse_gmp(fx("ipowatch_gmp.html"), ipowatch.URL_GMP, TODAY)}
    cc = rows["Crystal Crop Protection"]
    assert cc["gmp"]["rs"] == 27.0 and cc["price_band_high"] == 272.0 and cc["lot_size"] == 55 and cc["open_date"] == "2026-11-18"
    assert rows["Watrana Rentals"]["board"] == "sme" and rows["Watrana Rentals"]["gmp"]["rs"] == 20.0
    assert "gmp" not in rows["Hindustan Coca Cola"]                   # '—' is not a ₹0 quote
    assert ipowatch.parse_gmp("<html>changed</html>", "u", TODAY) == []


# -------------------------------------------------------- chittorgarh ---

def test_chittorgarh_tracker_json_endpoint():
    t = table_from_records(json.loads(fx("chittorgarh_tracker_api.json"))["reportTableData"])
    rows = {r["name"]: r for r in cg.parse_tracker_tables([t], "mainboard", "api", TODAY)}
    z = rows["Zetwerk Manufacturing Business Ltd."]
    assert z["listing"]["close"] == 138.25 and z["listing"]["gain_pct"] == -8.44 and z["symbol"] == "ZETWERK"
    assert z["listing_date"] == "2026-10-23" and z["ipo_url"] == "https://www.chittorgarh.com/ipo/zetwerk-ipo/3091/"
    assert "symbol" not in rows["Antala Industries Ltd."]


def test_chittorgarh_ipo_page_facts():
    r = cg.parse_ipo_page(fx("chittorgarh_ipo_page.html"), "https://www.chittorgarh.com/ipo/vedant-poly-fabs-ipo/3143/", TODAY)
    assert r["name"] == "Vedant Poly Fabs" and r["board"] == "sme" and r["exchange"] == "NSE SME"
    assert (r["open_date"], r["close_date"], r["allotment_date"], r["refund_date"], r["demat_date"], r["listing_date"]) == \
        ("2026-11-02", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-06", "2026-11-09")
    assert r["face_value"] == 10.0 and r["lot_size"] == 1200 and r["issue_size_cr"] == 56.68
    assert r["fresh_issue_cr"] == 48.14 and r["ofs_cr"] == 5.67 and r["symbol"] == "VPFL"
    assert r["registrar"] == {"name": "Cameo Corporate Services Ltd."}
    assert r["anchor"]["amount_cr"] == 15.9 and r["anchor"]["date"] == "2026-10-30"
    assert r["subscription"]["retail"] == 2.26 and r["subscription"]["snii"] == 1.9 and r["subscription"]["total"] == 1.9
    assert r["listing"]["open"] == 94.0 and r["listing"]["close"] == 89.3
    assert r["about"].startswith("Incorporated in 2011")


# ---------------------------------------------------- timeline & facts ---

def test_t_plus_3_timeline_skips_weekends_and_holidays():
    row = nz.fill_timeline({"close_date": "2026-11-20", "anchor": {"amount_cr": 10}})       # Friday; 2026-11-24 is a holiday
    assert row["allotment_date"] == "2026-11-23" and row["refund_date"] == "2026-11-25" and row["demat_date"] == "2026-11-25"
    assert row["timeline_estimated"] is True
    assert row["anchor"]["lockin_50pct_date"] == "2026-12-23" and row["anchor"]["lockin_rest_date"] == "2027-02-21"
    given = nz.fill_timeline({"close_date": "2026-11-20", "allotment_date": "2026-11-23", "refund_date": "2026-11-25", "demat_date": "2026-11-25"})
    assert "timeline_estimated" not in given or given["timeline_estimated"] is False


def test_registrar_status_pages():
    assert nz.registrar_info("Kfin Technologies Ltd.")["status_url"] == "https://ipostatus.kfintech.com/"
    assert nz.registrar_info("MUFG Intime India Pvt.Ltd.")["status_url"] == "https://in.mpms.mufg.com/Initial_Offer/public-issues.html"
    assert nz.registrar_info("Link Intime India Private Ltd")["status_url"].startswith("https://in.mpms.mufg.com/")
    assert nz.registrar_info("Bigshare Services Pvt.Ltd.")["status_url"] == "https://ipo.bigshareonline.com/IPO_Status.html"
    assert nz.registrar_info({"name": "Unknown RTA"}) == {"name": "Unknown RTA", "status_url": None}
    assert nz.registrar_info(None) is None


# ----------------------------------------------------- post-listing ---

def test_post_listing_horizons_from_nse_history():
    days = [{"mTIMESTAMP": f"{d:02d}-Oct-2026", "CH_OPENING_PRICE": 100 + d, "CH_CLOSING_PRICE": 100 + d,
             "CH_TRADE_HIGH_PRICE": 0, "CH_TRADE_LOW_PRICE": 0} for d in range(1, 31)]
    series = market.parse_nse_history({"data": list(reversed(days))})
    pl = market.post_listing_from(series, "2026-10-05", 100.0)
    assert pl["d1"] == 5.0 and pl["w1"] == 9.0 and pl["m1"] == 25.0 and pl["m3"] is None and pl["last_price"] == 130.0
    # a chart that starts weeks after the listing day must not pretend to be day one
    assert market.post_listing_from(series, "2026-09-01", 100.0)["d1"] is None
    assert market.yahoo_tickers("VPFL", "sme") == ["VPFL-SM.NS", "VPFL.NS"]


# ------------------------------------------------------------- run ---

def test_run_merges_duplicate_names_and_keeps_every_gmp_source(tmp_path):
    srcs = [
        ("investorgain", lambda h, t: [{"name": "Zetwerk", "open_date": "2026-11-16", "close_date": "2026-11-18",
                                        "price_band_high": 151, "gmp": {"rs": 10, "as_of": "2026-11-15"}}]),
        ("ipowatch", lambda h, t: [{"name": "Zetwerk Manufacturing Businesses", "open_date": "2026-11-16", "close_date": "2026-11-18",
                                    "price_band_high": 151, "gmp": {"rs": 20, "as_of": "2026-11-15"}}]),
        ("nse", lambda h, t: [{"name": "ZETWERK MANUFACTURING BUSINESSES LIMITED", "symbol": "ZETWERK", "security_type": "Equity",
                               "board": "mainboard", "open_date": "2026-11-16", "close_date": "2026-11-18",
                               "price_band_low": 143, "price_band_high": 151, "lot_size": 99}]),
    ]
    run.refresh(str(tmp_path), TODAY, cache=False, sources=srcs, market_fn=lambda h, t: {})
    rows = load_json(os.path.join(str(tmp_path), "ipos.json"))["ipos"]
    assert len(rows) == 1
    z = rows[0]
    assert z["board"] == "mainboard" and z["board_basis"] == "source" and "zetwerk-2026" in z["aliases"]
    assert z["gmp"]["rs"] == 15.0 and z["gmp"]["spread_rs"] == 10.0 and z["gmp"]["disagree"] is True
    assert {q["source"] for q in z["gmp"]["sources"]} == {"investorgain", "ipowatch"}
    assert z["allotment_date"] == "2026-11-19" and z["timeline_estimated"] is True
    live = load_json(os.path.join(str(tmp_path), "ipos.json"))
    assert live["source_status"]["nse"]["ok"] is True and live["source_status"]["nse"]["last_ok_at"]


def test_run_drops_non_ipo_rows_and_infers_sme_board(tmp_path):
    srcs = [("nse", lambda h, t: [
        {"name": "L&T Finance Limited", "listing_date": "2026-10-15", "issue_price": 99987},
        {"name": "Party Cruisers Limited", "open_date": "2021-02-22", "close_date": "2021-02-25", "listing_date": "2026-10-21", "issue_price": 90},
        {"name": "Small Works", "open_date": "2026-11-17", "close_date": "2026-11-19", "issue_price": 120, "lot_size": 1200, "issue_size_cr": 30},
    ])]
    s = run.refresh(str(tmp_path), TODAY, cache=False, sources=srcs, market_fn=lambda h, t: {})
    rows = load_json(os.path.join(str(tmp_path), "ipos.json"))["ipos"]
    assert [r["name"] for r in rows] == ["Small Works"]
    assert rows[0]["board"] == "sme" and rows[0]["board_basis"] == "inferred" and rows[0]["min_lots"] == 2
    assert "board_inferred" in rows[0]["flags"] and sum(s["dropped"].values()) == 2


# ------------------------------------------------------------ history ---

class _GmpStub:
    def __init__(self):
        from fetch.common import Provenance
        self.prov = Provenance()

    def get_json(self, url, **kw):
        return {"lists": [{"id": 1818, "company_short_name": "Watrana Rentals", "urlrewrite_folder_name": "watrana-rentals-ipo",
                           "issue_open_dt": "2026-11-19T00:00:00.000Z", "issue_end_dt": "2026-11-23T00:00:00.000Z"}]}

    def get_html(self, url, **kw):
        return ("<table><tr><th>GMP Date</th><th>GMP</th></tr>"
                "<tr><td>28-Nov 10:00</td><td>₹40</td></tr><tr><td>26-Nov 14:02</td><td>₹22</td></tr>"
                "<tr><td>20-Nov 14:02</td><td>₹16</td></tr></table>")


def test_history_gmp_is_the_last_quote_before_listing():
    from fetch import history
    rows = [{"id": "watrana-rentals-2026", "name": "Watrana Rentals Ltd.", "open_date": "2026-11-19", "close_date": "2026-11-23",
             "listing_date": "2026-11-27", "issue_price": 245.0, "gmp": {}}]
    assert history.enrich_gmp(_GmpStub(), rows, date(2026, 12, 1)) == 1
    g = rows[0]["gmp"]
    assert g["rs"] == 22.0 and g["as_of"] == "2026-11-26" and [h["date"] for h in g["history"]] == ["2026-11-20", "2026-11-26"]
    assert "gmp_pre_listing" in rows[0]["flags"]
