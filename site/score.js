/* IPO Radar scoring — a line-for-line port of model/features.py + model/rules.py +
 * model/score.py. The Python side is the reference; model/tests/test_parity.py
 * runs both on the same rows and fails on any numeric difference.
 * Works in the browser (window.IpoScore) and in Node (module.exports). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IpoScore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FEATURE_NAMES = ['gmp_pct', 'gmp_missing', 'log_sub_qib', 'log_sub_nii', 'log_sub_retail',
    'sub_missing', 'is_sme', 'log_issue_size', 'nifty_1m_pct', 'gmp_trend_pct'];
  const GMP_CLIP = [-25.0, 150.0];
  const RETAIL_MAX_APPLICATION = 200000;

  const TIERS = {
    apply: { label: 'Apply', order: 0 },
    lean: { label: 'Lean apply', order: 1 },
    coinflip: { label: 'Coin flip', order: 2 },
    avoid: { label: 'Avoid', order: 3 },
    watch: { label: 'Too early', order: 4 },
    nodata: { label: 'Not enough data', order: 5 },
  };

  function f(x) {
    if (x === null || x === undefined || x === '') return null;
    const v = Number(x);
    return Number.isFinite(v) ? v : null;
  }

  function gmpPctOf(ipo) {
    const g = ipo.gmp || {};
    let pct = f(g.pct);
    const rs = f(g.rs);
    const price = f(ipo.issue_price);
    if (pct === null && rs !== null && price) pct = 100.0 * rs / price;
    return pct;
  }

  function gmpTrendOf(ipo) {
    const g = ipo.gmp || {};
    const hist = (g.history || []).filter(h => f(h.rs) !== null);
    const price = f(ipo.issue_price);
    if (hist.length < 2 || !price) return null;
    hist.sort((a, b) => ((a.date || '') < (b.date || '') ? -1 : (a.date || '') > (b.date || '') ? 1 : 0));
    const last = f(hist[hist.length - 1].rs);
    const prev = f(hist[Math.max(0, hist.length - 4)].rs);
    return 100.0 * (last - prev) / price;
  }

  function features(ipo, market) {
    const sub = ipo.subscription || {};
    let qib = f(sub.qib), nii = f(sub.nii), ret = f(sub.retail);
    const total = f(sub.total);
    const subMissing = (qib === null && nii === null && ret === null && total === null) ? 1.0 : 0.0;
    if (total !== null) { if (qib === null) qib = total; if (nii === null) nii = total; if (ret === null) ret = total; }
    const gmp = gmpPctOf(ipo);
    const gmpMissing = gmp === null ? 1.0 : 0.0;
    const size = f(ipo.issue_size_cr);
    const m = market || ipo.market || {};
    const n1m = f(m.nifty_1m_pct);
    const trend = gmpTrendOf(ipo);
    return {
      gmp_pct: gmp !== null ? Math.min(GMP_CLIP[1], Math.max(GMP_CLIP[0], gmp)) : 0.0,
      gmp_missing: gmpMissing,
      log_sub_qib: qib !== null ? Math.log1p(Math.max(0, qib)) : 0.0,
      log_sub_nii: nii !== null ? Math.log1p(Math.max(0, nii)) : 0.0,
      log_sub_retail: ret !== null ? Math.log1p(Math.max(0, ret)) : 0.0,
      sub_missing: subMissing,
      is_sme: ipo.board === 'sme' ? 1.0 : 0.0,
      log_issue_size: size !== null ? Math.log(Math.max(1.0, size)) : Math.log(300.0),
      nifty_1m_pct: n1m !== null ? n1m : 0.0,
      gmp_trend_pct: trend !== null ? trend : 0.0,
    };
  }

  function vector(feat) { return FEATURE_NAMES.map(k => Number(feat[k])); }

  // ---------------------------------------------------------------- rules ---
  function defaultCosts() {
    return { brokerage_pct: 0.0, brokerage_min: 0.0, brokerage_cap: 0.0, stt_pct: 0.1, exchange_txn_pct: 0.00297,
      sebi_pct: 0.0001, stamp_duty_sell_pct: 0.0, gst_pct: 18.0, dp_charge: 15.34, stcg_tax_pct: 20.0, cess_pct: 4.0,
      opportunity_rate_pct: 0.0, blocked_days: 7 };
  }

  function sellCharges(sellValue, cfg) {
    if (sellValue <= 0) return 0.0;
    let brok = sellValue * cfg.brokerage_pct / 100;
    if (cfg.brokerage_min) brok = Math.max(brok, cfg.brokerage_min);
    if (cfg.brokerage_cap) brok = Math.min(brok, cfg.brokerage_cap);
    const stt = sellValue * cfg.stt_pct / 100;
    const exch = sellValue * cfg.exchange_txn_pct / 100;
    const sebi = sellValue * cfg.sebi_pct / 100;
    const stamp = sellValue * cfg.stamp_duty_sell_pct / 100;
    const gst = (brok + exch + sebi) * cfg.gst_pct / 100;
    return brok + stt + exch + sebi + stamp + gst + cfg.dp_charge;
  }

  function netProfitOnSale(invested, sellValue, cfg) {
    const charges = sellCharges(sellValue, cfg);
    const gross = sellValue - invested;
    const preTax = gross - charges;
    const tax = Math.max(0, preTax) * cfg.stcg_tax_pct / 100 * (1 + cfg.cess_pct / 100);
    const opp = invested * cfg.opportunity_rate_pct / 100 * cfg.blocked_days / 365;
    return { gross, charges, tax, opportunity: opp, net: preTax - tax - opp };
  }

  function retailLotsAffordable(lot, price) {
    const one = lot * price;
    return one > 0 ? Math.max(1, Math.floor(RETAIL_MAX_APPLICATION / one)) : 1;
  }

  function pAllotment(sub, lotsBid) {
    lotsBid = lotsBid || 1;
    if (sub === null || sub === undefined) return { p_min_lot: null, expected_lots: null, basis: 'no subscription data' };
    if (sub <= 1.0) return { p_min_lot: 1.0, expected_lots: lotsBid, basis: 'category under-subscribed: full allotment' };
    const p = Math.min(1.0, 1.0 / sub);
    return { p_min_lot: p, expected_lots: p * 1.0, basis: 'lottery at ' + r1(sub) + 'x: about 1 in ' + r1(sub) + ' applicants' };
  }

  function expectedValueOfApplication(price, lot, subRetail, pGain, gainQ, cfg, lotsBid, minLots) {
    lotsBid = lotsBid || 1; minLots = minLots || 1;
    const allot = pAllotment(subRetail, lotsBid);
    const investedOne = price * lot * Math.max(1, minLots);
    const out = { allotment: allot, invested_if_allotted: investedOne };
    if (allot.p_min_lot === null || !gainQ) {
      out.ev = null; out.ev_if_allotted = null; out.downside_if_allotted = null;
      return out;
    }
    const lots = allot.p_min_lot ? allot.expected_lots / allot.p_min_lot : lotsBid;
    const invested = investedOne * Math.max(1.0, lots);
    const meanSale = invested * (1 + gainQ.mean / 100);
    const evAlloc = netProfitOnSale(invested, meanSale, cfg).net;
    const p10Sale = invested * (1 + gainQ.p10 / 100);
    const downAlloc = netProfitOnSale(invested, p10Sale, cfg).net;
    out.ev_if_allotted = evAlloc; out.downside_if_allotted = downAlloc;
    out.ev = allot.p_min_lot * evAlloc; out.invested = invested;
    return out;
  }

  // ---------------------------------------------------------------- model ---
  function sigmoid(z) { return 1.0 / (1.0 + Math.exp(-z)); }

  function modelOutputs(ipo, params, market) {
    const feat = features(ipo, market);
    const lg = params.logistic, gn = params.gain;
    const xs = vector(feat).map((v, i) => (v - lg.mean[i]) / lg.scale[i]);
    let z = lg.intercept; for (let i = 0; i < xs.length; i++) z += lg.coef[i] * xs[i];
    const pUp = sigmoid(z);
    let mean = gn.intercept; for (let i = 0; i < xs.length; i++) mean += gn.coef[i] * xs[i];
    const board = ipo.board === 'sme' ? 'sme' : 'mainboard';
    const rq = gn.resid_quantiles[board] || gn.resid_quantiles.mainboard;
    const gain = { mean, p10: mean + rq.p10, p25: mean + rq.p25, p50: mean + rq.p50, p75: mean + rq.p75, p90: mean + rq.p90 };
    return { pUp, gain, feat };
  }

  function similarPast(ipo, params) {
    const g = gmpPctOf(ipo);
    const board = ipo.board === 'sme' ? 'sme' : 'mainboard';
    for (const row of (params.empirical || [])) {
      if (row.board !== board || !(row.n > 0)) continue;
      if (g === null) { if (row.bucket === 'no GMP quote') return row; continue; }
      if (row.lo === null || row.lo === undefined) continue;
      if (row.lo <= g && g < row.hi) return row;
    }
    return null;
  }

  function daysBetween(a, b) { // ISO dates → whole days (a - b)
    const da = Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10));
    const db = Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10));
    return Math.round((da - db) / 86400000);
  }

  function gmpIsUnquoted(ipo) {
    const g = ipo.gmp || {};
    const hist = (g.history || []).filter(h => h.rs !== null && h.rs !== undefined);
    const nonzero = hist.filter(h => Number(h.rs) !== 0);
    return ipo.board === 'sme' && (ipo.status === 'upcoming' || ipo.status === 'open')
      && g.rs !== null && g.rs !== undefined && Number(g.rs) === 0 && nonzero.length === 0 && hist.length <= 2;
  }

  function dataQuality(ipo, today) {
    const flags = (ipo.flags || []).slice();
    const sub = ipo.subscription || {};
    let gmp = ipo.gmp || {};
    const status = ipo.status;
    if (gmpIsUnquoted(ipo)) { gmp = Object.assign({}, gmp, { rs: null, pct: null }); ipo = Object.assign({}, ipo, { gmp }); flags.push('gmp_unquoted'); }
    const hasSub = ['qib', 'nii', 'retail', 'total'].some(k => sub[k] !== null && sub[k] !== undefined);
    const hasGmp = gmpPctOf(ipo) !== null;
    if (gmp.as_of && today && /^\d{4}-\d{2}-\d{2}$/.test(gmp.as_of) && /^\d{4}-\d{2}-\d{2}$/.test(today)) {
      if (daysBetween(today, gmp.as_of) >= 3) flags.push('gmp_stale');
    }
    if (!hasGmp && !hasSub) return ['none', flags.concat(['no_gmp_no_sub'])];
    if (status === 'closed' && hasSub && hasGmp) return ['high', flags];
    if (status === 'open' && hasSub) return ['medium', flags.concat(['sub_partial'])];
    if (hasGmp && !hasSub) return ['low', flags.concat(['gmp_only'])];
    return ['medium', flags];
  }

  function fmtx(v) { return (v === null || v === undefined) ? '–' : String(v); }
  function r1(v) { return (Math.floor(v * 10 + 0.5) / 10).toFixed(1); }

  function verdict(ipo, pUp, gain, ev, confidence, flags) {
    const reasons = [], warnings = [];
    const sub = ipo.subscription || {};
    const board = ipo.board;
    const g = gmpPctOf(ipo);
    const trend = gmpTrendOf(ipo);
    const size = ipo.issue_size_cr;
    const status = ipo.status;
    if (pUp === null || confidence === 'none') {
      return { tier: 'nodata', label: TIERS.nodata.label, reasons: ['No GMP quote and no subscription figures yet.'], warnings, gamble: null };
    }
    if (g !== null && g <= 0) warnings.push('GMP is zero or negative: the grey market expects a flat or discount listing.');
    else if (g !== null && g < 5) warnings.push('GMP under 5%: thin cushion; a weak market on listing day wipes it out.');
    if (trend !== null && g !== null && trend <= -0.4 * Math.max(g - trend, 1)) warnings.push('GMP has fallen sharply over the last few sessions.');
    if ((status === 'closed' || status === 'open') && sub.retail !== null && sub.retail !== undefined && sub.retail < 1 && status === 'closed')
      warnings.push('Retail portion under-subscribed: weak demand, and you will be allotted everything you bid for.');
    if (sub.qib !== null && sub.qib !== undefined && sub.qib < 1 && status === 'closed')
      warnings.push('QIBs (institutions) did not fill their quota: the smart money passed.');
    if (board === 'sme') {
      warnings.push('SME issue: thin liquidity, 5% circuit on listing day, lot of ₹2 lakh or more, and a wider spread of outcomes than mainboard.');
      if (sub.total !== null && sub.total !== undefined && sub.total < 10 && status === 'closed')
        warnings.push('SME with under 10x total subscription: historically the riskiest bucket.');
    }
    const qibV = sub.qib, niiV = sub.nii, retV = sub.retail;
    if (status === 'closed' && qibV !== null && qibV !== undefined && qibV >= 20
        && ((niiV !== null && niiV !== undefined && niiV < 2) || (retV !== null && retV !== undefined && retV < 2)))
      warnings.push('Institution-only demand: QIBs piled in but HNIs or retail stayed under 2x. Thin day-one buying is a classic flat-listing setup.');
    if (flags.indexOf('gmp_stale') >= 0) warnings.push('GMP quote is 3+ days old; check a fresh one before applying.');
    if (size !== null && size !== undefined && size < 50) warnings.push('Very small issue (under ₹50 crore): a few operators can move both the GMP and the listing price.');
    const ofs = ipo.ofs_cr, fresh = ipo.fresh_issue_cr;
    if (ofs && fresh !== null && fresh !== undefined && (ofs + fresh) > 0 && ofs / (ofs + fresh) > 0.85)
      reasons.push('Almost entirely an offer for sale: promoters and investors are cashing out, no fresh money goes into the company.');
    if (g !== null) reasons.push('GMP ' + (g >= 0 ? '+' : '-') + r1(Math.abs(g)) + '% of the issue price.');
    if (sub.qib !== null && sub.qib !== undefined) {
      reasons.push('QIB ' + r1(sub.qib) + 'x, NII ' + fmtx(sub.nii) + 'x, retail ' + fmtx(sub.retail) + 'x' + (status === 'closed' ? ' (final)' : ' (so far)'));
    }
    if (confidence === 'low') reasons.push('Only a GMP quote so far; subscription figures will sharpen this.');

    const hard = warnings.filter(w => !w.startsWith('SME issue')).length;
    const evv = ev.ev;
    const evOk = (evv === null || evv === undefined) ? true : evv > 0;
    let tier;
    if (pUp >= 0.75 && ((gain || {}).p50 || 0) >= 5 && evOk && hard === 0) tier = 'apply';
    else if (pUp >= 0.6 && evOk && hard <= 1) tier = 'lean';
    else if (pUp >= 0.4 && (evv === null || evv === undefined || evv > -1)) tier = 'coinflip';
    else tier = 'avoid';
    if (hard >= 2 && (tier === 'apply' || tier === 'lean')) tier = 'coinflip';
    if (confidence === 'low') {
      if (tier === 'apply') tier = 'lean';
      else if ((tier === 'coinflip' || tier === 'avoid') && !(g !== null && g <= 0)) tier = 'watch';
    }

    let gamble = null;
    if (tier === 'avoid') gamble = 'sure';
    else if (tier === 'coinflip' || hard >= 1) gamble = 'possible';
    if (board === 'sme' && tier !== 'apply') gamble = gamble || 'possible';
    if (tier === 'watch' && gamble === 'sure') gamble = 'possible';
    return { tier, label: TIERS[tier].label, reasons, warnings, gamble };
  }

  function scoreIpo(ipo, params, market, cfg, today) {
    cfg = cfg || defaultCosts();
    today = today || new Date().toISOString().slice(0, 10);
    const [confidence, flags] = dataQuality(ipo, today);
    if (flags.indexOf('gmp_unquoted') >= 0) ipo = Object.assign({}, ipo, { gmp: Object.assign({}, ipo.gmp || {}, { rs: null, pct: null }) });
    const price = ipo.issue_price, lot = ipo.lot_size;
    const sub = ipo.subscription || {};
    let pUp = null, gain = null, feat = null;
    if (confidence !== 'none') { const o = modelOutputs(ipo, params, market); pUp = o.pUp; gain = o.gain; feat = o.feat; }
    let ev;
    if (price && lot) {
      const minLots = Math.trunc(Number(ipo.min_lots) || (ipo.board === 'sme' ? 2 : 1));
      ev = expectedValueOfApplication(price, lot, f(sub.retail), pUp, gain, cfg, 1, minLots);
      ev.lots_affordable = retailLotsAffordable(lot, price);
      ev.min_lots = minLots;
    } else {
      ev = { ev: null, ev_if_allotted: null, downside_if_allotted: null, allotment: { p_min_lot: null, basis: 'price or lot unknown' } };
    }
    const sim = similarPast(ipo, params);
    const v = verdict(ipo, pUp, gain, ev, confidence, flags);
    const uniq = Array.from(new Set(flags)).sort();
    return { p_up: pUp, gain, similar: sim, allotment: ev.allotment,
      ev: { ev: ev.ev === undefined ? null : ev.ev, ev_if_allotted: ev.ev_if_allotted === undefined ? null : ev.ev_if_allotted,
        downside_if_allotted: ev.downside_if_allotted === undefined ? null : ev.downside_if_allotted,
        invested_if_allotted: ev.invested_if_allotted === undefined ? null : ev.invested_if_allotted,
        lots_affordable: ev.lots_affordable === undefined ? null : ev.lots_affordable,
        min_lots: ev.min_lots === undefined ? null : ev.min_lots },
      verdict: v, confidence, flags: uniq, features: feat };
  }

  return { FEATURE_NAMES, TIERS, features, vector, gmpPctOf, gmpTrendOf, defaultCosts, sellCharges, netProfitOnSale,
    retailLotsAffordable, pAllotment, expectedValueOfApplication, modelOutputs, similarPast, dataQuality, verdict, scoreIpo };
});
