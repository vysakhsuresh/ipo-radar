"""Allotment odds and listing-day costs: the arithmetic the page's rupee figures rest on."""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
from model.rules import (CostConfig, sell_charges, net_profit_on_sale, p_allotment,  # noqa: E402
                         retail_lots_affordable, expected_value_of_application, min_lots_for)


def test_oversubscribed_retail_is_a_lottery_on_one_lot():
    a = p_allotment(12.4)
    assert a["p_min_lot"] == pytest.approx(1 / 12.4)
    assert a["expected_lots"] == pytest.approx(1 / 12.4)
    # bidding more lots does not improve the lottery
    assert p_allotment(12.4, lots_bid=5)["p_min_lot"] == pytest.approx(1 / 12.4)


def test_undersubscribed_retail_is_full_allotment():
    a = p_allotment(0.7, lots_bid=3)
    assert a["p_min_lot"] == 1.0 and a["expected_lots"] == 3.0


def test_unknown_subscription_gives_no_odds():
    assert p_allotment(None)["p_min_lot"] is None


def test_retail_cap_of_two_lakh():
    assert retail_lots_affordable(15, 999) == 13        # 14,985 a lot → 13 lots = 1,94,805
    assert retail_lots_affordable(12, 1119) == 14       # 13,428 a lot
    assert retail_lots_affordable(1200, 93) == 1        # SME lot already above the cap


def test_sme_minimum_is_two_lots():
    assert min_lots_for("sme") == 2 and min_lots_for("mainboard") == 1


def test_sell_charges_breakdown_zero_brokerage():
    cfg = CostConfig()  # discount-broker defaults
    v = 20_000.0
    c = sell_charges(v, cfg)
    stt = v * 0.001
    exch = v * 0.0000297
    sebi = v * 0.000001
    gst = (exch + sebi) * 0.18
    assert c == pytest.approx(stt + exch + sebi + gst + 15.34, rel=1e-9)


def test_sell_charges_with_capped_brokerage():
    cfg = CostConfig(brokerage_pct=0.1, brokerage_cap=20.0)
    assert sell_charges(10_000, cfg) - sell_charges(10_000, CostConfig()) == pytest.approx(10 * 1.18)  # 0.1% = Rs 10 + GST
    assert sell_charges(100_000, cfg) - sell_charges(100_000, CostConfig()) == pytest.approx(20 * 1.18)  # capped at Rs 20 + GST


def test_tax_only_on_gains_and_net_sign():
    cfg = CostConfig()
    gain = net_profit_on_sale(14_985, 14_985 * 1.30, cfg)
    assert gain["tax"] == pytest.approx(max(0, gain["gross"] - gain["charges"]) * 0.20 * 1.04)
    assert gain["net"] == pytest.approx(gain["gross"] - gain["charges"] - gain["tax"])
    loss = net_profit_on_sale(14_985, 14_985 * 0.90, cfg)
    assert loss["tax"] == 0.0 and loss["net"] < 0


def test_expected_value_scales_with_allotment_probability():
    cfg = CostConfig()
    q = {"p10": -5.0, "p50": 20.0, "p90": 45.0, "mean": 22.0}
    ev = expected_value_of_application(999, 15, 12.4, 0.8, q, cfg)
    assert ev["ev"] == pytest.approx(ev["ev_if_allotted"] / 12.4)
    assert ev["downside_if_allotted"] < 0 < ev["ev_if_allotted"]
    # SME: two-lot minimum doubles the money at stake
    ev2 = expected_value_of_application(93, 1200, 5.0, 0.5, q, cfg, min_lots=2)
    assert ev2["invested_if_allotted"] == 93 * 1200 * 2
