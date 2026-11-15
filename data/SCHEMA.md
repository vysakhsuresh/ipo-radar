# Data schema

All files are UTF-8 JSON. Money is INR. Percentages are plain numbers (12.5 means 12.5%).
Dates are ISO `YYYY-MM-DD`. A field the sources did not give is `null`, never 0.

## `data/ipos.json` – the live pipeline (rewritten on every refresh)

```json
{
  "generated_at": "2026-10-26T04:00:00Z",
  "market": { "nifty": 0, "nifty_1w_pct": 0, "nifty_1m_pct": 0, "nifty_3m_pct": 0, "vix": 0, "as_of": "2026-10-24" },
  "sources": [ { "url": "", "fetched_at": "", "ok": true, "rows": 0, "note": "" } ],
  "source_status": { "nse": { "ok": true, "last_ok_at": "", "rows": 0, "typical_rows": 0, "last_note": "", "checked_at": "" } },
  "ipos": [ IPO, ... ]
}
```

`data/scored.json` is the same object with `score` on every IPO, `scored_with`, and:

```json
"health": { "ok": true, "checked_at": "", "sources": [ { "name": "nse", "ok": true, "last_ok_at": "", "rows": 0 } ],
            "issues": [ { "level": "warn", "ipo_id": "foo-2026", "code": "gmp_sources_disagree", "msg": "plain English" } ] }
```

Issue codes: `gmp_implausible`, `gmp_sources_disagree`, `open_after_close`, `listing_before_close`,
`price_outside_band`, `sme_min_lots`, `board_inferred`, `subscription_decreased` (per IPO, also in the
IPO's `health_flags`), `source_stale` (no successful fetch in 24 h), `source_empty` (zero rows from a
source that usually has some). `ok` is false only when an `error`-level issue exists.

## `data/history.json` – listed IPOs used for calibration (append-only)

```json
{ "generated_at": "", "rows": [ IPO, ... ] }
```

## IPO object

| field | type | meaning |
|---|---|---|
| `id` | string | slug, e.g. `lenskart-solutions-2026` |
| `name` | string | company name as on the exchange |
| `board` | `"mainboard"` \| `"sme"` | SME = NSE Emerge or BSE SME |
| `exchange` | string | `NSE`, `BSE`, `NSE,BSE`, `NSE SME`, `BSE SME` |
| `status` | `"upcoming"` \| `"open"` \| `"closed"` \| `"listed"` | derived from dates at generation time |
| `open_date`, `close_date`, `allotment_date`, `listing_date` | date \| null | |
| `price_band_low`, `price_band_high` | number \| null | |
| `issue_price` | number \| null | final price if fixed, else upper band |
| `lot_size` | number \| null | shares per lot |
| `min_investment` | number \| null | `lot_size * issue_price` (SME: one lot is the retail minimum; see RULES) |
| `issue_size_cr` | number \| null | total issue, INR crore |
| `fresh_issue_cr`, `ofs_cr` | number \| null | |
| `sector` | string \| null | |
| `pe_post_issue` | number \| null | |
| `lead_managers` | string[] | |
| `anchor_cr` | number \| null | |
| `gmp` | object | `{ "rs": 0, "pct": 0, "as_of": "", "history": [ { "date": "", "rs": 0 } ], "sources": [ { "source": "", "rs": 0, "as_of": "", "url": "" } ], "spread_rs": 0, "n_fresh": 0, "disagree": false }` – grey market premium, an *unofficial* indication. `rs` is the median of the sources' quotes no older than 3 days; `disagree` when their spread exceeds max(₹5, 25% of the median) |
| `subscription` | object | `{ "qib": 0, "nii": 0, "bnii": 0, "snii": 0, "retail": 0, "employee": 0, "total": 0, "as_of": "", "day": 1 }` – times subscribed |
| `listing` | object \| null | `{ "open": 0, "close": 0, "high": 0, "low": 0, "gain_pct": 0 }` – listing-day prices; `gain_pct` is close vs issue price |
| `sources` | object | field name → URL the value came from |
| `flags` | string[] | data-quality notes, e.g. `gmp_stale`, `price_band_only`, `sub_partial`, `board_inferred`, `gmp_pre_listing` |
| `symbol` | string \| null | NSE symbol |
| `security_type` | string \| null | NSE's type for the line (`Equity`, `SME`); anything else is filtered out |
| `aliases` | string[] | other ids the same IPO appeared under (merged duplicates) |
| `board_basis` | `"source"` \| `"inferred"` \| `"default"` | how `board` was decided: a source said so, or lot/price heuristic |
| `refund_date`, `demat_date` | date \| null | refunds initiated / shares credited |
| `timeline_estimated` | bool | allotment / refund / demat dates were derived from SEBI's T+3 schedule (trading days after `close_date`) |
| `registrar` | object \| null | `{ "name": "", "status_url": "" }` – the registrar's own allotment-status page (null URL when unknown) |
| `face_value` | number \| null | ₹ per share |
| `about` | string \| null | one or two sentences on the business |
| `anchor` | object \| null | `{ "amount_cr", "date", "lockin_50pct_date", "lockin_rest_date" }` (30 / 90 days after allotment) |
| `ipo_url`, `gmp_url` | string \| null | the Chittorgarh IPO page / InvestorGain GMP page the facts came from |
| `post_listing` | object \| null | `{ "last_price", "as_of", "d1", "w1", "m1", "m3", "m6", "listing_open", "listing_close", "ticker", "checked" }` – % over issue price at the close of the listing day, 5th, 21st, 63rd and 125th session (null until reached); listings of the last 200 days |
| `health_flags` | string[] | (scored.json) codes of this IPO's health issues |

