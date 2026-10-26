# IPO Radar

A small, self-hosting website that lists every Indian IPO in the pipeline (mainboard and SME) and, for each one, estimates:

* the **chance it closes above its issue price on listing day**,
* the **likely gain range** (P10 to P90, not a single number),
* your **odds of actually being allotted shares** under SEBI's retail lottery,
* what **one application is worth** after brokerage, STT, exchange charges, GST, DP charges and short-term capital gains tax,
* a plain **verdict** (Apply / Lean apply / Coin flip / Avoid / Too early) with the warnings that should stop a gamble,

plus a planner that answers the question that started this project: *can listing gains make ₹25,000 a month, and with how much capital and how many accounts?*

The page is a single HTML file with the data inlined, so it works from GitHub Pages, from a local file, and as a claude.ai artifact. Nothing is sent anywhere; planner inputs stay in the browser.

## How it is honest

* **GMP is one input, not the answer.** The grey market premium is an unofficial dealer quote. It is clipped, trended, and combined with subscription figures, board, issue size and market momentum.
* **Probabilities are calibrated, or say they are not.** Until `data/history.json` holds 120 listings with outcomes, the model runs on *documented prior weights* (`model/prior.py`) and the page says so in orange. After that, every refresh fits a ridge-penalised logistic regression shrunk toward those priors and reports **out-of-sample** AUC, Brier score and a reliability diagram (5-fold cross-validation).
* **Allotment is a lottery and the page does the arithmetic.** When retail is oversubscribed, every applicant gets at most one minimum lot by computerised lottery, so the chance is roughly 1 ÷ (retail times subscribed) whether you bid one lot or ten. Expected value = that chance × net profit on one lot.
* **Costs are real.** Defaults match a discount broker's delivery sell (0.1% STT, exchange and SEBI charges, GST, ₹15.34 DP charge) and 20% STCG plus cess; change the preset to your broker.
* **Every number has a source.** `data/ipos.json` carries the URLs each row was built from and `sources` logs what the last refresh fetched.

## Layout

```
site/index.html      page markup and styles (fragment: no <html>/<head>; the build wraps it)
site/app.js          page logic: table, detail rows, what-if, planner, charts
site/score.js        the scoring model in JS (mirrors model/*.py; parity-tested)
model/features.py    feature engineering              model/rules.py    allotment odds, costs, SEBI limits
model/score.py       scoring + verdict rules          model/calibrate.py fits params.json from history
model/fit.py         numpy logistic/ridge + metrics   model/prior.py    documented prior weights
model/tests/         parity (JS vs Python), rules
fetch/               live-data fetchers (NSE, Chittorgarh, Investorgain, market) + history builder
tools/ingest_research.py   merges hand-researched rows into the canonical files
tools/build_site.py        inlines data + scripts → dist/index.html (Pages) and dist/artifact.html
data/ipos.json       current pipeline   data/history.json  listed IPOs with outcomes (append-only)
data/scored.json     pipeline + scores  model/params.json  fitted (or prior) model
.github/workflows/refresh.yml   scheduled fetch → calibrate → score → build → Pages deploy
```

## Run it

```bash
pip install -r requirements.txt
python -m model.calibrate            # writes model/params.json (prior until 120 listings)
python -m model.score                # writes data/scored.json
python tools/build_site.py --out dist
python -m pytest -q model/tests fetch/tests
open dist/index.html                 # or serve dist/ anywhere
```

Live refresh (needs open internet, which GitHub Actions has):

```bash
python -m fetch.run --out data                        # current pipeline, GMP, subscription, market
python -m fetch.history --years 2024 2025 2026        # calibration rows from the performance trackers
```

## Publish as a website

1. Push this folder to a GitHub repository.
2. Settings → Pages → Source: **GitHub Actions**. Settings → Actions → General → Workflow permissions: **Read and write**.
3. Run the `refresh` workflow once from the Actions tab. It fetches, calibrates, builds and deploys; afterwards it runs four times a day on trading days.

## Verdict rules

| Verdict | Rule |
|---|---|
| Apply | chance ≥ 75%, middle gain ≥ 5%, positive expected value, no warnings |
| Lean apply | chance ≥ 60% with at most one warning; or a strong GMP-only read before subscription data |
| Coin flip | 40–60%, or a stronger read pulled down by two or more warnings |
| Avoid | under 40% or negative expected value |
| Too early | only a GMP quote so far and it does not justify a lean; decide on the last bidding day |

Warnings: GMP ≤ 0 or < 5%; GMP falling sharply; retail or QIB under-subscribed at close; institution-only books (QIB ≥ 20x with HNI or retail < 2x); any SME issue (and SME < 10x); issues under ₹50 crore; GMP quote older than three days.

## Known limits

* Two inputs cannot be learned from the shipped history yet: history rows carry no market reading, so the Nifty term stays at its prior weight until `fetch/history.py` stamps one, and a missing GMP in a hand-researched row sometimes means "not captured" rather than "never quoted". The live fetcher removes both gaps.

* The grey market is unregulated and thin for small SME issues; a quoted ₹0 often means "nobody quotes it", which the code treats as *no quote*.
* The history that ships here was assembled from search results on 26 Oct 2026 (65 issues, 41 with a listing outcome, several of them debut-price rather than close-price); the fetcher's `--build-history` run on a machine with internet access replaces it with the exchanges' and trackers' full tables.
* A listing-day market shock is in nobody's pre-listing numbers.
* Expected value is an average over many applications. Most months bring zero or one allotment; profits arrive in lumps.
