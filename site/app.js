/* IPO Radar page logic. Reads the inlined data, scores every IPO in the browser
 * with the same code the refresh job uses (score.js), and renders the ledger,
 * the planner and the calibration evidence. No framework, no external calls. */
(function () {
  'use strict';
  // Some Android WebViews report vh as 0, which collapses anything sized in vh
  // (the dropdown sheet's option list). CSS sizes use --vh, set from the real height.
  const setVh = () => { if (window.innerHeight) document.documentElement.style.setProperty('--vh', (window.innerHeight / 100) + 'px'); };
  setVh(); window.addEventListener('resize', setVh);
  const S = window.IpoScore;
  const INLINE = JSON.parse(document.getElementById('data').textContent || '{}');
  // The Android shell (and any host) can hand in fresher data: window.ipoRadarLoad({live, params, history})
  function slimHistory(rows) {
    if (!Array.isArray(rows)) return rows || [];
    return rows.map(r => {
      if (r && r.listing === undefined && r.gain_pct !== undefined) return r;   // already slim
      const lst = (r && r.listing) || {}; if (lst.gain_pct === null || lst.gain_pct === undefined) return null;
      const g = r.gmp || {}; let pct = g.pct; if ((pct === null || pct === undefined) && g.rs !== null && g.rs !== undefined && r.issue_price) pct = 100 * Number(g.rs) / Number(r.issue_price);
      return { name: r.name, board: r.board, listing_date: r.listing_date, gmp_pct: pct === null || pct === undefined ? null : Math.round(pct * 100) / 100, gain_pct: Math.round(Number(lst.gain_pct) * 100) / 100, basis: lst.gain_basis || 'close' };
    }).filter(Boolean);
  }
  function boot(DATA) {
  // a re-boot replaces the static controls so the old boot's listeners fall away
  for (const sel of ['nav.screens', '#f-board', '#f-status-wrap', '#f-nodata', '#f-sort', '#plan-inputs', 'footer.foot', '#settings', '#status', '#help', '#explain', '#intro', '#glossary', '#picker', '#cardsheet']) {
    const n = document.querySelector(sel); if (n) n.replaceWith(n.cloneNode(true));
  }
  for (const b of document.querySelectorAll('.pick-btn')) b.remove();
  for (const sel of document.querySelectorAll('select.enhanced')) { sel.classList.remove('enhanced'); sel.removeAttribute('aria-hidden'); sel.tabIndex = 0; }
  applyTheme(load('theme', 'system'));
  const LIVE = DATA.live || { ipos: [], market: {}, sources: [] };
  const PARAMS = DATA.params || null;
  const HIST = slimHistory(DATA.history instanceof Object && DATA.history.rows ? DATA.history.rows : DATA.history);
  const TODAY = (LIVE.generated_at || new Date().toISOString()).slice(0, 10);

  // ------------------------------------------------------------ helpers ---
  const $ = (sel, el) => (el || document).querySelector(sel);
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'text') n.textContent = attrs[k];
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined) n.setAttribute(k, attrs[k]);
    }
    for (const kid of kids) if (kid !== null && kid !== undefined) n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return n;
  };
  const svgEl = (tag, attrs, ...kids) => {
    const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
    if (attrs) for (const k in attrs) if (attrs[k] !== null && attrs[k] !== undefined) n.setAttribute(k, attrs[k]);
    for (const kid of kids) if (kid !== null && kid !== undefined) n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return n;
  };
  function inr(n, opts) {
    if (n === null || n === undefined || !isFinite(n)) return '–';
    const sign = n < 0 ? '−' : (opts && opts.plus && n > 0 ? '+' : '');
    let v = Math.round(Math.abs(n));
    let s = String(v);
    if (s.length > 3) {
      const last3 = s.slice(-3); let rest = s.slice(0, -3);
      rest = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
      s = rest + ',' + last3;
    }
    return sign + '₹' + s;
  }
  function inrShort(n) {
    if (n === null || n === undefined || !isFinite(n)) return '–';
    const a = Math.abs(n), sign = n < 0 ? '−' : '';
    if (a >= 1e7) return sign + '₹' + (a / 1e7).toFixed(a >= 1e8 ? 0 : 1) + ' cr';
    if (a >= 1e5) return sign + '₹' + (a / 1e5).toFixed(a >= 1e6 ? 0 : 1) + ' L';
    return inr(n);
  }
  const pct = (v, d) => (v === null || v === undefined || !isFinite(v)) ? '–' : (v > 0 ? '+' : '') + v.toFixed(d === undefined ? 1 : d) + '%';
  const pct0 = (v) => (v === null || v === undefined || !isFinite(v)) ? '–' : Math.round(v * 100) + '%';
  const x = (v) => (v === null || v === undefined || !isFinite(v)) ? '–' : (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)) + 'x';
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function dshort(iso) { if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return '–'; return +iso.slice(8, 10) + ' ' + MON[+iso.slice(5, 7) - 1]; }
  function dlong(iso) { if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return '–'; return dshort(iso) + ' ' + iso.slice(0, 4); }
  function daysFrom(iso) { if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return null; return S.gmpTrendOf ? Math.round((Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) - Date.UTC(+TODAY.slice(0, 4), +TODAY.slice(5, 7) - 1, +TODAY.slice(8, 10))) / 86400000) : null; }
  // ------------------------------------------------- plain-language layer ---
  // Every term a newcomer may not know, in the order the glossary shows them.
  const TERMS = {
    howto: { t: 'How to read this app', d: ['Each IPO gets one verdict: Apply, Lean apply, Coin flip, Avoid, or Too early. Start there.', 'Next look at “chance of a listing gain”. 70% means that, out of ten IPOs that looked like this one, about seven ended their first day above the issue price and three below.', 'Then “chance of getting shares”. In a popular IPO most applicants get nothing; the money is simply returned after a week. “1 in 7” means one applicant in seven gets a lot.', '“Worth per application” puts those together: the average profit you can expect for one application, after broker charges and tax, counting the times you get no shares.', 'Tap any IPO to see why it got its verdict and what can go wrong. Tap any underlined word for its meaning.'] },
    verdicts: { t: 'The verdicts', d: ['Apply: the odds are clearly on your side and nothing is flashing red.', 'Lean apply: good odds with one caveat, or a strong early read before demand figures exist.', 'Coin flip: about as likely to list down as up. Treat it as a possible gamble.', 'Avoid: the odds are against you before you start. A sure gamble.', 'Too early: bidding has not produced demand figures yet; wait for the last bidding day.', 'Not enough data: no premium quote and no demand figures, so no call.'] },
    gain: { t: 'Listing gain', d: ['The difference between the price you paid in the IPO and the price at the end of the first day of trading. A 10% listing gain on ₹15,000 of shares is ₹1,500 before charges and tax.'] },
    chance: { t: 'Chance of a listing gain', d: ['How likely the IPO is to close its first trading day above the issue price. It comes from a model that learned from past listings, using the unofficial premium, the demand figures and the market mood.', '70% does not mean you will make 70%. It means that about 7 out of 10 IPOs that looked like this one listed up, and 3 listed down.'] },
    gmp: { t: 'Unofficial premium (GMP)', d: ['GMP stands for grey market premium. Before an IPO lists, some dealers informally buy and sell its shares among themselves. The extra they pay over the issue price is the premium.', 'It is a useful hint of demand and nothing more: it is unofficial, unregulated, can be thin or stale, and for small issues can be steered. This app treats it as one input among several, never as the answer.'] },
    sub: { t: 'Demand (subscription)', d: ['How many times over the IPO has been bid for. “5x” means investors asked for five times the shares on offer.', 'It is reported for three groups: institutions (banks, mutual funds, insurers, called QIB), wealthy individuals bidding over ₹2 lakh (called NII or HNI), and retail, which is everyone applying up to ₹2 lakh. Strong institutional demand is the better sign; retail demand mostly decides your odds of getting shares.'] },
    qib: { t: 'Institutions (QIB)', d: ['Qualified institutional buyers: mutual funds, banks, insurers and foreign funds. They do their own research, so their demand is the strongest signal in the demand figures. They usually bid on the last day.'] },
    nii: { t: 'Wealthy individuals (NII, also called HNI)', d: ['Non-institutional investors: individuals and firms bidding more than ₹2 lakh. Often leveraged, so their demand swings with the premium.'] },
    retail: { t: 'Retail', d: ['Individual investors applying for up to ₹2 lakh. This is the category a normal applicant is in. When it is oversubscribed, shares are given out by lottery, so the retail figure sets your odds of getting any.'] },
    allot: { t: 'Chance of getting shares (allotment)', d: ['You do not get shares just because you applied. If retail demand is 7 times the shares on offer, roughly 1 applicant in 7 gets one lot, chosen by a computerised lottery that SEBI prescribes; the rest get their money back after about a week.', 'Bidding for more lots does not improve your chance in an oversubscribed IPO. More demat accounts in the family do.'] },
    lot: { t: 'Lot', d: ['IPO shares are sold in fixed bundles called lots. The price per share times the lot size is the smallest amount you can apply for. SME IPOs require two lots at minimum.'] },
    range: { t: 'Likely gain, worst to best', d: ['The model’s view of where the listing gain could land. The left end is a bad outcome (only 1 in 10 did worse), the right end a good one (only 1 in 10 did better), and the mark in between is the middle case.', 'Wide bands mean the model is unsure, usually on small SME issues.'] },
    worth: { t: 'Worth per application', d: ['The average profit one application is worth, after broker charges and tax, counting the chance that you get no shares at all.', 'Example: a 1 in 5 chance of getting shares that would earn ₹2,000 is worth about ₹400 per application. Over many applications that is what you can expect; any single one gives either ₹2,000 or nothing.'] },
    charges: { t: 'Broker and exchange charges', d: ['What it costs to sell on listing day: brokerage (your broker’s fee), securities transaction tax (STT, 0.1% of the sale), exchange and SEBI fees, GST on those, and a depository (DP) charge per sale. Change the broker preset in the Planner to match yours.'] },
    tax: { t: 'Tax on the profit', d: ['Selling within a year of buying counts as a short-term capital gain. The tax is 20% of the profit plus 4% cess on that tax. The app deducts it before showing any “in hand” figure.'] },
    sme: { t: 'Mainboard and SME', d: ['Mainboard IPOs list on the main NSE and BSE exchanges. SME IPOs are small companies listing on the NSE Emerge or BSE SME platforms: bigger minimum tickets (₹2 lakh or more), thin trading, a 5% daily price limit on listing day and wilder outcomes, both ways.'] },
    gamble: { t: 'Gamble warnings', d: ['“Possible gamble” marks a coin flip; “Sure gamble” marks an issue where the odds are against you. The app shows them before the money is blocked so you can walk away.'] },
    model: { t: 'The model and how it is checked', d: ['The chance figures come from a statistical model fitted on past Indian listings. Until it has enough history it runs on documented starting weights, and the app says so.', 'The Evidence screen shows the model’s own report card: the past listings table needs no model at all, so you can check the chances against it yourself.'] },
  };
  const TERM_ORDER = ['howto', 'verdicts', 'chance', 'gain', 'gmp', 'sub', 'qib', 'nii', 'retail', 'allot', 'lot', 'range', 'worth', 'charges', 'tax', 'sme', 'gamble', 'model'];
  // "7 in 10" phrasing for a probability, for people who do not think in percentages
  function oddsText(p) {
    if (p === null || p === undefined || !isFinite(p)) return '';
    if (p >= 0.95) return 'almost all such IPOs listed up';
    if (p <= 0.05) return 'almost none of such IPOs listed up';
    return 'about ' + Math.max(1, Math.round(p * 10)) + ' in 10 such IPOs list up';
  }
  // an underlined, tappable word that opens its explanation
  function term(key, label, cls) { return el('button', { type: 'button', class: 'term' + (cls ? ' ' + cls : ''), 'data-term': key, 'aria-label': 'What does ' + (label || TERMS[key].t) + ' mean?' }, label || TERMS[key].t); }
  function openExplain(key) {
    const t = TERMS[key]; if (!t) return;
    const sheet = $('#explain'); $('#explain-title').textContent = t.t;
    const body = $('#explain-body'); body.replaceChildren();
    for (const line of t.d) body.append(el('p', { text: line }));
    sheet.hidden = false; const c = $('#explain-close'); if (c) c.focus();
  }
  function applyTheme(v) { const r = document.documentElement; if (v === 'light' || v === 'dark') r.setAttribute('data-theme', v); else r.removeAttribute('data-theme'); }
  function store(k, v) { try { localStorage.setItem('ipo-radar:' + k, JSON.stringify(v)); } catch (e) { /* private mode */ } }
  function load(k, d) { try { const v = localStorage.getItem('ipo-radar:' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } }

  // -------------------------------------------------------------- state ---
  // Delivery-sell schedules as published in Oct 2026 (zerodha.com/charges, groww.in/pricing/stocks,
  // upstox.com/brokerage-charges, angelone.in/support/charges-and-cashbacks). DP charge incl. GST.
  const BROKERS = {
    zerodha: { brokerage_pct: 0, brokerage_min: 0, brokerage_cap: 0, dp_charge: 15.34 },
    groww:   { brokerage_pct: 0.1, brokerage_min: 5, brokerage_cap: 20, dp_charge: 23.6 },
    upstox:  { brokerage_pct: 0, brokerage_min: 20, brokerage_cap: 20, dp_charge: 23.6 },
    angel:   { brokerage_pct: 0.1, brokerage_min: 5, brokerage_cap: 20, dp_charge: 23.6 },
    custom:  {},
  };
  const state = {
    board: 'all', status: 'active', hideNodata: false, sort: 'verdict', open: null,
    edits: {},                                   // id → {gmp_rs, qib, nii, retail}
    plan: Object.assign({ capital: 200000, accounts: 1, target: 25000, broker: 'zerodha', picked: null, snapshot: null }, load('plan', {})),
    costs: null,
  };
  function costsFor(brokerKey) {
    const c = S.defaultCosts();
    Object.assign(c, BROKERS[brokerKey] || {});
    if (brokerKey === 'custom') Object.assign(c, load('customCosts', {}));
    return c;
  }
  state.costs = costsFor(state.plan.broker);
  // ticks belong to the snapshot they were made on; a refreshed pipeline starts from the defaults again
  if (!Array.isArray(state.plan.picked) || state.plan.snapshot !== (LIVE.generated_at || null)) { state.plan.picked = null; state.plan.snapshot = LIVE.generated_at || null; }
  for (const k of ['capital', 'accounts', 'target']) if (!Number.isFinite(Number(state.plan[k]))) state.plan[k] = { capital: 200000, accounts: 1, target: 25000 }[k];
  state.plan.accounts = Math.min(10, Math.max(1, Math.round(Number(state.plan.accounts) || 1)));

  function effectiveIpo(ipo) {
    const e = state.edits[ipo.id];
    if (!e) return ipo;
    const c = JSON.parse(JSON.stringify(ipo));
    c.gmp = c.gmp || {}; c.subscription = c.subscription || {};
    if (e.gmp_rs !== undefined) { c.gmp.rs = e.gmp_rs; c.gmp.pct = null; c.gmp.as_of = TODAY; }
    for (const k of ['qib', 'nii', 'retail']) if (e[k] !== undefined) c.subscription[k] = e[k];
    return c;
  }
  let SCORED = [];
  const WATCH = new Set((() => { try { if (N && STATUS && Array.isArray(STATUS.watchlist)) return STATUS.watchlist; } catch (e) { /* ignore */ } return load('watch', []); })());
  function saveWatch() { const ids = [...WATCH]; store('watch', ids); if (N) { try { N.setWatchlist(JSON.stringify(ids)); } catch (e) { /* ignore */ } } }
  function toggleWatch(id) { if (WATCH.has(id)) WATCH.delete(id); else WATCH.add(id); saveWatch(); keepFocus(renderAll); }
  function starButton(ipo) {
    const on = WATCH.has(ipo.id);
    return el('button', { class: 'star', type: 'button', id: 'star-' + ipo.id, 'aria-pressed': on ? 'true' : 'false', 'aria-label': (on ? 'Stop watching ' : 'Watch ') + ipo.name, onclick: (ev) => { ev.stopPropagation(); toggleWatch(ipo.id); } }, on ? '★ Watching' : '☆ Watch');
  }
  function dueText(ipo) {
    const dc = daysFrom(ipo.close_date), dl = daysFrom(ipo.listing_date), dopen = daysFrom(ipo.open_date);
    if (ipo.status === 'listed') return { t: 'Listed ' + dshort(ipo.listing_date), cls: '' };
    if (ipo.status === 'upcoming') return { t: dopen === 0 ? 'Bidding opens today' : dopen !== null && dopen > 0 ? 'Opens ' + dshort(ipo.open_date) + ' (in ' + dopen + ' day' + (dopen > 1 ? 's' : '') + ')' : 'Opens ' + dshort(ipo.open_date), cls: '' };
    if (ipo.status === 'open') { if (dc === 0) return { t: 'Last bidding day: closes today', cls: 'today' }; if (dc === 1) return { t: 'Bids close tomorrow', cls: 'today' }; if (dc !== null) return { t: 'Bids close ' + dshort(ipo.close_date) + ' (in ' + dc + ' days)', cls: '' }; return { t: 'Bidding open', cls: '' }; }
    if (dl === 0) return { t: 'Lists today', cls: 'today' }; if (dl === 1) return { t: 'Lists tomorrow', cls: 'today' };
    return { t: 'Bids closed; lists ' + dshort(ipo.listing_date), cls: '' };
  }
  function renderWatchlist() {
    const host = $('#watchlist'); if (!host) return; host.replaceChildren();
    const rows = SCORED.filter(r => WATCH.has(r.ipo.id)).sort((a, b) => ((a.ipo.close_date || a.ipo.listing_date || '9999') < (b.ipo.close_date || b.ipo.listing_date || '9999') ? -1 : 1));
    if (!rows.length) { host.append(el('p', { class: 'muted small', text: 'Nothing starred yet. Tap ☆ Watch on any IPO in the pipeline.' })); return; }
    for (const r of rows) {
      const ipo = r.eff, s = r.score, due = dueText(ipo);
      const row = el('div', { class: 'watch-row' });
      row.append(el('span', { class: 'n', text: ipo.name }));
      if (s && s.p_up !== null && ipo.status !== 'listed') row.append(el('span', { class: 'verdict ' + s.verdict.tier, text: s.verdict.label }), el('span', { class: 'small num ink2', text: pct0(s.p_up) + ' chance of a gain' }));
      row.append(el('span', { class: 'due ' + due.cls, text: due.t }));
      row.append(el('span', { class: 'spacer' }));
      row.append(el('button', { class: 'btn small', type: 'button', id: 'wgo-' + ipo.id, onclick: () => { state.open = ipo.id; renderTable(); showScreen('pipeline'); const t = document.getElementById('row-' + ipo.id); if (t) t.scrollIntoView({ block: 'center' }); } }, 'Open'));
      row.append(starButton(ipo));
      host.append(row);
    }
  }
  function computeAll() {
    SCORED = LIVE.ipos.map(ipo => {
      const eff = effectiveIpo(ipo);
      const score = PARAMS ? S.scoreIpo(eff, PARAMS, LIVE.market, state.costs, TODAY) : null;
      return { ipo, eff, score, edited: !!state.edits[ipo.id] };
    });
  }

  // ---------------------------------------------------------- focus keep ---
  // Re-rendering replaces the DOM; put keyboard focus back on the element with the same id.
  function keepFocus(render) {
    const id = document.activeElement && document.activeElement.id;
    render();
    if (id) { const n = document.getElementById(id); if (n && typeof n.focus === 'function') n.focus({ preventScroll: true }); }
  }

  // -------------------------------------------------------------- header ---
  function renderHead() {
    const a = $('#asof'); a.replaceChildren();
    const gen = LIVE.generated_at ? new Date(LIVE.generated_at) : null;
    const ageH = gen ? (Date.now() - gen.getTime()) / 36e5 : null;
    a.append(el('span', null, 'Data as of ', el('b', null, gen ? gen.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : 'unknown')));
    if (ageH !== null && ageH > 30) a.append(el('span', { class: 'stale' }, 'This data is ' + Math.round(ageH / 24) + ' days old; premium and demand figures move daily. Refresh before deciding.'));
    if (PARAMS && PARAMS.status === 'calibrated') a.append(el('span', null, 'Model fitted on ', el('b', null, PARAMS.n_rows + ' listings'), ' from ' + dlong(PARAMS.date_range[0]) + ' to ' + dlong(PARAMS.date_range[1])));
    else if (PARAMS) a.append(el('span', { class: 'stale' }, 'The model is still on its starting weights: it needs ' + (PARAMS.min_rows_to_calibrate || 120) + ' past listings with full figures and has ' + (PARAMS.n_rows_gating || 0) + '. Treat every chance as a first estimate.'));
    const m = LIVE.market || {};
    if (m.nifty) a.append(el('span', null, 'Nifty 50 ', el('b', { class: 'num' }, Number(m.nifty).toLocaleString('en-IN')), ' (' + pct(m.nifty_1m_pct) + ' in a month)' + (m.vix ? ', India VIX ' + m.vix : '')));
  }

  // --------------------------------------------------------------- tiles ---
  function tile(label, value, sub) { return el('div', { class: 'tile', style: '--i:' + document.querySelectorAll('#tiles .tile').length }, el('div', { class: 'label', text: label }), el('div', { class: 'value', text: value }), sub ? el('div', { class: 'sub', text: sub }) : null); }
  function renderTiles() {
    const t = $('#tiles'); t.replaceChildren();
    const open = SCORED.filter(r => r.ipo.status === 'open');
    const closing = open.filter(r => { const d = daysFrom(r.ipo.close_date); return d !== null && d <= 1; });
    const listing = SCORED.filter(r => r.ipo.status === 'closed' && (() => { const d = daysFrom(r.ipo.listing_date); return d !== null && d >= 0 && d <= 7; })());
    const grade = SCORED.filter(r => r.score && ['apply', 'lean'].includes(r.score.verdict.tier) && ['open', 'upcoming'].includes(r.ipo.status));
    const gamble = SCORED.filter(r => r.score && r.score.verdict.gamble && ['open', 'upcoming'].includes(r.ipo.status));
    t.append(tile('Open for bidding now', String(open.length), closing.length ? closing.length + ' close by tomorrow' : (open.length ? open.map(r => r.ipo.name).slice(0, 2).join(', ') : 'nothing open today')));
    t.append(tile('Listing within a week', String(listing.length), listing.length ? listing.map(r => r.ipo.name).slice(0, 2).join(', ') : 'none scheduled'));
    t.append(tile('Worth applying, open or upcoming', String(grade.length), gamble.length + ' flagged as a gamble'));
    if (PARAMS) {
      const m = PARAMS.metrics;
      if (m) t.append(tile('How often the model gets the order right', Math.round(m.auc * 100) + '%', 'Given one IPO that listed up and one that listed down, it put the right one first this often. 50% would be a coin toss.'));
      else t.append(tile('Model report card', 'not yet', 'The model runs on documented starting weights until ' + (PARAMS.min_rows_to_calibrate || 120) + ' past listings with full figures are in the history (' + (PARAMS.n_rows_gating || 0) + ' so far). The Evidence screen explains.'));
      const br = PARAMS.base_rate;
      const mb = br.mainboard, sm = br.sme;
      const rate = b => (b && b.p_up !== null && b.n >= 20) ? Math.round(b.p_up * 100) + '%' : '–';
      t.append(tile('Past IPOs that listed up', rate(mb) + ' / ' + rate(sm),
        'mainboard / SME, out of ' + (mb ? mb.n : 0) + ' and ' + (sm ? sm.n : 0) + ' recent listings (a dash means fewer than 20). Typical gain ' + (mb && mb.median_gain !== null && mb.n >= 20 ? pct(mb.median_gain, 0) : '–') + ' / ' + (sm && sm.median_gain !== null && sm.n >= 20 ? pct(sm.median_gain, 0) : '–') + '.'));
    }
  }

  // --------------------------------------------------------------- table ---
  const ORDER = { apply: 0, lean: 1, coinflip: 2, watch: 3, avoid: 4, nodata: 5 };
  const STATUS_ORDER = { open: 0, closed: 1, upcoming: 2, listed: 3 };
  function inStatus(r, st) { return st === 'all' || (st === 'active' ? r.ipo.status !== 'listed' : st === 'watch' ? WATCH.has(r.ipo.id) : r.ipo.status === st); }
  function renderChipCounts() {
    const onBoard = SCORED.filter(r => state.board === 'all' || r.ipo.board === state.board);
    for (const b of document.querySelectorAll('#f-status .stile')) { const n = b.querySelector('.n'); if (n) n.textContent = String(onBoard.filter(r => inStatus(r, b.dataset.v)).length); }
  }
  function visible() {
    let rows = SCORED.filter(r => (state.board === 'all' || r.ipo.board === state.board) && inStatus(r, state.status));
    if (state.hideNodata) rows = rows.filter(r => !(r.score && r.score.verdict.tier === 'nodata') || r.ipo.status === 'listed');
    const key = {
      verdict: r => [STATUS_ORDER[r.ipo.status] ?? 9, r.score ? ORDER[r.score.verdict.tier] : 9, -(r.score && r.score.ev.ev !== null ? r.score.ev.ev : -1e9)],
      tier: r => [r.score ? ORDER[r.score.verdict.tier] : 9, -(r.score && r.score.p_up !== null ? r.score.p_up : -1)],
      ev: r => [-(r.score && r.score.ev.ev !== null ? r.score.ev.ev : -1e9)],
      p: r => [-(r.score && r.score.p_up !== null ? r.score.p_up : -1)],
      date: r => [r.ipo.listing_date || r.ipo.close_date || '9999'],
    }[state.sort];
    rows.sort((a, b) => { const ka = key(a), kb = key(b); for (let i = 0; i < ka.length; i++) { if (ka[i] < kb[i]) return -1; if (ka[i] > kb[i]) return 1; } return 0; });
    return rows;
  }
  function sparkline(hist, price) {
    const pts = (hist || []).filter(h => h.rs !== null && h.rs !== undefined).sort((a, b) => (a.date || '') < (b.date || '') ? -1 : 1).slice(-10);
    if (pts.length < 2) return null;
    const w = 72, h = 20, vals = pts.map(p => Number(p.rs));
    const lo = Math.min(0, ...vals), hi = Math.max(...vals, 1);
    const sx = i => 2 + i * (w - 4) / (pts.length - 1), sy = v => h - 2 - (v - lo) * (h - 4) / (hi - lo || 1);
    const d = vals.map((v, i) => (i ? 'L' : 'M') + sx(i).toFixed(1) + ' ' + sy(v).toFixed(1)).join(' ');
    const svg = svgEl('svg', { class: 'spark', viewBox: '0 0 ' + w + ' ' + h, 'aria-hidden': 'true' },
      svgEl('path', { d, fill: 'none', stroke: 'var(--muted)', 'stroke-width': 1.5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }),
      svgEl('circle', { cx: sx(pts.length - 1), cy: sy(vals[vals.length - 1]), r: 2.5, fill: 'var(--accent)' }));
    return svg;
  }
  function meterClass(p) { return p >= 0.7 ? 'g' : p >= 0.5 ? 'w' : 'c'; }
  function ringEl(p, size) {
    const r = 23, circ = 2 * Math.PI * r, off = circ * (1 - Math.max(0, Math.min(1, p)));
    const w = el('div', { class: 'ring ' + meterClass(p), style: size ? 'width:' + size + 'px;height:' + size + 'px' : null, role: 'img', 'aria-label': pct0(p) + ' chance of a listing gain' });
    w.append(svgEl('svg', { viewBox: '0 0 56 56', 'aria-hidden': 'true' },
      svgEl('circle', { class: 't', cx: 28, cy: 28, r }),
      svgEl('circle', { class: 'v', cx: 28, cy: 28, r, 'stroke-dasharray': circ.toFixed(1), 'stroke-dashoffset': off.toFixed(1), style: '--circ:' + circ.toFixed(1) })));
    w.append(el('div', { class: 'pv', text: pct0(p) }));
    return w;
  }
  function rangeBar(g) {
    const lo = -30, hi = 90; // fixed scale so rows compare
    const cx = v => Math.max(0, Math.min(100, (v - lo) / (hi - lo) * 100));
    const r = el('div', { class: 'range', role: 'img', 'aria-label': 'Likely gain from ' + pct(g.p10, 0) + ' to ' + pct(g.p90, 0) + ', middle ' + pct(g.p50, 0) });
    r.append(el('div', { class: 'track' }), el('div', { class: 'zero', style: 'left:' + cx(0) + '%' }));
    const l = cx(g.p10), rr = cx(g.p90);
    r.append(el('div', { class: 'band', style: 'left:' + l + '%;width:' + Math.max(1, rr - l) + '%' }), el('div', { class: 'mid', style: 'left:' + cx(g.p50) + '%' }));
    return r;
  }
  function subsBlock(sub, status) {
    const b = el('div', { class: 'subs' });
    const max = Math.max(1, ...['qib', 'nii', 'retail'].map(k => Number(sub[k]) || 0));
    const scale = v => Math.min(100, 100 * Math.log1p(v) / Math.log1p(Math.max(max, 10)));
    for (const [k, lab, tk] of [['qib', 'Institutions', 'qib'], ['nii', 'Wealthy', 'nii'], ['retail', 'Retail', 'retail']]) {
      const v = sub[k];
      b.append(term(tk, lab, 'k'),
        el('div', { class: 'bar' }, el('i', { style: 'width:' + (v === null || v === undefined ? 0 : scale(Number(v))) + '%' })),
        el('span', { class: 'num', text: x(v === null || v === undefined ? null : Number(v)) }));
    }
    return b;
  }
  function renderTable() {
    renderChipCounts();
    const body = $('#pipe-body'); body.replaceChildren();
    const rows = visible();
    if (!rows.length) { body.append(el('tr', null, el('td', { colspan: 9, class: 'empty' }, LIVE.ipos.length ? 'Nothing matches these filters.' : 'No IPO data in this snapshot yet.'))); return; }
    for (const r of rows) {
      const ipo = r.eff, s = r.score;
      const tr = el('tr', { class: 'row', id: 'row-' + ipo.id, tabindex: 0, 'aria-expanded': state.open === ipo.id ? 'true' : 'false', 'data-id': ipo.id, style: '--i:' + Math.min(12, body.children.length / 2) });
      // name
      const name = el('td', { class: 'name', 'data-l': 'IPO' }, el('div', { class: 'n', text: ipo.name }));
      const chips = el('div', { class: 'chips' },
        el('span', { class: 'chip board-' + ipo.board, text: ipo.board === 'sme' ? 'SME' : 'Mainboard' }),
        el('span', { class: 'chip st-' + ipo.status, text: ({ open: 'Open', upcoming: 'Upcoming', closed: 'Awaiting listing', listed: 'Listed' })[ipo.status] || ipo.status }),
        r.edited ? el('span', { class: 'chip', text: 'what-if' }) : null,
        ipo.status !== 'listed' ? starButton(ipo) : null,
        cardButton(r));
      name.append(chips);
      const dl = [];
      if (ipo.open_date || ipo.close_date) dl.push('Bids ' + dshort(ipo.open_date) + '–' + dshort(ipo.close_date));
      if (ipo.listing_date) dl.push('Lists ' + dshort(ipo.listing_date));
      if (ipo.issue_size_cr) dl.push('₹' + Number(ipo.issue_size_cr).toLocaleString('en-IN', { maximumFractionDigits: 0 }) + ' cr');
      name.append(el('div', { class: 'dates', text: dl.join(' · ') }));
      tr.append(name);
      // price
      const minLots = Number(ipo.min_lots) || (ipo.board === 'sme' ? 2 : 1);
      const inv = ipo.issue_price && ipo.lot_size ? ipo.issue_price * ipo.lot_size * minLots : null;
      tr.append(el('td', { 'data-l': 'Price × lot size' }, el('div', { class: 'num' }, ipo.issue_price ? '₹' + ipo.issue_price : (ipo.price_band_high ? '₹' + ipo.price_band_low + '–' + ipo.price_band_high : '–'), ipo.lot_size ? ' × ' + ipo.lot_size + (minLots > 1 ? ' × ' + minLots + ' lots' : '') : ''),
        el('div', { class: 'num ink2', text: inv ? inr(inv) + (minLots > 1 ? ' minimum' : ' a lot') : '' })));
      // gmp
      const unq = s && s.flags.includes('gmp_unquoted');
      const g = unq ? null : S.gmpPctOf(ipo), gm = ipo.gmp || {};
      const gtd = el('td', { 'data-l': 'Unofficial premium (GMP)' });
      gtd.append(el('div', { class: 'big num ' + (g === null ? 'muted' : g > 0 ? 'pos' : 'neg'), text: g === null ? (unq ? 'no quote' : '–') : pct(g, 1) }));
      if (!unq && gm.rs !== null && gm.rs !== undefined) gtd.append(el('div', { class: 'small muted num', text: '₹' + gm.rs + ' a share' + (gm.as_of ? ' · ' + dshort(gm.as_of) : '') }));
      const sp = sparkline(S.gmpHistoryOf(ipo), ipo.issue_price); if (sp) gtd.append(sp);
      if (s && s.flags.includes('gmp_stale')) gtd.append(el('div', { class: 'small stale', text: 'quote is 3+ days old' }));
      tr.append(gtd);
      // subscription
      const sub = ipo.subscription || {};
      const std = el('td', { 'data-l': 'Demand (times subscribed)' });
      if (['qib', 'nii', 'retail'].some(k => sub[k] !== null && sub[k] !== undefined)) {
        std.append(subsBlock(sub, ipo.status));
        std.append(el('div', { class: 'small muted', text: 'overall ' + x(sub.total) + (ipo.status === 'closed' || ipo.status === 'listed' ? ' final' : (sub.day ? ' on day ' + sub.day : ' so far')) }));
      } else if (sub.total !== null && sub.total !== undefined) {
        std.append(el('div', { class: 'num', text: x(sub.total) + ' total' }));
      } else std.append(el('span', { class: 'muted', text: ipo.status === 'upcoming' ? 'not open yet' : '–' }));
      tr.append(std);
      // probability
      const ptd = el('td', { 'data-l': 'Chance of listing gain', class: 'pcell' });
      if (ipo.status === 'listed' && ipo.listing && ipo.listing.gain_pct !== null && ipo.listing.gain_pct !== undefined) {
        ptd.append(el('div', { class: 'big num ' + (ipo.listing.gain_pct > 0 ? 'pos' : 'neg'), text: 'Listed ' + pct(ipo.listing.gain_pct, 1) }));
        if (s && s.p_up !== null) ptd.append(el('div', { class: 'small muted', text: 'model said ' + pct0(s.p_up) + ' chance of a gain' }));
      } else if (s && s.p_up !== null) {
        const txt = el('div', { class: 'txt' });
        txt.append(el('div', { class: 'ink2', text: oddsText(s.p_up) }));
        if (s.similar && s.similar.n >= 8 && s.similar.lo !== null && s.similar.lo !== undefined) txt.append(el('div', { class: 'muted', text: 'past IPOs with premium ' + s.similar.bucket + ': ' + s.similar.n_up + ' of ' + s.similar.n + ' listed up' }));
        const cap = s.confidence === 'high' ? 'based on final demand figures' : s.confidence === 'low' ? 'based on the premium only'
          : s.confidence === 'medium' ? (ipo.status === 'open' ? 'bidding still on; will firm up' : 'final demand figures, no premium quote') : '';
        if (cap) txt.append(el('div', { class: 'muted', text: cap }));
        ptd.append(el('div', { class: 'chance' }, ringEl(s.p_up), txt));
      } else ptd.append(el('span', { class: 'muted', text: 'not enough data' }));
      tr.append(ptd);
      // gain range
      const gtd2 = el('td', { 'data-l': 'Likely gain, worst to best' });
      if (s && s.gain && ipo.status !== 'listed') {
        gtd2.append(el('div', { class: 'num' }, el('b', null, pct(s.gain.p50, 0)), el('span', { class: 'muted', text: ' middle case' })));
        gtd2.append(rangeBar(s.gain));
        gtd2.append(el('div', { class: 'range-labels num' }, el('span', null, pct(s.gain.p10, 0)), el('span', null, pct(s.gain.p90, 0))));
      } else if (ipo.status === 'listed' && ipo.listing) {
        gtd2.append(el('div', { class: 'small num ink2', text: 'open ' + (ipo.listing.open ? '₹' + ipo.listing.open : '–') + ' · close ' + (ipo.listing.close ? '₹' + ipo.listing.close : '–') }));
        if (s && s.gain) gtd2.append(el('div', { class: 'small muted num', text: 'model range ' + pct(s.gain.p10, 0) + ' to ' + pct(s.gain.p90, 0) }));
      } else gtd2.append(el('span', { class: 'muted', text: '–' }));
      tr.append(gtd2);
      // allotment
      const atd = el('td', { 'data-l': 'Chance of getting shares' });
      const al = s && s.allotment;
      if (al && al.p_min_lot !== null && al.p_min_lot !== undefined) {
        atd.append(el('div', { class: 'big num', text: al.p_min_lot >= 0.999 ? 'Full' : '1 in ' + (1 / al.p_min_lot).toFixed(1 / al.p_min_lot >= 10 ? 0 : 1) }));
        atd.append(el('div', { class: 'small muted', text: al.p_min_lot >= 0.999 ? 'everyone who applies gets shares' : 'retail bid ' + x(sub.retail) + ' the shares on offer' + (ipo.status === 'open' ? '; odds will worsen' : '') }));
      } else atd.append(el('span', { class: 'muted', text: ipo.status === 'upcoming' ? 'known once bidding starts' : '–' }));
      tr.append(atd);
      // EV
      const etd = el('td', { class: 'ev', 'data-l': 'Worth per application, on average' });
      if (s && s.ev.ev !== null && s.ev.ev !== undefined && ipo.status !== 'listed') {
        etd.append(el('div', { class: 'big num ' + (s.ev.ev > 0 ? 'pos' : 'neg'), text: inr(s.ev.ev, { plus: true }) }));
        etd.append(el('div', { class: 'small muted num', text: 'if you get shares ' + inr(s.ev.ev_if_allotted, { plus: true }) + ' · on a bad day ' + inr(s.ev.downside_if_allotted, { plus: true }) }));
        const invA = s.ev.invested_if_allotted, resA = invA && s.gain ? S.netProfitOnSale(invA, invA * (1 + s.gain.mean / 100), state.costs) : null;
        if (resA) etd.append(el('div', { class: 'small muted', text: 'after ' + inr(resA.charges + resA.tax) + ' charges & tax' }));
      } else if (s && s.gain && inv && ipo.status !== 'listed') {
        const res = S.netProfitOnSale(inv, inv * (1 + s.gain.mean / 100), state.costs);
        etd.append(el('div', { class: 'big num ' + (res.net > 0 ? 'pos' : 'neg'), text: inr(res.net, { plus: true }) }));
        etd.append(el('div', { class: 'small muted', text: 'if you get shares; odds unknown until bidding starts' }));
        etd.append(el('div', { class: 'small muted', text: 'after ' + inr(res.charges + res.tax) + ' charges & tax' }));
      } else etd.append(el('span', { class: 'muted', text: '–' }));
      tr.append(etd);
      // verdict
      const vtd = el('td', { 'data-l': 'Verdict' });
      if (ipo.status === 'listed') vtd.append(el('span', { class: 'muted small', text: 'done' }));
      else if (s) {
        vtd.append(el('span', { class: 'verdict ' + s.verdict.tier, 'data-term': 'verdicts', text: s.verdict.label }));
        if (s.verdict.gamble) vtd.append(el('span', { class: 'gamble ' + s.verdict.gamble, 'data-term': 'gamble', text: s.verdict.gamble === 'sure' ? 'Sure gamble' : 'Possible gamble' }));
        if (ipo.status === 'closed') vtd.append(el('span', { class: 'small muted', style: 'display:block;margin-top:4px', text: 'bids closed; applies to those who got shares' }));
      }
      tr.append(vtd);
      tr.addEventListener('click', (ev) => { if (ev.target.closest('a')) return; toggle(ipo.id); });
      tr.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(ipo.id); } });
      body.append(tr);
      const dtr = el('tr', { class: 'drow', hidden: state.open === ipo.id ? null : '' }, el('td', { colspan: 9 }));
      if (state.open === ipo.id) dtr.firstChild.append(detail(r));
      body.append(dtr);
    }
  }
  function toggle(id) { state.open = state.open === id ? null : id; keepFocus(renderTable); }
  function detail(r) {
    const ipo = r.eff, s = r.score, sub = ipo.subscription || {};
    const d = el('div', { class: 'detail' });
    // reasons & warnings
    const c1 = el('div');
    c1.append(el('h3', { text: 'Why this verdict' }));
    const ul = el('ul');
    if (s) { for (const w of s.verdict.warnings) ul.append(el('li', { class: 'w', text: w })); for (const w of s.verdict.reasons) ul.append(el('li', { text: w })); }
    if (!ul.children.length) ul.append(el('li', { class: 'muted', text: 'Nothing to say yet.' }));
    c1.append(ul);
    if (s && s.similar && s.similar.n >= 5 && s.similar.lo !== null && s.similar.lo !== undefined) c1.append(el('p', { class: 'small ink2' }, 'Past ' + (ipo.board === 'sme' ? 'SME' : 'mainboard') + ' IPOs with a premium of ' + s.similar.bucket + ': ' + s.similar.n_up + ' of ' + s.similar.n + ' ended day one above the issue price; typical gain ' + pct(s.similar.median_gain, 0) + ', bad case ' + pct(s.similar.p10_gain, 0) + '.'));
    const srcs = ipo.sources || {};
    const links = [];
    for (const k of Object.keys(srcs)) { try { const u = new URL(String(srcs[k])); if ((u.protocol === 'https:' || u.protocol === 'http:') && u.hostname) links.push(u); } catch (e) { /* not a URL */ } }
    if (links.length) { const sd = el('div', { class: 'srcs' }, el('span', { class: 'muted', text: 'Sources:' })); const seen = new Set(); for (const u of links) { const hn = u.hostname.replace(/^www\./, ''); if (seen.has(hn)) continue; seen.add(hn); sd.append(el('a', { href: u.href, target: '_blank', rel: 'noopener', text: u.hostname.replace(/^www\./, '') })); } c1.append(sd); }
    d.append(c1);
    // money
    const c2 = el('div');
    c2.append(el('h3', { text: (s && s.ev && s.ev.min_lots > 1 ? 'The money, for the minimum application (' + s.ev.min_lots + ' lots) sold on listing day' : 'The money, for one lot sold on listing day') }));
    const inv = s && s.ev && s.ev.invested_if_allotted ? s.ev.invested_if_allotted : (ipo.issue_price && ipo.lot_size ? ipo.issue_price * ipo.lot_size : null);
    if (inv && s && s.gain) {
      const mid = S.netProfitOnSale(inv, inv * (1 + s.gain.mean / 100), state.costs);
      const dl = el('dl', { class: 'kv' });
      const kv = (k, v, extra) => dl.append(el('dt', null, k, extra ? el('span', { class: 'muted', text: extra }) : null), el('dd', { class: 'num', text: v }));
      kv('Money blocked when you apply', inr(inv));
      kv('What it sells for at the expected gain (' + pct(s.gain.mean, 0) + ')', inr(inv * (1 + s.gain.mean / 100)));
      kv('Profit before charges', inr(mid.gross, { plus: true }));
      kv(term('charges', 'Broker and exchange charges') , '−' + inr(mid.charges), ' (' + ($('#p-broker option:checked') ? $('#p-broker option:checked').textContent : 'broker') + ')');
      kv(term('tax', 'Tax on the profit'), '−' + inr(mid.tax), ' (' + state.costs.stcg_tax_pct + '% + ' + state.costs.cess_pct + '% cess)');
      kv('In hand if you get shares', inr(mid.net, { plus: true }));
      kv('Same, at the middle-case gain (' + pct(s.gain.p50, 0) + ')', inr(S.netProfitOnSale(inv, inv * (1 + s.gain.p50 / 100), state.costs).net, { plus: true }));
      if (s.allotment && s.allotment.p_min_lot !== null && s.allotment.p_min_lot !== undefined) {
        kv(term('allot', 'Chance of getting shares'), pct0(s.allotment.p_min_lot));
        kv(term('worth', 'Worth per application, on average'), inr(s.ev.ev, { plus: true }));
      }
      if (s.ev.lots_affordable > (s.ev.min_lots || 1)) kv('Lots within the ₹2 lakh retail cap', String(s.ev.lots_affordable));
      c2.append(dl);
      c2.append(el('p', { class: 'small muted', text: s.allotment && s.allotment.basis ? s.allotment.basis + '.' : '' }));
    } else c2.append(el('p', { class: 'muted small', text: 'Needs an issue price, a lot size and either a premium quote or demand figures.' }));
    d.append(c2);
    // what-if
    const c3 = el('div');
    c3.append(el('h3', { text: 'Try your own numbers' }));
    const wi = el('div', { class: 'whatif' });
    const e = state.edits[ipo.id] || {};
    const inp = (k, lab, v, step) => { const i = el('input', { type: 'number', step: step || 'any', id: 'wi-' + ipo.id + '-' + k, value: v === null || v === undefined ? '' : (Number.isInteger(Number(v)) ? v : Number(v).toFixed(2)), placeholder: '–' }); wi.append(el('label', null, lab, i)); return i; };
    const iG = inp('gmp', 'Premium ₹ (GMP)', e.gmp_rs !== undefined ? e.gmp_rs : (ipo.gmp && ipo.gmp.rs), 1);
    const iQ = inp('qib', 'Institutions x', e.qib !== undefined ? e.qib : sub.qib, 0.1);
    const iN = inp('nii', 'Wealthy x', e.nii !== undefined ? e.nii : sub.nii, 0.1);
    const iR = inp('retail', 'Retail x', e.retail !== undefined ? e.retail : sub.retail, 0.1);
    c3.append(wi);
    const btns = el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' });
    btns.append(el('button', { class: 'btn primary small', type: 'button', id: 'wi-go-' + ipo.id, onclick: () => {
      const ed = {};
      const src = r.ipo, ssub = src.subscription || {}, sg = src.gmp || {};
      const num = i => i.value === '' ? undefined : Number(i.value);
      const differs = (v, orig) => v !== undefined && !(orig !== null && orig !== undefined && Number(orig) === v);
      if (differs(num(iG), sg.rs)) ed.gmp_rs = num(iG);
      if (differs(num(iQ), ssub.qib)) ed.qib = num(iQ);
      if (differs(num(iN), ssub.nii)) ed.nii = num(iN);
      if (differs(num(iR), ssub.retail)) ed.retail = num(iR);
      if (Object.keys(ed).length) state.edits[ipo.id] = ed; else delete state.edits[ipo.id];
      computeAll(); keepFocus(renderAll);
    } }, 'Recompute'));
    btns.append(el('button', { class: 'btn small', type: 'button', id: 'wi-reset-' + ipo.id, onclick: () => { delete state.edits[ipo.id]; computeAll(); keepFocus(renderAll); } }, 'Reset'));
    btns.append(el('button', { class: 'btn small', type: 'button', id: 'share-' + ipo.id, onclick: () => shareIpoCard(r) }, 'Share as image'));
    btns.append(el('button', { class: 'btn small', type: 'button', id: 'sharet-' + ipo.id, onclick: () => shareText(readText(r), ipo.name + ' · IPO Radar') }, 'Share as text'));
    c3.append(btns);
    c3.append(el('p', { class: 'small muted', text: 'Type today’s premium or the latest demand figures and the row above updates. Edits live only on this device.' }));
    d.append(c3);
    return d;
  }

  // ------------------------------------------------------------- planner ---
  let plannerInputsSet = false;
  function writePlannerInputs() {
    setTimeout(syncSelects, 0);
    const p = state.plan, c = state.costs;
    $('#p-capital').value = p.capital; $('#p-accounts').value = p.accounts; $('#p-target').value = p.target; $('#p-broker').value = p.broker;
    $('#c-brok').value = c.brokerage_pct; $('#c-min').value = c.brokerage_min; $('#c-cap').value = c.brokerage_cap; $('#c-dp').value = c.dp_charge; $('#c-stt').value = c.stt_pct; $('#c-tax').value = c.stcg_tax_pct; $('#c-cess').value = c.cess_pct;
  }
  function renderPlanner() {
    const p = state.plan;
    if (!plannerInputsSet) { writePlannerInputs(); plannerInputsSet = true; }
    const out = $('#plan-result'); out.replaceChildren();
    const ttl = $('#plan-title'); if (ttl) ttl.textContent = p.target > 0 ? 'Can this make ' + inr(p.target) + ' a month?' : 'What is this batch worth?';
    const cands = SCORED.filter(r => r.score && ['open', 'upcoming'].includes(r.ipo.status) && r.score.p_up !== null && r.ipo.issue_price && r.ipo.lot_size);
    if (!cands.length) { out.append(el('p', { class: 'muted', text: 'Nothing is open or upcoming with a usable read right now, so there is nothing to plan. Issues whose bidding has closed cannot be applied to.' })); return; }
    if (p.picked === null) p.picked = cands.filter(r => ['apply', 'lean'].includes(r.score.verdict.tier)).map(r => r.ipo.id);
    const picked = new Set(p.picked);
    const accounts = Math.max(1, Math.round(p.accounts || 1));
    let totalEv = 0, totalBlock = 0, pNone = 1, rows = [], posEv = 0, posBlock = 0;
    for (const r of cands) {
      const inv = r.score.ev.invested_if_allotted || r.ipo.issue_price * r.ipo.lot_size;
      const s = r.score;
      const pa = s.allotment && s.allotment.p_min_lot !== null && s.allotment.p_min_lot !== undefined ? s.allotment.p_min_lot : null;
      const evIf = s.ev.ev_if_allotted !== null && s.ev.ev_if_allotted !== undefined ? s.ev.ev_if_allotted : S.netProfitOnSale(inv, inv * (1 + s.gain.mean / 100), state.costs).net;
      const ev1 = pa === null ? null : pa * evIf;
      const on = picked.has(r.ipo.id);
      if (on) { totalBlock += inv * accounts; if (ev1 !== null) { totalEv += ev1 * accounts; pNone *= Math.pow(1 - pa, accounts); if (ev1 > 0) { posEv += ev1 * accounts; posBlock += inv * accounts; } } }
      rows.push({ r, inv, pa, evIf, ev1, on });
    }
    let grossSum = 0, costSum = 0;
    for (const q of rows) if (q.on && q.r.score.gain) { const res = S.netProfitOnSale(q.inv, q.inv * (1 + q.r.score.gain.mean / 100), state.costs); grossSum += res.gross * accounts; costSum += (res.charges + res.tax) * accounts; }
    const overCap = totalBlock > p.capital;
    const hero = el('div', { class: 'hero num ' + (totalEv > 0 ? 'pos' : 'neg'), text: inr(totalEv, { plus: true }) });
    out.append(el('div', { class: 'eyebrow', text: 'Average profit in hand, after charges and tax, from the ticked IPOs across ' + accounts + ' account' + (accounts > 1 ? 's' : '') }));
    out.append(hero);
    const anyUnknown = rows.some(q => q.on && q.pa === null);
    const need = posEv > 0 ? p.target / (posEv / Math.max(1, posBlock)) : null;
    const vs = [];
    vs.push('Against a ' + inr(p.target) + ' monthly target: ' + (totalEv >= p.target ? 'on paper this batch gets there.' : 'this batch covers ' + Math.round(100 * totalEv / Math.max(1, p.target)) + '% of it.'));
    if (need !== null && isFinite(need)) vs.push('At these odds you would need about ' + inrShort(need) + ' blocked per round to expect ' + inr(p.target) + ', because the share lottery, not the premium, sets the ceiling.');
    vs.push('Blocked capital: ' + inr(totalBlock) + (overCap ? ', more than the ' + inr(p.capital) + ' you set.' : ' of your ' + inr(p.capital) + '.'));
    if (!anyUnknown && totalBlock > 0) vs.push('Chance that none of these applications gets any shares at all: ' + pct0(pNone) + '.');
    if (anyUnknown) vs.push('Some ticked IPOs have no demand figures yet, so their odds of shares (and their profit) are not counted.');
    if (costSum > 0) vs.push('If every ticked application got shares, broker and exchange charges plus ' + state.costs.stcg_tax_pct + '% tax would take ' + inr(costSum) + ' out of ' + inr(grossSum, { plus: true }) + ' profit; the figures above are after that.');
    out.append(el('p', { class: 'vs', text: vs.join(' ') }));
    const t = el('table', { class: 'plan sticky2' });
    t.append(el('thead', null, el('tr', null, el('th', { text: '' }), el('th', { text: 'IPO' }), el('th', { class: 'r', text: 'Money blocked' }), el('th', { class: 'r', text: 'Odds of shares' }), el('th', { class: 'r', text: 'If you get shares' }), el('th', { class: 'r', text: 'On average' }), el('th', { text: 'Verdict' }))));
    const tb = el('tbody');
    for (const q of rows) {
      const cb = el('input', { type: 'checkbox', id: 'pk-' + q.r.ipo.id, 'aria-label': 'Include ' + q.r.ipo.name });
      cb.checked = q.on;
      cb.addEventListener('change', () => { const set = new Set(state.plan.picked); if (cb.checked) set.add(q.r.ipo.id); else set.delete(q.r.ipo.id); state.plan.picked = [...set]; store('plan', state.plan); keepFocus(renderPlanner); });
      tb.append(el('tr', null, el('td', null, cb), el('td', null, q.r.ipo.name, ' ', el('span', { class: 'muted small', text: q.r.ipo.board === 'sme' ? 'SME' : '' })),
        el('td', { class: 'r num', text: inr(q.inv) }), el('td', { class: 'r num', text: q.pa === null ? '?' : pct0(q.pa) }),
        el('td', { class: 'r num ' + (q.evIf > 0 ? 'pos' : 'neg'), text: inr(q.evIf, { plus: true }) }), el('td', { class: 'r num', text: q.ev1 === null ? '?' : inr(q.ev1 * accounts, { plus: true }) }),
        el('td', null, el('span', { class: 'verdict ' + q.r.score.verdict.tier, text: q.r.score.verdict.label }))));
    }
    t.append(tb);
    t.append(el('tfoot', null, el('tr', null, el('td', { colspan: 2, text: 'Ticked total' }), el('td', { class: 'r num', text: inr(totalBlock) }), el('td'), el('td'), el('td', { class: 'r num', text: inr(totalEv, { plus: true }) }), el('td'))));
    out.append(hscroll(t));
    out.append(el('p', { class: 'small muted', text: '“Worth on average” is what many such applications would earn per application, not a promise for this one. Most months you will get shares in zero or one IPO; the profit arrives in lumps.' }));
  }
  function bindPlanner() {
    const upd = () => {
      // an empty box is someone mid-edit: leave the stored value alone until a number arrives
      const cap = $('#p-capital').value, acc = $('#p-accounts').value, tgt = $('#p-target').value;
      if (cap !== '') state.plan.capital = Math.max(0, Number(cap) || 0);
      if (acc !== '') state.plan.accounts = Math.min(10, Math.max(1, Math.round(Number(acc) || 1)));
      if (tgt !== '') state.plan.target = Math.max(0, Number(tgt) || 0);
      store('plan', state.plan); renderPlanner();
    };
    for (const id of ['#p-capital', '#p-accounts', '#p-target']) $(id).addEventListener('input', upd);
    $('#p-accounts').addEventListener('change', () => { $('#p-accounts').value = state.plan.accounts; });
    $('#p-broker').addEventListener('change', () => { state.plan.broker = $('#p-broker').value; state.costs = costsFor(state.plan.broker); store('plan', state.plan); writePlannerInputs(); computeAll(); keepFocus(renderAll); });
    const costUpd = () => {
      const c = state.costs;
      c.brokerage_pct = Number($('#c-brok').value) || 0; c.brokerage_min = Number($('#c-min').value) || 0; c.brokerage_cap = Number($('#c-cap').value) || 0; c.dp_charge = Number($('#c-dp').value) || 0;
      c.stt_pct = Number($('#c-stt').value) || 0; c.stcg_tax_pct = Number($('#c-tax').value) || 0; c.cess_pct = Number($('#c-cess').value) || 0;
      state.plan.broker = 'custom'; $('#p-broker').value = 'custom'; syncSelects(); store('plan', state.plan);
      store('customCosts', { brokerage_pct: c.brokerage_pct, brokerage_min: c.brokerage_min, brokerage_cap: c.brokerage_cap, dp_charge: c.dp_charge, stt_pct: c.stt_pct, stcg_tax_pct: c.stcg_tax_pct, cess_pct: c.cess_pct });
      computeAll(); keepFocus(renderAll);
    };
    for (const id of ['#c-brok', '#c-min', '#c-cap', '#c-dp', '#c-stt', '#c-tax', '#c-cess']) $(id).addEventListener('change', costUpd);
  }

  // --------------------------------------------------------- calibration ---
  const tip = $('#tip');
  function showTip(evt, lines) { tip.replaceChildren(); for (let i = 0; i < lines.length; i++) tip.append(i ? el('div', { text: lines[i] }) : el('b', { text: lines[i] })); tip.hidden = false; const pad = 12; let x0 = evt.clientX + pad, y0 = evt.clientY + pad; tip.style.left = Math.min(x0, window.innerWidth - 250) + 'px'; tip.style.top = Math.min(y0, window.innerHeight - 80) + 'px'; }
  function hideTip() { tip.hidden = true; }

  function chartGmp() {
    const host = $('#chart-gmp'); host.replaceChildren();
    host.append(el('h3', { text: 'What the premium promised vs what listing day delivered' }));
    host.append(el('p', { class: 'small muted', text: 'Each dot is a past IPO: across, the unofficial premium before listing; up, the actual first-day gain. Dots below the diagonal did worse than the premium promised.' }));
    const pts = HIST.filter(h => h.gmp_pct !== null && h.gmp_pct !== undefined && h.gain_pct !== null && h.gain_pct !== undefined && (h.basis === 'close' || h.basis === 'reported'));
    const skipped = HIST.filter(h => h.gmp_pct !== null && h.gmp_pct !== undefined && h.gain_pct !== null && h.gain_pct !== undefined).length - pts.length;
    if (pts.length < 10) { host.append(el('p', { class: 'muted small', text: 'Not enough past listings with both a recorded premium and a listing-day close to draw this yet' + (skipped ? ' (' + skipped + ' more have only a debut price).' : '.') })); return; }
    const W = 520, H = 340, m = { t: 12, r: 14, b: 38, l: 46 };
    const xs = pts.map(p => p.gmp_pct), ys = pts.map(p => p.gain_pct);
    const xlo = Math.max(-30, Math.min(...xs) - 5), xhi = Math.min(160, Math.max(...xs) + 5);
    const ylo = Math.max(-60, Math.min(...ys) - 5), yhi = Math.min(200, Math.max(...ys) + 5);
    const sx = v => m.l + (v - xlo) / (xhi - xlo) * (W - m.l - m.r), sy = v => H - m.b - (v - ylo) / (yhi - ylo) * (H - m.t - m.b);
    const svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': 'Scatter of pre-listing premium percent against actual listing-day gain percent for ' + pts.length + ' past IPOs' });
    const ticks = (lo, hi) => { const step = (hi - lo) > 150 ? 50 : (hi - lo) > 60 ? 20 : 10; const out = []; for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(v); return out; };
    for (const v of ticks(ylo, yhi)) { svg.append(svgEl('line', { x1: m.l, x2: W - m.r, y1: sy(v), y2: sy(v), stroke: 'var(--grid)', 'stroke-width': 1 })); svg.append(svgEl('text', { x: m.l - 6, y: sy(v) + 4, 'text-anchor': 'end', 'font-size': 11, fill: 'var(--muted)', 'font-family': 'var(--mono)' }, v + '%')); }
    for (const v of ticks(xlo, xhi)) { svg.append(svgEl('text', { x: sx(v), y: H - m.b + 16, 'text-anchor': 'middle', 'font-size': 11, fill: 'var(--muted)', 'font-family': 'var(--mono)' }, v + '%')); }
    svg.append(svgEl('line', { x1: m.l, x2: W - m.r, y1: sy(0), y2: sy(0), stroke: 'var(--axis)', 'stroke-width': 1 }));
    svg.append(svgEl('line', { x1: sx(0), x2: sx(0), y1: m.t, y2: H - m.b, stroke: 'var(--axis)', 'stroke-width': 1 }));
    // y = x reference: "GMP exactly right"
    const dx0 = Math.max(xlo, ylo), dx1 = Math.min(xhi, yhi);
    svg.append(svgEl('line', { x1: sx(dx0), y1: sy(dx0), x2: sx(dx1), y2: sy(dx1), stroke: 'var(--muted)', 'stroke-width': 1, 'stroke-dasharray': '4 4' }));
    svg.append(svgEl('text', { x: sx(dx1) - 4, y: sy(dx1) + 12, 'text-anchor': 'end', 'font-size': 11, fill: 'var(--muted)' }, 'premium exactly right'));
    svg.append(svgEl('text', { x: (m.l + W - m.r) / 2, y: H - 4, 'text-anchor': 'middle', 'font-size': 11, fill: 'var(--ink-2)' }, 'Unofficial premium the day before listing, % of issue price'));
    svg.append(svgEl('text', { x: 12, y: (m.t + H - m.b) / 2, 'text-anchor': 'middle', 'font-size': 11, fill: 'var(--ink-2)', transform: 'rotate(-90 12 ' + ((m.t + H - m.b) / 2) + ')' }, 'listing-day close vs issue price'));
    const g = svgEl('g');
    for (const p of pts) {
      const c = svgEl('circle', { cx: sx(Math.min(xhi, Math.max(xlo, p.gmp_pct))), cy: sy(Math.min(yhi, Math.max(ylo, p.gain_pct))), r: 4, fill: p.board === 'sme' ? 'var(--series-sme)' : 'var(--series-main)', stroke: 'var(--surface)', 'stroke-width': 2, 'fill-opacity': 0.85 });
      g.append(c);
    }
    svg.append(g);
    // nearest-point hover
    svg.addEventListener('pointermove', (evt) => {
      const r = svg.getBoundingClientRect(); const px = (evt.clientX - r.left) * W / r.width, py = (evt.clientY - r.top) * H / r.height;
      let best = null, bd = 1e9;
      for (const p of pts) { const d = Math.hypot(sx(Math.min(xhi, Math.max(xlo, p.gmp_pct))) - px, sy(Math.min(yhi, Math.max(ylo, p.gain_pct))) - py); if (d < bd) { bd = d; best = p; } }
      if (best && bd < 24) showTip(evt, [best.name, (best.board === 'sme' ? 'SME' : 'Mainboard') + ' · listed ' + dlong(best.listing_date), 'premium ' + pct(best.gmp_pct, 1) + ', listed ' + pct(best.gain_pct, 1)]); else hideTip();
    });
    svg.addEventListener('pointerleave', hideTip);
    host.append(svg);
    host.append(el('div', { class: 'legend' }, el('span', null, el('i', { style: 'background:var(--series-main)' }), 'Mainboard'), el('span', null, el('i', { style: 'background:var(--series-sme)' }), 'SME'), el('span', { class: 'muted', text: pts.length + ' listings with a recorded close' + (skipped ? '; ' + skipped + ' with only a debut price left out' : '') })));
    const above = pts.filter(p => p.gmp_pct > 0 && p.gain_pct <= 0).length, posG = pts.filter(p => p.gmp_pct > 0).length;
    host.append(el('p', { class: 'small ink2', text: 'Of the ' + posG + ' IPOs whose premium was positive, ' + above + ' (' + Math.round(100 * above / Math.max(1, posG)) + '%) still closed at or below the issue price on listing day. A positive premium is a hint, not a promise.' }));
    host.append(tableView('Table: premium vs listing gain', ['IPO', 'Board', 'Listed', 'Premium %', 'Gain %'], pts.slice().sort((a, b) => (b.listing_date || '') < (a.listing_date || '') ? -1 : 1).map(p => [p.name, p.board, p.listing_date || '', p.gmp_pct.toFixed(1), p.gain_pct.toFixed(1)])));
  }
  function chartRel() {
    const host = $('#chart-rel'); host.replaceChildren();
    host.append(el('h3', { text: 'When the model says 70%, does it happen 70% of the time?' }));
    host.append(el('p', { class: 'small muted', text: 'The honesty check. Dots on the diagonal mean the chances are trustworthy; above it the model is too modest, below it too confident.' }));
    if (!PARAMS || !PARAMS.metrics || !PARAMS.metrics.reliability.length) { host.append(el('p', { class: 'muted small', text: PARAMS && PARAMS.status === 'prior' ? 'This chart appears once the model has been fitted to at least ' + (PARAMS.min_rows_to_calibrate || 120) + ' past listings. Until then the chances come from starting weights and have not been checked against outcomes, which is why the app calls them first estimates.' : 'No calibration report in this snapshot.' })); return; }
    const rel = PARAMS.metrics.reliability;
    const W = 520, H = 340, m = { t: 12, r: 14, b: 38, l: 46 };
    const sx = v => m.l + v * (W - m.l - m.r), sy = v => H - m.b - v * (H - m.t - m.b);
    const svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': 'Reliability diagram: predicted probability against observed share of IPOs that listed above issue price' });
    for (let v = 0; v <= 1.0001; v += 0.2) { svg.append(svgEl('line', { x1: m.l, x2: W - m.r, y1: sy(v), y2: sy(v), stroke: 'var(--grid)' })); svg.append(svgEl('text', { x: m.l - 6, y: sy(v) + 4, 'text-anchor': 'end', 'font-size': 11, fill: 'var(--muted)', 'font-family': 'var(--mono)' }, Math.round(v * 100) + '%')); svg.append(svgEl('text', { x: sx(v), y: H - m.b + 16, 'text-anchor': 'middle', 'font-size': 11, fill: 'var(--muted)', 'font-family': 'var(--mono)' }, Math.round(v * 100) + '%')); }
    svg.append(svgEl('line', { x1: sx(0), y1: sy(0), x2: sx(1), y2: sy(1), stroke: 'var(--muted)', 'stroke-dasharray': '4 4' }));
    svg.append(svgEl('text', { x: (m.l + W - m.r) / 2, y: H - 4, 'text-anchor': 'middle', 'font-size': 11, fill: 'var(--ink-2)' }, 'predicted chance of a listing gain (out-of-sample)'));
    svg.append(svgEl('text', { x: 12, y: (m.t + H - m.b) / 2, 'text-anchor': 'middle', 'font-size': 11, fill: 'var(--ink-2)', transform: 'rotate(-90 12 ' + ((m.t + H - m.b) / 2) + ')' }, 'share that actually listed up'));
    const maxN = Math.max(...rel.map(r => r.n));
    const path = rel.map((r, i) => (i ? 'L' : 'M') + sx(r.pred).toFixed(1) + ' ' + sy(r.obs).toFixed(1)).join(' ');
    svg.append(svgEl('path', { d: path, fill: 'none', stroke: 'var(--accent)', 'stroke-width': 2, 'stroke-linejoin': 'round' }));
    for (const r of rel) {
      const c = svgEl('circle', { cx: sx(r.pred), cy: sy(r.obs), r: 4 + 6 * Math.sqrt(r.n / maxN), fill: 'var(--accent)', stroke: 'var(--surface)', 'stroke-width': 2 });
      c.addEventListener('pointermove', (evt) => showTip(evt, [Math.round(r.obs * 100) + '% listed up', 'when the model said ' + Math.round(r.pred * 100) + '%', r.n + ' IPOs in this bin']));
      c.addEventListener('pointerleave', hideTip);
      svg.append(c);
    }
    host.append(svg);
    const mt = PARAMS.metrics;
    host.append(el('p', { class: 'small ink2', text: 'Dots on the dashed line mean the probabilities are honest. Dot size is the number of IPOs in the bin. Expected calibration error ' + (mt.ece * 100).toFixed(1) + ' points; every number here is from 5-fold cross-validation, so the model never saw the IPO it was scoring.' }));
    host.append(tableView('Table: reliability bins', ['Predicted', 'Observed', 'IPOs'], rel.map(r => [Math.round(r.pred * 100) + '%', Math.round(r.obs * 100) + '%', String(r.n)])));
  }
  function tableView(title, head, rows) {
    const d = el('details', { class: 'tv' }, el('summary', { text: title }));
    const t = el('table', { class: 'data' });
    t.append(el('thead', null, el('tr', null, ...head.map(h => el('th', { text: h })))));
    const tb = el('tbody'); for (const r of rows) tb.append(el('tr', null, ...r.map(c => el('td', { class: 'num', text: c })))); t.append(tb);
    d.append(hscroll(t, 'max-height:260px;overflow-y:auto'));
    return d;
  }
  function bucketTable() {
    const host = $('#bucket-table'); host.replaceChildren();
    host.append(el('h3', { text: 'Past listings, grouped by their premium' }));
    host.append(el('p', { class: 'small muted', text: 'No model here, just counting. Find the row that matches an IPO’s premium and see how many like it listed up.' }));
    if (!PARAMS) return;
    const t = el('table', { class: 'data' });
    t.append(el('thead', null, el('tr', null, el('th', { text: 'Premium before listing' }), el('th', { text: 'Board' }), el('th', { text: 'IPOs' }), el('th', { text: 'Listed up' }), el('th', { text: 'Typical gain' }), el('th', { text: 'Bad case (worst 1 in 10)' }))));
    const tb = el('tbody');
    for (const r of PARAMS.empirical) { if (!r.n) continue; tb.append(el('tr', null, el('td', { text: r.bucket }), el('td', { text: r.board === 'sme' ? 'SME' : 'Mainboard' }), el('td', { class: 'num', text: String(r.n) }), el('td', { class: 'num', text: r.n_up + ' (' + Math.round(100 * r.p_up) + '%)' }), el('td', { class: 'num', text: pct(r.median_gain, 0) }), el('td', { class: 'num', text: pct(r.p10_gain, 0) }))); }
    t.append(tb);
    host.append(hscroll(t));
    host.append(el('p', { class: 'small muted', text: 'The “chance of a listing gain” in the pipeline should roughly agree with these counts. If it does not, trust neither until there is more data.' }));
  }
  function coefTable() {
    const host = $('#coef-table'); host.replaceChildren();
    host.append(el('h3', { text: 'What moves the chance up or down' }));
    if (!PARAMS) return;
    const NAMES = { gmp_pct: 'Premium, % of issue price', gmp_missing: 'No premium quote at all', log_sub_qib: 'Institutional demand', log_sub_nii: 'Wealthy-investor demand', log_sub_retail: 'Retail demand', sub_missing: 'No demand figures', is_sme: 'SME issue', log_issue_size: 'Issue size', nifty_1m_pct: 'Nifty, past month', gmp_trend_pct: 'Premium trend, last few quotes' };
    const rows = PARAMS.coef_table.slice().sort((a, b) => Math.abs(b.coef_std) - Math.abs(a.coef_std));
    const maxAbs = Math.max(...rows.map(r => Math.abs(r.coef_std)), 0.01);
    const box = el('div', { class: 'coef' });
    for (const r of rows) {
      const w = Math.abs(r.coef_std) / maxAbs * 50;
      const bar = el('div', { class: 'bar' }, el('div', { class: 'z' }), el('i', { style: r.coef_std >= 0 ? 'left:50%;width:' + w + '%' : 'left:' + (50 - w) + '%;width:' + w + '%' }));
      box.append(el('div', { class: 'r' }, el('span', { text: NAMES[r.feature] || r.feature }), bar, el('span', { class: 'num', style: 'text-align:right', text: (r.coef_std >= 0 ? '+' : '') + r.coef_std.toFixed(2) })));
    }
    host.append(box);
    host.append(el('p', { class: 'small muted', text: PARAMS.status === 'calibrated'
      ? 'Bars to the right raise the chance, bars to the left lower it; longer means stronger. (For the technically minded: effect on the log-odds per one standard deviation of the input, others held fixed, ridge-shrunk toward the prior weights.)'
      : 'Starting weights, not yet fitted to data. They encode the usual order of importance: the premium first, institutional demand second. Bar lengths are not comparable across rows here; they will be once the model is fitted.' }));
  }
  function methodText() {
    const host = $('#method-body'); host.replaceChildren();
    const srcs = (LIVE.sources || []).filter(s => s.ok).map(s => s.url);
    const hosts = [...new Set(srcs.map(u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return u; } }))];
    host.append(el('div', { class: 'note' }, el('b', null, 'This is a decision aid, not a tip sheet. '), 'A 75% chance of a gain is a 25% chance of a loss. Apply only with money that can stay stuck if the listing goes wrong, never with borrowed money, and never to an issue you would not hold for a few weeks.'));
    host.append(el('h3', { text: 'In plain words' }));
    host.append(el('ul', null,
      el('li', null, 'The app looks at three things for every IPO: the unofficial premium dealers are paying before listing, how many times over each investor group has bid, and the market mood. From past listings it has learned how those three turned into first-day gains, and it applies that to each new IPO.'),
      el('li', null, 'It then counts the lottery. In a popular IPO most applicants get no shares, so the app multiplies the profit by your chance of getting shares before calling anything “worth it”.'),
      el('li', null, 'Broker charges and tax are deducted from every rupee figure shown as “in hand”.'),
      el('li', null, 'It tells you when it is unsure: “Too early”, “Not enough data”, and the gamble flags are there so you do not block money on a guess.')));
    host.append(el('h3', { text: 'How the chance of a listing gain is computed (technical)' }));
    host.append(el('ul', null,
      el('li', null, 'A ridge-penalised logistic regression predicts whether an IPO closes above its issue price on listing day. Inputs: GMP as a percentage of the issue price, its recent trend, the QIB, NII and retail subscription multiples, the board (mainboard or SME), the issue size and the Nifty 50 one-month move. Missing inputs are signalled to the model rather than filled with guesses.'),
      el('li', null, 'A second regression predicts the size of the gain; the P10–P90 band is built from that model’s out-of-sample errors, kept separate for SME and mainboard because SME outcomes are far wider.'),
      el('li', null, 'The “past listings by GMP bucket” table is the model-free cross-check. If the two disagree badly, trust neither until there is more data.'),
      el('li', null, 'Every quality figure (AUC, Brier, calibration error) is 5-fold cross-validated. The fit is refreshed each time the history grows.')));
    host.append(el('h3', { text: 'Allotment and what one application is worth' }));
    host.append(el('ul', null,
      el('li', null, 'Retail applications are capped at ₹2 lakh. When the retail book is oversubscribed, SEBI’s rule gives every applicant an equal shot at exactly one minimum lot by computerised lottery, so the chance is roughly 1 ÷ (retail times subscribed), whether you bid one lot or ten. Bidding more lots only helps when the book is under-subscribed.'),
      el('li', null, 'Expected value of an application = chance of allotment × net profit on one lot at the model’s mean gain. Net profit deducts brokerage, STT (0.1% on a delivery sell), exchange and SEBI charges, GST, the depository charge per sell, and short-term capital gains tax at 20% plus cess. Change the broker preset to match yours.'),
      el('li', null, 'Family members’ demat accounts each count as one application in their own name. Multiple applications from one PAN are rejected.')));
    host.append(el('h3', { text: 'Verdict rules' }));
    host.append(el('ul', null,
      el('li', null, el('b', null, 'Apply'), ': chance of gain 75% or more, middle gain at least 5%, positive expected value, and no warnings. Mainboard only: an SME issue tops out at Lean apply because its outcomes are too wide for a full call.'),
      el('li', null, el('b', null, 'Lean apply'), ': chance 60% or more with at most one warning, or a strong GMP-only read before subscription data exists.'),
      el('li', null, el('b', null, 'Coin flip'), ': 40–60%, or a stronger read pulled down by two or more warnings. A possible gamble.'),
      el('li', null, el('b', null, 'Avoid'), ': under 40% or negative expected value. A sure gamble: the odds are against you before you start.'),
      el('li', null, el('b', null, 'Too early'), ': bidding has not produced subscription figures yet and the GMP alone does not justify a lean; the chance shown is a first read, not a call. Decide on the last bidding day with the subscription numbers in.'),
      el('li', null, 'Warnings fire on: GMP at or below zero or under 5%; a GMP that fell sharply in the last few sessions; retail or QIB under-subscription at close; institution-only books (QIB 20x+ with HNI or retail under 2x); any SME issue (and SME under 10x); issues under ₹50 crore; a GMP quote older than three days.')));
    host.append(el('h3', { text: 'What this cannot know' }));
    host.append(el('ul', null,
      el('li', null, 'GMP is an unregulated, unofficial quote from grey-market dealers. It can be thin, stale, or steered, especially for small SME issues. It is an input here, not the answer. The record: in 2025, 56 of 101 mainboard IPOs listed below what their GMP implied; trackers that score it put the direction right roughly 72\u201383% of the time, with a median miss of about 3 percentage points on mainboard and about 20 on SME.'),
      el('li', null, 'A market shock on listing day (a bad global open, a sector-wide sell-off) is not in any pre-listing number.'),
      el('li', null, PARAMS && PARAMS.status === 'calibrated' ? 'The model is fitted on ' + PARAMS.n_rows + ' listings. That is enough to rank issues and to flag gambles; it is not enough to promise a specific gain on a specific IPO.' : 'The model is not yet fitted to data: it runs on documented prior weights checked against ' + (PARAMS ? PARAMS.n_rows : 0) + ' recent outcomes. It can rank issues and flag gambles; it cannot promise a specific gain on a specific IPO.'),
      el('li', null, 'Expected profit is an average over many applications. Hitting a monthly figure depends mostly on how many accounts you apply from and how oversubscribed retail is, not on picking the single best IPO.')));
    host.append(el('h3', { text: 'Data' }));
    host.append(el('p', { class: 'small ink2', text: 'Snapshot generated ' + (LIVE.generated_at || 'unknown') + '. ' + (hosts.length ? 'Sources read this refresh: ' + hosts.join(', ') + '.' : 'Source list is in the repository’s data/ipos.json.') + ' Subscription figures are the exchanges’ published multiples; GMP figures are what the grey-market trackers published on the stated date.' }));
  }

  // -------------------------------------------------------- native bridge ---
  const N = (typeof window.IpoNative === 'object' && window.IpoNative) ? window.IpoNative : null;
  let STATUS = null;
  function fmtTime(ms) { if (!ms) return null; const d = new Date(ms); return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  function renderStatus() {
    const host = $('#status .in'); host.replaceChildren();
    const gen = LIVE.generated_at ? new Date(LIVE.generated_at) : null;
    host.append(el('span', null, 'Data as of ', el('b', null, gen ? gen.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'unknown')));
    if (STATUS) {
      if (STATUS.downloaded_at) host.append(el('span', null, 'downloaded ', el('b', null, fmtTime(STATUS.downloaded_at))));
      else host.append(el('span', { class: 'muted', text: 'bundled with the app' }));
      if (STATUS.refreshing) host.append(el('span', { class: 'badge ok' }, el('i', { class: 'spin' }), 'refreshing'));
      else if (STATUS.online === false) host.append(el('span', { class: 'badge off', text: 'offline, showing last data' }));
      else if (STATUS.error) host.append(el('span', { class: 'badge err', text: 'last refresh failed' }));
      if (STATUS.schedule_hours > 0) host.append(el('span', { class: 'muted small', text: 'auto every ' + STATUS.schedule_hours + ' h' }));
    } else {
      const ageH = gen ? (Date.now() - gen.getTime()) / 36e5 : null;
      if (ageH !== null && ageH > 30) host.append(el('span', { class: 'badge off', text: Math.round(ageH / 24) + ' days old' }));
    }
    host.append(el('span', { class: 'spacer' }));
    host.append(el('button', { class: 'btn primary small', type: 'button', id: 'st-refresh', onclick: doRefresh }, STATUS && STATUS.refreshing ? 'Refreshing…' : 'Refresh'));
  }
  function doRefresh() {
    if (N) { try { N.refresh(); return; } catch (e) { /* fall through */ } }
    const b = $('#st-refresh'); if (b) { b.textContent = 'Live refresh works in the app'; setTimeout(() => { b.textContent = 'Refresh'; }, 2200); }
  }
  window.ipoRadarStatus = function (st) { STATUS = st || null; renderStatus(); renderSettings(); };
  if (N) { try { STATUS = JSON.parse(N.status()); } catch (e) { STATUS = null; } }

  function shareText(text, subject) {
    if (N) { try { N.shareText(text, subject); return; } catch (e) { /* fall through */ } }
    if (navigator.share) { navigator.share({ title: subject, text }).catch(() => {}); return; }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => alertNote('Copied to clipboard')).catch(() => alertNote('Copy failed'));
  }
  function shareFile(name, mime, content) {
    if (N) { try { N.shareFile(name, mime, content); return; } catch (e) { /* fall through */ } }
    if (navigator.share && window.File) { try { const f = new File([content], name, { type: mime }); if (navigator.canShare && navigator.canShare({ files: [f] })) { navigator.share({ files: [f], title: name }).catch(() => {}); return; } } catch (e) { /* fall through */ } }
    shareText(content, name);
  }
  function alertNote(msg) { const n = $('#s-note'); if (n) { n.textContent = msg; setTimeout(() => { if (n.textContent === msg) n.textContent = ''; }, 2500); } }
  function readText(r) {
    const ipo = r.eff, s = r.score; const lines = [];
    lines.push(ipo.name + ' (' + (ipo.board === 'sme' ? 'SME' : 'Mainboard') + ' IPO)');
    if (ipo.open_date || ipo.close_date) lines.push('Bids ' + dlong(ipo.open_date) + ' to ' + dlong(ipo.close_date) + (ipo.listing_date ? ', lists ' + dlong(ipo.listing_date) : ''));
    if (ipo.issue_price && ipo.lot_size) lines.push('Price ₹' + ipo.issue_price + ' × ' + ipo.lot_size + (s && s.ev && s.ev.min_lots > 1 ? ' × ' + s.ev.min_lots + ' lots' : '') + ' = ' + inr(s && s.ev && s.ev.invested_if_allotted ? s.ev.invested_if_allotted : ipo.issue_price * ipo.lot_size));
    const g = s && s.flags.includes('gmp_unquoted') ? null : S.gmpPctOf(ipo);
    if (g !== null) lines.push('premium ' + pct(g, 1));
    const sub = ipo.subscription || {};
    if (sub.qib !== null && sub.qib !== undefined) lines.push('Subscription: QIB ' + x(sub.qib) + ', NII ' + x(sub.nii) + ', retail ' + x(sub.retail) + ', total ' + x(sub.total));
    if (s && s.p_up !== null) lines.push('Chance of a listing gain: ' + pct0(s.p_up) + (s.gain ? ' · likely gain ' + pct(s.gain.p10, 0) + ' to ' + pct(s.gain.p90, 0) + ' (middle ' + pct(s.gain.p50, 0) + ')' : ''));
    if (s && s.allotment && s.allotment.p_min_lot !== null && s.allotment.p_min_lot !== undefined) lines.push('Allotment odds: ' + (s.allotment.p_min_lot >= 0.999 ? 'full' : '1 in ' + (1 / s.allotment.p_min_lot).toFixed(1)));
    if (s && s.ev.ev !== null && s.ev.ev !== undefined) lines.push('Worth per application after charges & tax: ' + inr(s.ev.ev, { plus: true }) + ' (if allotted ' + inr(s.ev.ev_if_allotted, { plus: true }) + ')');
    if (s) { lines.push('Verdict: ' + s.verdict.label + (s.verdict.gamble ? ' (' + s.verdict.gamble + ' gamble)' : '')); for (const w of s.verdict.warnings) lines.push('⚠ ' + w); }
    lines.push('— IPO Radar, data as of ' + (LIVE.generated_at || '').slice(0, 16).replace('T', ' ') + '. Not investment advice.');
    return lines.join('\n');
  }
  function shortlistText() {
    const rows = SCORED.filter(r => r.score && ['open', 'upcoming'].includes(r.ipo.status) && r.score.p_up !== null)
      .sort((a, b) => (ORDER[a.score.verdict.tier] - ORDER[b.score.verdict.tier]) || (b.score.p_up - a.score.p_up));
    const lines = ['IPO Radar shortlist, ' + (LIVE.generated_at || '').slice(0, 10)];
    for (const r of rows) lines.push('• ' + r.eff.name + (r.ipo.board === 'sme' ? ' (SME)' : '') + ': ' + r.score.verdict.label + ', ' + pct0(r.score.p_up) + ' chance' + (r.score.ev.ev !== null && r.score.ev.ev !== undefined ? ', worth ' + inr(r.score.ev.ev, { plus: true }) : '') + (r.ipo.status === 'open' ? ', closes ' + dshort(r.ipo.close_date) : ', opens ' + dshort(r.ipo.open_date)));
    lines.push('Not investment advice. Chances come from a model on past listings; the premium is unofficial.');
    return lines.join('\n');
  }
  function csvText() {
    const esc = v => { const t = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
    const head = ['name', 'board', 'status', 'open_date', 'close_date', 'listing_date', 'issue_price', 'lot_size', 'min_lots', 'gmp_rs', 'gmp_pct', 'sub_qib', 'sub_nii', 'sub_retail', 'sub_total', 'chance_of_gain', 'gain_p10', 'gain_p50', 'gain_p90', 'allotment_p', 'worth_per_application', 'verdict', 'gamble', 'listing_gain_pct'];
    const out = [head.join(',')];
    for (const r of SCORED) {
      const i = r.eff, s = r.score || {}, g = i.gmp || {}, sub = i.subscription || {};
      out.push([i.name, i.board, i.status, i.open_date, i.close_date, i.listing_date, i.issue_price, i.lot_size, i.min_lots, g.rs, S.gmpPctOf(i), sub.qib, sub.nii, sub.retail, sub.total,
        s.p_up, s.gain && s.gain.p10, s.gain && s.gain.p50, s.gain && s.gain.p90, s.allotment && s.allotment.p_min_lot, s.ev && s.ev.ev, s.verdict && s.verdict.tier, s.verdict && s.verdict.gamble, i.listing && i.listing.gain_pct].map(esc).join(','));
    }
    return out.join('\n');
  }
  function renderSettings() {
    setTimeout(syncSelects, 0);
    const sel = $('#s-schedule'), chk = $('#s-notify'), note = $('#s-note'), rem = $('#s-reminder');
    if (!sel) return;
    if (!N) { sel.disabled = true; chk.disabled = true; if (rem) rem.disabled = true; if (!note.textContent) note.textContent = 'Background refresh and notifications work in the Android app; this page shows the snapshot it was built with.'; return; }
    if (STATUS) { sel.value = String(STATUS.schedule_hours || 0); chk.checked = !!STATUS.notify; if (rem) rem.value = String(STATUS.reminder_hour === undefined || STATUS.reminder_hour === null ? -1 : STATUS.reminder_hour); if (!note.textContent) note.textContent = 'App version ' + (STATUS.version || '?') + (STATUS.downloaded_at ? ' · last download ' + fmtTime(STATUS.downloaded_at) : ''); }
  }
  function bindSettings() {
    const sel = $('#s-schedule'), chk = $('#s-notify');
    if (sel) sel.addEventListener('change', () => { if (N) { try { N.setSchedule(Number(sel.value) || 0); } catch (e) { /* ignore */ } } });
    if (chk) chk.addEventListener('change', () => { if (N) { try { N.setNotify(!!chk.checked); } catch (e) { /* ignore */ } } });
    const rem = $('#s-reminder');
    if (rem) rem.addEventListener('change', () => { if (N) { try { N.setReminderHour(Number(rem.value)); } catch (e) { /* ignore */ } } });
    const sr = $('#s-refresh'); if (sr) sr.addEventListener('click', doRefresh);
    const th = $('#s-theme'); if (th) { const cur = load('theme', 'system'); for (const o of th.querySelectorAll('button')) o.setAttribute('aria-pressed', o.dataset.v === cur ? 'true' : 'false');
      th.addEventListener('click', (ev) => { const b = ev.target.closest('button'); if (!b) return; store('theme', b.dataset.v); applyTheme(b.dataset.v); for (const o of th.querySelectorAll('button')) o.setAttribute('aria-pressed', o === b ? 'true' : 'false'); }); }
    const b0 = $('#share-shortlist-img'); if (b0) b0.addEventListener('click', shareShortlistCard);
    const b1 = $('#share-shortlist'), b2 = $('#export-csv'), b3 = $('#export-json');
    if (b1) b1.addEventListener('click', () => shareText(shortlistText(), 'IPO Radar shortlist'));
    if (b2) b2.addEventListener('click', () => shareFile('ipo-radar-' + (LIVE.generated_at || '').slice(0, 10) + '.csv', 'text/csv', csvText()));
    if (b3) b3.addEventListener('click', () => shareFile('ipo-radar-' + (LIVE.generated_at || '').slice(0, 10) + '.json', 'application/json', JSON.stringify({ generated_at: LIVE.generated_at, market: LIVE.market, ipos: SCORED.map(r => ({ ...r.eff, score: r.score })) })));
  }

  // ------------------------------------------------------------ screens ---
  const SCREENS = ['today', 'pipeline', 'planner', 'calibration', 'method', 'about'];
  function showScreen(name, opts) {
    if (!SCREENS.includes(name)) name = 'today';
    for (const id of SCREENS) { const sec = document.getElementById('screen-' + id); if (sec) sec.hidden = id !== name; }
    for (const b of document.querySelectorAll('nav.screens button')) { if (b.dataset.screen === name) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); }
    try { if (location.hash.replace('#', '') !== name) history.replaceState(null, '', '#' + name); } catch (e) { /* sandboxed */ }
    store('screen', name);
    if (!(opts && opts.keepScroll)) window.scrollTo({ top: 0 });
  }
  // ------------------------------------------------------------ share cards ---
  // Draws an IPO (or the shortlist) as a 1080x1350 PNG in the app's own typography,
  // for WhatsApp, Instagram and any other share target. Pure canvas, no libraries.
  const CARD = { w: 1080, h: 1350, pad: 64 };
  const CPAL = { bg: '#f4f6f4', surface: '#ffffff', ink: '#15191b', ink2: '#45504e', muted: '#7a8683', hair: '#e2e7e5', accent: '#0b6e6d', accentSoft: '#d8eeec', good: '#1f7a3a', goodSoft: '#dff3e4', warn: '#8a5a0b', warnSoft: '#fdf0d0', crit: '#b4292b', critSoft: '#fbe3e3', amber: '#fab219' };
  const VCOL = { apply: ['good', 'goodSoft'], lean: ['good', 'goodSoft'], coinflip: ['warn', 'warnSoft'], avoid: ['crit', 'critSoft'], watch: ['ink2', 'hair'], nodata: ['muted', 'hair'] };
  function cFont(px, weight, mono) { return (weight || 400) + ' ' + px + 'px ' + (mono ? '"Fira Code", monospace' : '"Space Grotesk", sans-serif'); }
  function roundRect(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
  function wrapText(c, text, x, y, maxW, lh, maxLines) {
    const words = String(text).split(/\s+/); let line = '', n = 0;
    for (let i = 0; i < words.length; i++) {
      const t = line ? line + ' ' + words[i] : words[i];
      if (c.measureText(t).width > maxW && line) {
        if (maxLines && n === maxLines - 1) { let cut = line; while (c.measureText(cut + '…').width > maxW && cut.length) cut = cut.slice(0, -1); c.fillText(cut + '…', x, y); return y + lh; }
        c.fillText(line, x, y); y += lh; n++; line = words[i];
      } else line = t;
    }
    if (line) { c.fillText(line, x, y); y += lh; }
    return y;
  }
  function pill(c, x, y, text, fg, bg, px) {
    c.font = cFont(px || 30, 600); const w = c.measureText(text).width + 44, h = (px || 30) * 1.7;
    c.fillStyle = bg; roundRect(c, x, y, w, h, h / 2); c.fill();
    c.fillStyle = fg; c.textBaseline = 'middle'; c.fillText(text, x + 22, y + h / 2 + 1); c.textBaseline = 'alphabetic';
    return w;
  }
  function brandImage() {
    const svg = document.querySelector('.brand .mark'); if (!svg) return Promise.resolve(null);
    return new Promise((res) => { const img = new Image(); img.onload = () => res(img); img.onerror = () => res(null); let src = svg.outerHTML; if (!/xmlns=/.test(src)) src = src.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"'); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(src); });
  }
  function cardHeader(c, logo, title) {
    c.fillStyle = CPAL.bg; c.fillRect(0, 0, CARD.w, CARD.h);
    const p = CARD.pad;
    if (logo) c.drawImage(logo, p, 56, 76, 76);
    c.fillStyle = CPAL.ink; c.font = cFont(40, 700); c.fillText('IPO Radar', p + 96, 92);
    c.fillStyle = CPAL.muted; c.font = cFont(22, 500); c.fillText(title || 'INDIA · LISTING-DAY GAINS', p + 96, 126);
    const asof = 'Data as of ' + (LIVE.generated_at ? new Date(LIVE.generated_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'unknown');
    c.textAlign = 'right'; c.fillStyle = CPAL.ink2; c.font = cFont(24, 500); c.fillText(asof, CARD.w - p, 100); c.textAlign = 'left';
  }
  function cardFooter(c) {
    const p = CARD.pad, y = CARD.h - 92;
    c.strokeStyle = CPAL.hair; c.lineWidth = 2; c.beginPath(); c.moveTo(p, y - 34); c.lineTo(CARD.w - p, y - 34); c.stroke();
    c.fillStyle = CPAL.muted; c.font = cFont(22, 400);
    wrapText(c, 'Not investment advice. Chances come from a model on past listings; the premium is unofficial. Apply only with money that can stay blocked.', p, y, CARD.w - 2 * p, 30, 2);
    c.textAlign = 'right'; c.fillStyle = CPAL.ink2; c.font = cFont(22, 600); c.fillText('IPO Radar · a Layerbit tool', CARD.w - p, CARD.h - 24); c.textAlign = 'left';
  }
  function statBox(c, x, y, w, h, label, value, sub, valueColor, mono) {
    c.fillStyle = CPAL.surface; roundRect(c, x, y, w, h, 18); c.fill(); c.strokeStyle = CPAL.hair; c.lineWidth = 2; c.stroke();
    c.fillStyle = CPAL.muted; c.font = cFont(22, 500); wrapText(c, label.toUpperCase(), x + 26, y + 44, w - 52, 26, 1);
    if (value === '–' || value === '-') { c.fillStyle = CPAL.muted; c.font = cFont(40, 400); c.fillText('not yet', x + 26, y + 106); }
    else { c.fillStyle = valueColor || CPAL.ink; c.font = cFont(58, 700, mono); c.fillText(value, x + 26, y + 112); }
    if (sub) { c.fillStyle = CPAL.ink2; c.font = cFont(23, 400); wrapText(c, sub, x + 26, y + 150, w - 52, 28, 2); }
  }
  async function drawIpoCard(r) {
    const ipo = r.eff, s = r.score, sub = ipo.subscription || {};
    const cv = document.createElement('canvas'); cv.width = CARD.w; cv.height = CARD.h; const c = cv.getContext('2d');
    try { await document.fonts.load(cFont(40, 700)); await document.fonts.load(cFont(40, 400, true)); } catch (e) { /* draw with fallbacks */ }
    const logo = await brandImage();
    cardHeader(c, logo);
    const p = CARD.pad; let y = 220;
    // name + chips
    c.fillStyle = CPAL.ink; c.font = cFont(52, 700); y = wrapText(c, ipo.name, p, y, CARD.w - 2 * p, 60, 2) + 8;
    let cx = p;
    cx += pill(c, cx, y, ipo.board === 'sme' ? 'SME' : 'Mainboard', CPAL.ink2, CPAL.hair, 26) + 14;
    const stLab = ({ open: 'Bidding open', upcoming: 'Upcoming', closed: 'Awaiting listing', listed: 'Listed' })[ipo.status] || ipo.status;
    cx += pill(c, cx, y, stLab, ipo.status === 'open' ? CPAL.accent : CPAL.ink2, ipo.status === 'open' ? CPAL.accentSoft : CPAL.hair, 26) + 14;
    y += 70;
    const dl = [];
    if (ipo.open_date || ipo.close_date) dl.push('Bids ' + dshort(ipo.open_date) + ' to ' + dshort(ipo.close_date));
    if (ipo.listing_date) dl.push('lists ' + dshort(ipo.listing_date));
    if (ipo.issue_price && ipo.lot_size) dl.push('₹' + ipo.issue_price + ' × ' + ipo.lot_size + ' = ' + inr(s && s.ev && s.ev.invested_if_allotted ? s.ev.invested_if_allotted : ipo.issue_price * ipo.lot_size) + (s && s.ev && s.ev.min_lots > 1 ? ' (' + s.ev.min_lots + ' lots minimum)' : ' a lot'));
    c.fillStyle = CPAL.ink2; c.font = cFont(26, 400); y = wrapText(c, dl.join('  ·  '), p, y, CARD.w - 2 * p, 34, 2) + 10;
    // verdict band
    if (s && ipo.status !== 'listed') {
      const [fg, bg] = VCOL[s.verdict.tier] || VCOL.nodata;
      c.fillStyle = CPAL[bg]; roundRect(c, p, y, CARD.w - 2 * p, 112, 20); c.fill();
      c.fillStyle = CPAL[fg]; c.beginPath(); c.arc(p + 44, y + 56, 14, 0, Math.PI * 2); c.fill();
      c.font = cFont(46, 700); c.fillText(s.verdict.label, p + 78, y + 72);
      if (s.verdict.gamble) { c.textAlign = 'right'; c.font = cFont(30, 600); c.fillText(s.verdict.gamble === 'sure' ? 'Sure gamble' : 'Possible gamble', CARD.w - p - 30, y + 68); c.textAlign = 'left'; }
      y += 136;
    } else if (ipo.status === 'listed' && ipo.listing && ipo.listing.gain_pct !== null && ipo.listing.gain_pct !== undefined) {
      const up = ipo.listing.gain_pct > 0;
      c.fillStyle = up ? CPAL.goodSoft : CPAL.critSoft; roundRect(c, p, y, CARD.w - 2 * p, 112, 20); c.fill();
      c.fillStyle = up ? CPAL.good : CPAL.crit; c.font = cFont(46, 700); c.fillText('Listed ' + pct(ipo.listing.gain_pct, 1), p + 30, y + 72);
      y += 136;
    }
    // four stats
    const g = s && s.flags.includes('gmp_unquoted') ? null : S.gmpPctOf(ipo);
    const bw = (CARD.w - 2 * p - 24) / 2, bh = 196;
    const pUp = s && s.p_up !== null && s.p_up !== undefined ? s.p_up : null;
    statBox(c, p, y, bw, bh, 'Chance of a listing gain', pUp === null ? '–' : pct0(pUp), pUp === null ? 'not enough data yet' : oddsText(pUp), pUp === null ? CPAL.muted : pUp >= 0.7 ? CPAL.good : pUp >= 0.5 ? CPAL.warn : CPAL.crit, true);
    statBox(c, p + bw + 24, y, bw, bh, 'Unofficial premium (GMP)', g === null ? (s && s.flags.includes('gmp_unquoted') ? 'none' : '–') : pct(g, 1), g === null ? 'no grey-market quote' : (ipo.gmp && ipo.gmp.rs !== null && ipo.gmp.rs !== undefined ? '₹' + ipo.gmp.rs + ' a share' + (ipo.gmp.as_of ? ' · ' + dshort(ipo.gmp.as_of) : '') : ''), g === null ? CPAL.muted : g > 0 ? CPAL.good : CPAL.crit, true);
    y += bh + 24;
    const al = s && s.allotment && s.allotment.p_min_lot !== null && s.allotment.p_min_lot !== undefined ? s.allotment.p_min_lot : null;
    statBox(c, p, y, bw, bh, 'Chance of getting shares', al === null ? '–' : al >= 0.999 ? 'Full' : '1 in ' + (1 / al).toFixed(1 / al >= 10 ? 0 : 1), al === null ? (ipo.status === 'upcoming' ? 'known once bidding starts' : 'no demand figures') : al >= 0.999 ? 'everyone who applies gets shares' : 'retail bid ' + x(sub.retail) + ' the shares on offer', CPAL.ink, true);
    const ev = s && s.ev && s.ev.ev !== null && s.ev.ev !== undefined && ipo.status !== 'listed' ? s.ev.ev : null;
    const invC = s && s.ev && s.ev.invested_if_allotted ? s.ev.invested_if_allotted : (ipo.issue_price && ipo.lot_size ? ipo.issue_price * ipo.lot_size : null);
    if (ipo.status === 'listed' && ipo.listing && ipo.listing.gain_pct !== null && ipo.listing.gain_pct !== undefined && invC) {
      const gl = invC * ipo.listing.gain_pct / 100;
      statBox(c, p + bw + 24, y, bw, bh, 'Gain on one lot, listing day', inr(gl, { plus: true }), 'before charges and tax, on ' + inr(invC) + ' invested', gl > 0 ? CPAL.good : CPAL.crit, true);
    } else if (ev !== null) {
      statBox(c, p + bw + 24, y, bw, bh, 'Worth per application', inr(ev, { plus: true }), 'on average, after charges and tax' + (s.ev.ev_if_allotted !== null && s.ev.ev_if_allotted !== undefined ? '; ' + inr(s.ev.ev_if_allotted, { plus: true }) + ' if you get shares' : ''), ev > 0 ? CPAL.good : CPAL.crit, true);
    } else if (s && s.gain && invC && ipo.status !== 'listed') {
      const res = S.netProfitOnSale(invC, invC * (1 + s.gain.mean / 100), state.costs);
      statBox(c, p + bw + 24, y, bw, bh, 'Profit if you get shares', inr(res.net, { plus: true }), 'after charges and tax; odds of shares unknown until bidding', res.net > 0 ? CPAL.good : CPAL.crit, true);
    } else statBox(c, p + bw + 24, y, bw, bh, 'Worth per application', '–', 'needs a price, a lot size and a read', CPAL.muted, true);
    y += bh + 28;
    // demand + likely gain
    const hasSub = ['qib', 'nii', 'retail'].some(k => sub[k] !== null && sub[k] !== undefined);
    const half = (CARD.w - 2 * p - 24) / 2;
    c.fillStyle = CPAL.muted; c.font = cFont(22, 500); c.fillText('DEMAND, TIMES SUBSCRIBED', p, y); c.fillText('LIKELY GAIN, WORST TO BEST', p + half + 24, y);
    let yy = y + 26;
    if (hasSub) {
      const max = Math.max(1, ...['qib', 'nii', 'retail'].map(k => Number(sub[k]) || 0));
      const scale = v => Math.min(1, Math.log1p(v) / Math.log1p(Math.max(max, 10)));
      for (const [k, lab] of [['qib', 'Institutions'], ['nii', 'Wealthy'], ['retail', 'Retail']]) {
        const v = sub[k] === null || sub[k] === undefined ? null : Number(sub[k]);
        c.fillStyle = CPAL.ink2; c.font = cFont(24, 400); c.fillText(lab, p, yy + 22);
        c.fillStyle = CPAL.hair; roundRect(c, p + 150, yy + 6, half - 150 - 96, 18, 9); c.fill();
        if (v !== null) { c.fillStyle = '#3987e5'; roundRect(c, p + 150, yy + 6, Math.max(6, (half - 150 - 96) * scale(v)), 18, 9); c.fill(); }
        c.fillStyle = CPAL.ink; c.font = cFont(24, 500, true); c.textAlign = 'right'; c.fillText(x(v), p + half, yy + 22); c.textAlign = 'left';
        yy += 40;
      }
      c.fillStyle = CPAL.muted; c.font = cFont(22, 400); c.fillText('overall ' + x(sub.total) + (ipo.status === 'closed' || ipo.status === 'listed' ? ', final' : ', so far'), p, yy + 18);
    } else { c.fillStyle = CPAL.muted; c.font = cFont(24, 400); c.fillText(ipo.status === 'upcoming' ? 'Bidding has not opened yet' : 'No demand figures captured', p, yy + 22); }
    const gx = p + half + 24;
    if (s && s.gain && ipo.status !== 'listed') {
      const lo = -30, hi = 90, tw = half, cxv = v => gx + Math.max(0, Math.min(1, (v - lo) / (hi - lo))) * tw;
      c.fillStyle = CPAL.hair; roundRect(c, gx, yy + 20, tw, 16, 8); c.fill();
      c.fillStyle = CPAL.accentSoft; roundRect(c, cxv(s.gain.p10), yy + 14, Math.max(8, cxv(s.gain.p90) - cxv(s.gain.p10)), 28, 8); c.fill();
      c.fillStyle = CPAL.accent; c.fillRect(cxv(s.gain.p50) - 3, yy + 8, 6, 40);
      c.strokeStyle = CPAL.muted; c.lineWidth = 2; c.beginPath(); c.moveTo(cxv(0), yy + 4); c.lineTo(cxv(0), yy + 52); c.stroke();
      c.fillStyle = CPAL.ink2; c.font = cFont(24, 500, true); c.fillText(pct(s.gain.p10, 0), gx, yy + 86); c.textAlign = 'right'; c.fillText(pct(s.gain.p90, 0), gx + tw, yy + 86); c.textAlign = 'center'; c.fillStyle = CPAL.ink; c.font = cFont(26, 700, true); c.fillText(pct(s.gain.p50, 0) + ' middle', (gx + gx + tw) / 2, yy + 86); c.textAlign = 'left';
    } else if (ipo.status === 'listed' && ipo.listing) {
      c.fillStyle = CPAL.ink; c.font = cFont(28, 600, true); c.fillText('open ' + (ipo.listing.open ? '₹' + ipo.listing.open : '–') + '  ·  close ' + (ipo.listing.close ? '₹' + ipo.listing.close : '–'), gx, yy + 26);
      if (s && s.gain) { c.fillStyle = CPAL.ink2; c.font = cFont(23, 400); c.fillText('model range was ' + pct(s.gain.p10, 0) + ' to ' + pct(s.gain.p90, 0), gx, yy + 64); }
    } else { c.fillStyle = CPAL.muted; c.font = cFont(24, 400); c.fillText('no read yet', gx, yy + 22); }
    y = yy + 150;
    // why: up to two warnings, then reasons
    if (s) {
      const lines = s.verdict.warnings.slice(0, 2).map(w => ['⚠', w]).concat(s.verdict.reasons.slice(0, 3 - Math.min(2, s.verdict.warnings.length)).map(w => ['•', w]));
      c.font = cFont(25, 400);
      for (const [m, t] of lines) { if (y > CARD.h - 150) break; c.fillStyle = m === '⚠' ? CPAL.crit : CPAL.ink2; c.fillText(m, p, y); y = wrapText(c, t, p + 36, y, CARD.w - 2 * p - 36, 32, 2) + 6; }
    }
    cardFooter(c);
    return cv;
  }
  async function drawShortlistCard() {
    const rows = SCORED.filter(r => r.score && ['open', 'upcoming'].includes(r.ipo.status) && r.score.p_up !== null)
      .sort((a, b) => (ORDER[a.score.verdict.tier] - ORDER[b.score.verdict.tier]) || (b.score.p_up - a.score.p_up)).slice(0, 7);
    const cv = document.createElement('canvas'); cv.width = CARD.w; cv.height = CARD.h; const c = cv.getContext('2d');
    try { await document.fonts.load(cFont(40, 700)); await document.fonts.load(cFont(40, 400, true)); } catch (e) { /* fallbacks */ }
    const logo = await brandImage();
    cardHeader(c, logo, 'TODAY’S SHORTLIST');
    const p = CARD.pad; let y = 206;
    c.fillStyle = CPAL.ink; c.font = cFont(48, 700); c.fillText('Open and upcoming IPOs, best first', p, y); y += 24;
    c.fillStyle = CPAL.ink2; c.font = cFont(25, 400); y = wrapText(c, 'Chance = how many of ten IPOs like it ended listing day above the issue price. Worth = average profit per application after charges and tax, counting the odds of getting no shares.', p, y + 26, CARD.w - 2 * p, 32, 3) + 14;
    if (!rows.length) { c.fillStyle = CPAL.muted; c.font = cFont(30, 400); c.fillText('Nothing open or upcoming has a usable read right now.', p, y + 40); }
    const rh = 118;
    for (const r of rows) {
      const s = r.score, ipo = r.eff;
      c.fillStyle = CPAL.surface; roundRect(c, p, y, CARD.w - 2 * p, rh - 14, 18); c.fill(); c.strokeStyle = CPAL.hair; c.lineWidth = 2; c.stroke();
      c.fillStyle = CPAL.ink; c.font = cFont(30, 700); wrapText(c, ipo.name + (ipo.board === 'sme' ? '  (SME)' : ''), p + 26, y + 42, 560, 34, 1);
      c.fillStyle = CPAL.ink2; c.font = cFont(23, 400); c.fillText((ipo.status === 'open' ? 'Bids close ' + dshort(ipo.close_date) : 'Opens ' + dshort(ipo.open_date)) + '  ·  chance ' + pct0(s.p_up) + (s.ev.ev !== null && s.ev.ev !== undefined ? '  ·  worth ' + inr(s.ev.ev, { plus: true }) : ''), p + 26, y + 80);
      const [fg, bg] = VCOL[s.verdict.tier] || VCOL.nodata;
      c.font = cFont(26, 600); const pw = c.measureText(s.verdict.label).width + 44;
      pill(c, CARD.w - p - pw - 24, y + 22, s.verdict.label, CPAL[fg], CPAL[bg], 26);
      if (s.verdict.gamble) { c.textAlign = 'right'; c.fillStyle = s.verdict.gamble === 'sure' ? CPAL.crit : CPAL.warn; c.font = cFont(21, 600); c.fillText(s.verdict.gamble === 'sure' ? 'sure gamble' : 'possible gamble', CARD.w - p - 24, y + 92); c.textAlign = 'left'; }
      y += rh; if (y > CARD.h - 220) break;
    }
    cardFooter(c);
    return cv;
  }
  function canvasPng(cv) { return cv.toDataURL('image/png'); }
  function shareImage(name, dataUrl, caption) {
    if (N && typeof N.shareImage === 'function') { try { N.shareImage(name, dataUrl, caption); return; } catch (e) { /* fall through */ } }
    try {
      const bin = atob(dataUrl.split(',')[1]); const arr = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const f = new File([arr], name, { type: 'image/png' });
      if (navigator.share && navigator.canShare && navigator.canShare({ files: [f] })) { navigator.share({ files: [f], title: name, text: caption }).catch(() => {}); return; }
      const a = document.createElement('a'); a.href = dataUrl; a.download = name; a.target = '_blank'; a.rel = 'noopener'; document.body.append(a); a.click(); a.remove();
    } catch (e) { shareText(caption, name); }
  }
  // The card is shown before it is sent: the person sees exactly what goes out,
  // and on a platform with no share sheet (a browser preview) they still get the picture.
  let CARD_CUR = null;
  function openCardSheet(title, drawFn, name, caption) {
    const sheet = $('#cardsheet'), pv = $('#card-preview'); if (!sheet) return;
    $('#card-title').textContent = title;
    pv.replaceChildren(el('div', { class: 'wait' }, el('span', { class: 'spin' }), 'Drawing the card…'));
    CARD_CUR = null; sheet.hidden = false;
    const close = () => { sheet.hidden = true; CARD_CUR = null; };
    $('#card-close').onclick = close; sheet.onclick = (ev) => { if (ev.target === sheet) close(); };
    $('#card-share').onclick = () => { if (CARD_CUR) shareImage(CARD_CUR.name, CARD_CUR.data, CARD_CUR.caption); };
    $('#card-save').onclick = () => { if (!CARD_CUR) return; const a = document.createElement('a'); a.href = CARD_CUR.data; a.download = CARD_CUR.name; a.target = '_blank'; a.rel = 'noopener'; document.body.append(a); a.click(); a.remove(); };
    Promise.resolve().then(drawFn).then((cv) => {
      const data = canvasPng(cv); CARD_CUR = { name, data, caption };
      const img = new Image(); img.alt = title + ' as a shareable card'; img.src = data; pv.replaceChildren(img);
    }).catch(() => { pv.replaceChildren(el('div', { class: 'wait', text: 'Could not draw the card on this device. Share as text instead.' })); });
  }
  function shareIpoCard(r) {
    openCardSheet(r.eff.name, () => drawIpoCard(r), r.eff.name.replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) + '-ipo-radar.png', readText(r));
  }
  function shareShortlistCard() {
    openCardSheet('Today’s shortlist', drawShortlistCard, 'ipo-radar-shortlist-' + (LIVE.generated_at || '').slice(0, 10) + '.png', shortlistText());
  }
  function cardButton(r) {
    return el('button', { class: 'star share', type: 'button', id: 'shc-' + r.ipo.id, 'aria-label': 'Share ' + r.eff.name + ' as an image card', onclick: (ev) => { ev.stopPropagation(); shareIpoCard(r); } },
      svgEl('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, svgEl('path', { d: 'M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M12 15V3M7 8l5-5 5 5' })), ' Share card');
  }
  // ------------------------------------------------------------ dropdowns ---
  // The native <select> keeps the value and fires 'change' as before; what the
  // user sees and taps is a button plus an in-app sheet in the app's own font.
  const PICK_TITLES = { 'f-sort': 'Sort the pipeline', 'p-broker': 'Your broker', 's-schedule': 'Background refresh', 's-reminder': 'Watchlist reminder time' };
  function enhanceSelects() {
    for (const sel of document.querySelectorAll('select:not(.enhanced)')) {
      sel.classList.add('enhanced'); sel.setAttribute('aria-hidden', 'true'); sel.tabIndex = -1;
      const btn = el('button', { type: 'button', class: 'pick-btn', id: 'pb-' + sel.id, 'aria-haspopup': 'listbox', 'aria-label': PICK_TITLES[sel.id] || 'Choose' },
        el('span', { class: 'v' }), svgEl('svg', { class: 'chev', viewBox: '0 0 24 24', 'aria-hidden': 'true' }, svgEl('path', { d: 'M6 9l6 6 6-6' })));
      sel.insertAdjacentElement('afterend', btn);
      const sync = () => { const o = sel.options[sel.selectedIndex]; btn.querySelector('.v').textContent = o ? o.textContent : ''; };
      sync(); sel.addEventListener('change', sync); sel._syncPick = sync;
      btn.addEventListener('click', () => openPicker(sel, btn));
    }
  }
  function syncSelects() { for (const sel of document.querySelectorAll('select.enhanced')) if (sel._syncPick) sel._syncPick(); }
  function openPicker(sel, btn) {
    const sheet = $('#picker'), host = $('#picker-opts'); host.replaceChildren();
    $('#picker-title').textContent = PICK_TITLES[sel.id] || 'Choose';
    const close = () => { sheet.hidden = true; btn.focus({ preventScroll: true }); };
    for (const o of sel.options) {
      const row = el('button', { type: 'button', class: 'opt-row', role: 'option', 'aria-selected': o.selected ? 'true' : 'false' }, el('span', { text: o.textContent }), svgEl('svg', { class: 'tick', viewBox: '0 0 24 24', 'aria-hidden': 'true' }, svgEl('path', { d: 'M5 12l5 5 9-10' })));
      row.addEventListener('click', () => { if (sel.value !== o.value) { sel.value = o.value; sel.dispatchEvent(new Event('change', { bubbles: true })); } close(); });
      host.append(row);
    }
    sheet.hidden = false;
    const selRow = host.querySelector('[aria-selected="true"]'); (selRow || host.firstChild).focus({ preventScroll: true });
    sheet.onclick = (ev) => { if (ev.target === sheet) close(); };
    $('#picker-close').onclick = close;
  }
  function bindExplain() {
    const sheet = $('#explain'); if (!sheet) return;
    const close = () => { sheet.hidden = true; };
    if (!window.__ipoExplainBound) { window.__ipoExplainBound = true; document.addEventListener('click', (ev) => { const t = ev.target.closest('[data-term]'); if (!t) return; ev.preventDefault(); ev.stopPropagation(); openExplain(t.dataset.term); }, true); }
    $('#explain-close').addEventListener('click', close);
    sheet.addEventListener('click', (ev) => { if (ev.target === sheet) close(); });
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !sheet.hidden) close(); if (ev.key === 'Escape') { for (const id of ['#picker', '#cardsheet']) { const pk = $(id); if (pk && !pk.hidden) pk.hidden = true; } } });
    $('#explain-all').addEventListener('click', () => { close(); showScreen('about'); const g = $('#glossary'); if (g) g.scrollIntoView({ block: 'start' }); });
    // glossary on the More screen, from the same text
    const g = $('#glossary-body'); if (g) { g.replaceChildren(); for (const k of TERM_ORDER) { const t = TERMS[k]; g.append(el('details', { class: 'gl' }, el('summary', { text: t.t }), ...t.d.map(line => el('p', { text: line })))); } }
    // first-open guide on Today
    const intro = $('#intro'); if (intro) { intro.hidden = !!load('intro_seen', false); const ok = $('#intro-ok'); if (ok) ok.addEventListener('click', () => { store('intro_seen', true); intro.hidden = true; }); }
  }
  function bindContact() {
    for (const b of document.querySelectorAll('[data-goto]')) b.addEventListener('click', () => showScreen(b.dataset.goto));
    const sheet = $('#help');
    const open = () => { sheet.hidden = false; const c = $('#help-close'); if (c) c.focus(); };
    const close = () => { sheet.hidden = true; };
    for (const b of document.querySelectorAll('[data-help]')) b.addEventListener('click', open);
    const cl = $('#help-close'); if (cl) cl.addEventListener('click', close);
    sheet.addEventListener('click', (ev) => { if (ev.target === sheet) close(); });
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !sheet.hidden) close(); });
    // on Android hand mailto/WhatsApp to the system (mail app / WhatsApp) through the bridge
    for (const id of ['help-mail', 'help-wa']) { const a = document.getElementById(id); if (a && N) a.addEventListener('click', (ev) => { ev.preventDefault(); try { N.openExternal(a.href); } catch (e) { /* ignore */ } close(); }); }
  }
  function bindScreens() {
    document.querySelector('nav.screens').addEventListener('click', (ev) => { const b = ev.target.closest('button'); if (b) showScreen(b.dataset.screen); });
    window.addEventListener('hashchange', () => { const h = location.hash.replace('#', ''); if (SCREENS.includes(h)) showScreen(h, { keepScroll: true }); });
  }
  function renderToday() {
    const host = $('#picks'); host.replaceChildren();
    const rows = SCORED.filter(r => r.score && ['open', 'upcoming'].includes(r.ipo.status) && r.score.p_up !== null)
      .sort((a, b) => (ORDER[a.score.verdict.tier] - ORDER[b.score.verdict.tier]) || (b.score.p_up - a.score.p_up)).slice(0, 6);
    if (!rows.length) { host.append(el('p', { class: 'muted', text: 'Nothing open or upcoming has a usable read right now.' })); return; }
    for (const r of rows) {
      const s = r.score, ipo = r.eff;
      const card = el('button', { class: 'pick', type: 'button', id: 'pick-' + ipo.id, style: '--i:' + host.children.length, onclick: () => { state.open = ipo.id; renderTable(); showScreen('pipeline'); const t = document.getElementById('row-' + ipo.id); if (t) t.scrollIntoView({ block: 'center' }); } });
      card.append(el('div', { class: 'n' }, ipo.name, ' ', el('span', { class: 'chip', text: ipo.board === 'sme' ? 'SME' : 'Mainboard' })));
      card.append(ringEl(s.p_up, 64));
      card.append(el('div', null, el('span', { class: 'verdict ' + s.verdict.tier, 'data-term': 'verdicts', text: s.verdict.label }), s.verdict.gamble ? el('span', { class: 'gamble ' + s.verdict.gamble, 'data-term': 'gamble', style: 'display:inline;margin-left:8px', text: s.verdict.gamble === 'sure' ? 'sure gamble' : 'possible gamble' }) : null));
      const m = el('div', { class: 'm' });
      m.append(el('span', null, 'Chance of a gain ', el('b', { class: 'num', text: pct0(s.p_up) }), el('span', { class: 'muted', text: ' (' + oddsText(s.p_up).replace(' such IPOs list up', '') + ')' })));
      if (s.gain) m.append(el('span', null, 'Middle-case gain ', el('b', { class: 'num', text: pct(s.gain.p50, 0) })));
      if (s.ev.ev !== null && s.ev.ev !== undefined) m.append(el('span', null, 'Worth per application ', el('b', { class: 'num', text: inr(s.ev.ev, { plus: true }) })));
      m.append(el('span', null, ipo.status === 'open' ? 'Bids close ' + dshort(ipo.close_date) : 'Opens ' + dshort(ipo.open_date)));
      m.append(el('span', { class: WATCH.has(ipo.id) ? 'warn' : 'muted', text: WATCH.has(ipo.id) ? '★ watching' : '' }));
      card.append(m);
      host.append(card);
    }
    host.append(el('div', { class: 'pick share-pick' }, el('button', { class: 'btn primary', type: 'button', id: 'pick-share', onclick: shareShortlistCard }, 'Share shortlist as an image'), el('button', { class: 'btn', type: 'button', id: 'pick-share-text', onclick: () => shareText(shortlistText(), 'IPO Radar shortlist') }, 'Share as text')));
  }

  // ------------------------------------------------------------- wiring ---
  function renderAll() { renderHead(); renderTiles(); renderToday(); renderWatchlist(); renderTable(); renderPlanner(); }
  // Wraps a horizontally scrolling element with a fade + chevron cue that
  // shows while there is more content to the right and hides at the end.
  function scrollCue(strip, extraStyle) {
    const wrap = el('div', { class: 'hwrap' });
    if (extraStyle) strip.style.cssText += ';' + extraStyle;
    const more = el('button', { type: 'button', class: 'chips-more', 'aria-label': 'Scroll right for more' }, el('span', { class: 'arr', text: '\u203a' }));
    wrap.append(strip, more);
    const cue = () => {
      const max = strip.scrollWidth - strip.clientWidth;
      wrap.classList.toggle('no-scroll', max <= 4);
      wrap.classList.toggle('at-end', strip.scrollLeft >= max - 4);
      wrap.classList.toggle('at-start', strip.scrollLeft <= 4);
    };
    strip.addEventListener('scroll', cue, { passive: true });
    window.addEventListener('resize', cue);
    more.addEventListener('click', () => strip.scrollBy({ left: Math.max(120, strip.clientWidth * 0.6), behavior: 'smooth' }));
    if (window.ResizeObserver) new ResizeObserver(cue).observe(strip); else { requestAnimationFrame(cue); setTimeout(cue, 300); }
    requestAnimationFrame(cue);
    return wrap;
  }
  function hscroll(table, extraStyle) { return scrollCue(el('div', { class: 'hscroll' }, table), extraStyle); }
  function bindFilters() {
    for (const [id, key] of [['#f-board', 'board'], ['#f-status', 'status']]) {
      $(id).addEventListener('click', (ev) => { const b = ev.target.closest('button'); if (!b) return; state[key] = b.dataset.v; for (const o of $(id).querySelectorAll('button')) o.setAttribute('aria-pressed', o === b ? 'true' : 'false'); if (b.classList.contains('stile') && b.scrollIntoView) b.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' }); renderTable(); });
    }
    $('#f-nodata').addEventListener('change', () => { state.hideNodata = $('#f-nodata').checked; renderTable(); });
    // "more to the right" cue on the status row
    const host = $('#f-status-wrap'), strip = $('#f-status'); const old = $('#f-status-more'); if (old) old.remove();
    host.replaceChildren(scrollCue(strip));
    $('#f-sort').addEventListener('change', () => { state.sort = $('#f-sort').value; renderTable(); });
  }
  function start() {
    computeAll();
    bindFilters(); bindPlanner(); bindScreens(); bindContact(); bindSettings(); bindExplain(); enhanceSelects();
    const pk = $('#picks'); if (pk && !pk.parentNode.classList.contains('hwrap')) { const par = pk.parentNode, nx = pk.nextSibling; par.insertBefore(scrollCue(pk), nx); }
    renderAll(); renderStatus(); renderSettings();
    $('#cal-lede').textContent = !PARAMS ? 'No model report in this snapshot.'
      : PARAMS.status === 'calibrated' ? 'This is the model’s report card. It was fitted on ' + PARAMS.n_rows + ' IPOs listed between ' + dlong(PARAMS.date_range[0]) + ' and ' + dlong(PARAMS.date_range[1]) + ', and every figure below was measured on IPOs it had not seen while learning.'
      : 'This is where the model’s report card will appear. Right now it runs on documented starting weights (premium first, then institutional demand, then the rest) because the history holds only ' + (PARAMS.n_rows_gating || 0) + ' past listings with full figures; ' + (PARAMS.min_rows_to_calibrate || 120) + ' are needed. The table of past listings below needs no model and is already worth reading.';
    chartGmp(); chartRel(); bucketTable(); coefTable(); methodText();
    const h = (location.hash || '').replace('#', '');
    showScreen(SCREENS.includes(h) ? h : (load('screen', 'today') || 'today'), { keepScroll: true });
  }
  start();
  }
  let booted = false;
  window.ipoRadarLoad = function (payload) {
    if (!payload || !payload.live) return;
    try { boot(payload); } catch (e) { console.error('ipoRadarLoad failed', e); }
  };
  boot(INLINE); booted = true;
})();