## `data/predictions.json` – the prediction ledger (append-only)

```json
{ "generated_at": "", "started": "2026-11-15",
  "rows": [ { "id": "", "name": "", "board": "", "locked_at": "", "lock_stage": "close|pre_listing|backfill",
              "p_up": 0.0, "gain_p10": 0, "gain_p50": 0, "gain_p90": 0, "verdict_tier": "", "verdict_label": "",
              "gmp_pct": 0, "sub_total": 0, "sub_retail": 0, "model_status": "prior|calibrated",
              "listing_date": "", "close_date": "", "aliases": [] } ] }
```

A row is written once and never modified. `close`: locked on the first refresh after bidding closed.
`pre_listing`: first seen already listed (on/after `started`), locked from its pre-listing inputs.
`backfill`: an older listing scored afterwards by the then-current model (hindsight, not a forecast).

## `data/track_record.json` – how the locked predictions did

`{ generated_at, started, n, n_locked, n_backfill, n_pending, hit_rate, by_verdict: { apply|lean|coinflip|avoid|watch: { n, n_up, mean_gain, median_gain } },
brier, brier_gmp_only, base_rate, range_coverage, calibration: [ { bin_lo, bin_hi, pred_mean, obs_rate, n } ],
by_board: { mainboard|sme: { n, n_called, hit_rate, brier, brier_gmp_only, base_rate, range_coverage, mean_gain } },
locked_only: { same as a by_board entry, close/pre_listing rows only }, notes,
rows: [ { id, name, board, listing_date, lock_stage, p_up, verdict_tier, gain_p50, gain_p10, gain_p90, actual_gain_pct, gain_basis, listed_up } ] }`
(rows newest first). `hit_rate`: share of Apply / Lean apply calls that listed above the issue price.
`brier_gmp_only`: the Brier score of the naive forecast "share of past listings in the same GMP bucket that rose".

## `model/params.json` – fitted model (rewritten by `model/calibrate.py`)

Coefficients, feature means/scales, residual quantiles per board, cross-validated metrics,
the empirical GMP-bucket table, and the fit date. The page reads this file; `model/score.py`
and `site/app.js` must produce identical numbers from it (`model/tests/test_parity.py`).
