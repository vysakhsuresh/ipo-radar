# Data schema

All files are UTF-8 JSON. Money is INR. Percentages are plain numbers (12.5 means 12.5%).
Dates are ISO `YYYY-MM-DD`. A field the sources did not give is `null`, never 0.

## `data/ipos.json` – the live pipeline (rewritten on every refresh)

```json
{
  "generated_at": "2026-10-26T04:00:00Z",
  "market": { "nifty": 0, "nifty_1w_pct": 0, "nifty_1m_pct": 0, "nifty_3m_pct": 0, "vix": 0, "as_of": "2026-10-24" },
  "sources": [ { "url": "", "fetched_at": "", "ok": true, "rows": 0, "note": "" } ],
  "ipos": [ IPO, ... ]
}
```

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
| `gmp` | object | `{ "rs": 0, "pct": 0, "as_of": "", "history": [ { "date": "", "rs": 0 } ] }` – grey market premium, an *unofficial* indication |
| `subscription` | object | `{ "qib": 0, "nii": 0, "bnii": 0, "snii": 0, "retail": 0, "employee": 0, "total": 0, "as_of": "", "day": 1 }` – times subscribed |
| `listing` | object \| null | `{ "open": 0, "close": 0, "high": 0, "low": 0, "gain_pct": 0 }` – listing-day prices; `gain_pct` is close vs issue price |
| `sources` | object | field name → URL the value came from |
| `flags` | string[] | data-quality notes, e.g. `gmp_stale`, `price_band_only`, `sub_partial` |

## `model/params.json` – fitted model (rewritten by `model/calibrate.py`)

Coefficients, feature means/scales, residual quantiles per board, cross-validated metrics,
the empirical GMP-bucket table, and the fit date. The page reads this file; `model/score.py`
and `site/app.js` must produce identical numbers from it (`model/tests/test_parity.py`).
