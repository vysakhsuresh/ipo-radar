"""Prior weights for the model, used until enough listings exist to calibrate.

These are *hand-set, documented assumptions*, not fitted numbers. They encode
the well-known ordering of what matters for an Indian IPO's listing day (GMP
first, then institutional demand, then the rest) at magnitudes that give
sensible probabilities on recent issues. `model/calibrate.py` shrinks the
fitted coefficients toward these values, so with 50 rows the prior still
carries weight and with 500 rows the data does.

All coefficients are on the RAW feature scale (see model/features.py):
  gmp_pct in percentage points, subscription as log1p(times), size as log(crore).

Sanity anchors used when setting them (listing-day close vs issue price):
  * GMP ~20%+ with QIB 50x+                  → P(up) ≈ 0.9, gain ≈ 20-25%
  * GMP ~5% with QIB 3x, NII < 1x            → P(up) ≈ 0.4, gain ≈ 0-3%
  * no GMP quote, subscription ≈ 1x, SME     → P(up) ≈ 0.25
Replace with evidence as the calibration report grows; the page shows which
regime is active ("prior" vs "calibrated on N").
"""

PRIOR_LOGISTIC_RAW = {
    "intercept": -1.2,
    "gmp_pct": 0.10,          # +1 pp of GMP → +0.10 log-odds
    "gmp_missing": -0.5,      # no quote at all is itself a bad sign
    "log_sub_qib": 0.35,      # institutional demand is the strongest non-GMP signal
    "log_sub_nii": 0.15,
    "log_sub_retail": 0.10,
    "sub_missing": -0.5,
    "is_sme": -0.4,
    "log_issue_size": 0.0,    # no prior view; let data decide
    "nifty_1m_pct": 0.04,
    "gmp_trend_pct": 0.03,
}

PRIOR_GAIN_RAW = {
    "intercept": -3.0,
    "gmp_pct": 0.75,          # realised gains run below the quoted premium
    "gmp_missing": -3.0,
    "log_sub_qib": 2.0,
    "log_sub_nii": 1.0,
    "log_sub_retail": 0.0,
    "sub_missing": -3.0,
    "is_sme": -2.0,
    "log_issue_size": 0.0,
    "nifty_1m_pct": 0.3,
    "gmp_trend_pct": 0.2,
}

# spread of listing-day outcomes around the predicted mean, percentage points
PRIOR_RESID = {
    "mainboard": {"p10": -12.0, "p25": -5.0, "p50": 0.0, "p75": 5.0, "p90": 14.0, "n": 0},
    "sme":       {"p10": -25.0, "p25": -10.0, "p50": 0.0, "p75": 10.0, "p90": 30.0, "n": 0},
}

MIN_ROWS_TO_CALIBRATE = 120  # below this the prior is used unchanged; above it the fit
                              # is still shrunk toward the prior (see L2 floors in calibrate.py)
