"""Rules of the game for an Indian retail IPO applicant: how allotment odds work,
what one application can be, and what a listing-day sale costs.

Every constant here is a *parameter* with a documented source. The page lets the
user override brokerage and tax because they differ per broker and per person.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

# --- application limits (SEBI ICDR) ------------------------------------------
RETAIL_MAX_APPLICATION = 200_000      # Rs 2 lakh: the retail (RII) category ceiling
SNII_MIN = 200_000                    # small NII: above Rs 2 lakh ...
SNII_MAX = 1_000_000                  # ... up to Rs 10 lakh; bNII above that
SME_MIN_LOTS = 2                      # SEBI (2025): an SME IPO application must be at least two lots,
                                      # so the minimum ticket is above Rs 2 lakh. VERIFY against the
                                      # issue's RHP; some pre-reform issues still take one lot.


def min_lots_for(board: str) -> int:
    return SME_MIN_LOTS if board == "sme" else 1

# --- listing-day sale costs (defaults; broker-specific ones are overridable) ---
@dataclass
class CostConfig:
    brokerage_pct: float = 0.0          # % of sell value (0 for most discount brokers on delivery sells)
    brokerage_min: float = 0.0          # flat minimum per order, Rs
    brokerage_cap: float = 0.0          # flat cap per order, Rs (0 = none)
    stt_pct: float = 0.1                # Securities Transaction Tax on a delivery sell, % of value
    exchange_txn_pct: float = 0.00297   # NSE equity transaction charge, % of value
    sebi_pct: float = 0.0001            # SEBI turnover fee Rs 10 per crore
    stamp_duty_sell_pct: float = 0.0    # stamp duty is charged on the buy side only
    gst_pct: float = 18.0               # GST on brokerage + exchange + SEBI charges
    dp_charge: float = 15.34            # per scrip per sell day (CDSL + DP, incl. GST), Rs
    stcg_tax_pct: float = 20.0          # short-term capital gains tax, listed equity, post Jul-2024
    cess_pct: float = 4.0               # health & education cess on the tax
    opportunity_rate_pct: float = 0.0   # annualised % cost of funds blocked under ASBA/UPI (0 = ignore)
    blocked_days: int = 7               # bid open day → unblock/listing, roughly


def sell_charges(sell_value: float, cfg: CostConfig) -> float:
    """Transaction charges on selling `sell_value` rupees of shares on listing day."""
    if sell_value <= 0:
        return 0.0
    brok = sell_value * cfg.brokerage_pct / 100
    if cfg.brokerage_min:
        brok = max(brok, cfg.brokerage_min)
    if cfg.brokerage_cap:
        brok = min(brok, cfg.brokerage_cap)
    stt = sell_value * cfg.stt_pct / 100
    exch = sell_value * cfg.exchange_txn_pct / 100
    sebi = sell_value * cfg.sebi_pct / 100
    stamp = sell_value * cfg.stamp_duty_sell_pct / 100
    gst = (brok + exch + sebi) * cfg.gst_pct / 100
    return brok + stt + exch + sebi + stamp + gst + cfg.dp_charge


def net_profit_on_sale(invested: float, sell_value: float, cfg: CostConfig) -> dict:
    """Profit after charges and after STCG tax (tax only when there is a gain).
    Returns a breakdown so the page can show where the money goes."""
    charges = sell_charges(sell_value, cfg)
    gross = sell_value - invested
    pre_tax = gross - charges
    tax = max(0.0, pre_tax) * cfg.stcg_tax_pct / 100 * (1 + cfg.cess_pct / 100)
    opp = invested * cfg.opportunity_rate_pct / 100 * cfg.blocked_days / 365
    return {"gross": gross, "charges": charges, "tax": tax, "opportunity": opp,
            "net": pre_tax - tax - opp}


# --- allotment odds -----------------------------------------------------------

def retail_lots_affordable(lot_size: int, issue_price: float) -> int:
    """Max lots one retail application can bid for under the Rs 2 lakh cap."""
    one = lot_size * issue_price
    return max(1, int(RETAIL_MAX_APPLICATION // one)) if one > 0 else 1


def p_allotment(sub: float | None, lots_bid: int = 1, board: str = "mainboard") -> dict:
    """Probability of getting *at least the minimum lot* and the expected lots.

    SEBI's allotment rule when a category is oversubscribed: first, every
    applicant is considered for the minimum bid lot; if even that is not
    possible, minimum lots go to as many applicants as fit, chosen by a
    computerised lottery. So for an oversubscribed retail book with
    oversubscription `s`, an applicant who bid 1 lot has roughly a 1/s chance.
    Bidding more lots does NOT raise the chance of the lottery (every
    applicant counts once); it only matters when the book is undersubscribed.

    `sub` is the category's times-subscribed figure. None → unknown.
    """
    if sub is None:
        return {"p_min_lot": None, "expected_lots": None, "basis": "no subscription data"}
    if sub <= 1.0:
        # undersubscribed: everyone gets what they bid for
        return {"p_min_lot": 1.0, "expected_lots": float(lots_bid), "basis": "category under-subscribed: full allotment"}
    p = min(1.0, 1.0 / sub)
    r1 = f"{math.floor(sub * 10 + 0.5) / 10:.1f}"   # half-up, same as score.js
    return {"p_min_lot": p, "expected_lots": p * 1.0, "basis": f"lottery at {r1}x: about 1 in {r1} applicants"}


def expected_value_of_application(issue_price: float, lot_size: int, sub_retail: float | None,
                                  p_gain: float | None, gain_quantiles: dict | None,
                                  cfg: CostConfig, lots_bid: int = 1, min_lots: int = 1) -> dict:
    """Expected net profit (Rs) of ONE retail application that sells on listing day.

    gain_quantiles: {"p10": %, "p50": %, "p90": %, "mean": %} of listing-day gain.
    The EV uses the *mean* gain; the downside line uses p10. `min_lots` is the
    smallest application the issue accepts (2 for SME issues since 2025).
    """
    allot = p_allotment(sub_retail, lots_bid)
    invested_one_lot = issue_price * lot_size * max(1, min_lots)
    out = {"allotment": allot, "invested_if_allotted": invested_one_lot}
    if allot["p_min_lot"] is None or gain_quantiles is None:
        out.update({"ev": None, "ev_if_allotted": None, "downside_if_allotted": None})
        return out
    lots = allot["expected_lots"] / allot["p_min_lot"] if allot["p_min_lot"] else lots_bid
    invested = invested_one_lot * max(1.0, lots)
    mean_sale = invested * (1 + gain_quantiles["mean"] / 100)
    ev_alloc = net_profit_on_sale(invested, mean_sale, cfg)["net"]
    p10_sale = invested * (1 + gain_quantiles["p10"] / 100)
    down_alloc = net_profit_on_sale(invested, p10_sale, cfg)["net"]
    out.update({
        "ev_if_allotted": ev_alloc,
        "downside_if_allotted": down_alloc,
        "ev": allot["p_min_lot"] * ev_alloc,
        "invested": invested,
    })
    return out
