/* IPO Radar page logic.
 * Reads the inlined data (or fresher data handed in by the Android shell through
 * window.ipoRadarLoad), scores every IPO with score.js (the same model the refresh
 * job runs) and renders five screens: Today, IPOs (+ a detail page per IPO),
 * Planner, Track record and More. No framework, no external calls.
 *
 * UI state (screen, filters, open IPO, scroll) lives OUTSIDE the data, so a
 * refresh swaps the numbers without throwing the person back to the start. */
(function () {
  'use strict';
  const setVh = () => { if (window.innerHeight) document.documentElement.style.setProperty('--vh', (window.innerHeight / 100) + 'px'); };
  setVh(); window.addEventListener('resize', setVh);
  const S = window.IpoScore;
  const N = (typeof window.IpoNative === 'object' && window.IpoNative) ? window.IpoNative : null;
  const has = (fn) => !!(N && typeof N[fn] === 'function');
  const call = (fn, ...a) => { if (!has(fn)) return undefined; try { return N[fn](...a); } catch (e) { return undefined; } };

  // ------------------------------------------------------------ storage ---
  function store(k, v) { try { localStorage.setItem('ipo-radar:' + k, JSON.stringify(v)); } catch (e) { /* private mode */ } }
  function load(k, d) { try { const v = localStorage.getItem('ipo-radar:' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } }

  // ------------------------------------------------------------ helpers ---
  const $ = (sel, root) => (root || document).querySelector(sel);
  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      const v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return n;
  }
  function svgEl(tag, attrs, ...kids) {
    const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
    if (attrs) for (const k in attrs) if (attrs[k] !== null && attrs[k] !== undefined) n.setAttribute(k, attrs[k]);
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined) n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return n;
  }
  const ICONS = {
    sun: 'M12 3v2M12 19v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M3 12h2M19 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
    list: 'M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01',
    calc: 'M6 3h12a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM8 7h8M8 12h.01M12 12h.01M16 12h.01M8 16h.01M12 16h.01M16 16h.01',
    shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3zM8.5 12l2.5 2.5 4.5-5',
    menu: 'M4 6h16M4 12h16M4 18h16',
    clock: 'M12 7v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
    bell: 'M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8M10 20a2 2 0 0 0 4 0',
    star: 'M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z',
    share: 'M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M12 15V3M7 8l5-5 5 5',
    check: 'M5 12l5 5 9-10', x: 'M6 6l12 12M18 6L6 18', minus: 'M6 12h12',
    alert: 'M12 9v4M12 17h.01M10.3 3.9L2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
    info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v6M12 7.5h.01',
    chev: 'M9 6l6 6-6 6', search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
    rupee: 'M6 4h12M6 9h12M9 4c6 0 6 10 0 10H6l9 7',
    flag: 'M5 21V4M5 4h11l-2 4 2 4H5',
    book: 'M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2zM4 19a2 2 0 0 1 2-2h13',
    help: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17h.01',
    gear: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
    download: 'M12 3v12M7 10l5 5 5-5M5 21h14', mail: 'M3 6h18v12H3zM3 7l9 6 9-6', chat: 'M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-6.4A8 8 0 1 1 21 12z',
    coffee: 'M4 9h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5zM17 10h1.5a2.5 2.5 0 0 1 0 5H17M8 3v3M12 3v3',
    lock: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4', globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18',
    text: 'M4 7V5h16v2M9 19h6M12 5v14', moon: 'M21 13A9 9 0 1 1 11 3a7 7 0 0 0 10 10z', db: 'M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
    wallet: 'M3 7h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 7l12-4v4M17 13h.01',
    plus: 'M12 5v14M5 12h14', trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
    up: 'M7 14l5-5 5 5', ext: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  };
  function icon(name, cls) { return svgEl('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true', class: cls || null }, svgEl('path', { d: ICONS[name] || ICONS.info })); }

  // ------------------------------------------------------------- prefs ---
  const PREF = { theme: load('theme', 'system'), lang: load('lang', 'en'), scale: Number(load('scale', 1)) || 1 };
  const WATCH = new Set((() => { const s = nativeStatus(); if (s && Array.isArray(s.watchlist) && s.watchlist.length) return s.watchlist; return load('watch', []); })());
  let JOURNAL = load('journal', []); if (!Array.isArray(JOURNAL)) JOURNAL = [];
  const PLAN = Object.assign({ capital: 200000, accounts: 1, target: 25000, broker: 'zerodha', picked: null, snapshot: null }, load('plan', {}));
  for (const k of ['capital', 'accounts', 'target']) if (!Number.isFinite(Number(PLAN[k]))) PLAN[k] = { capital: 200000, accounts: 1, target: 25000 }[k];
  PLAN.accounts = Math.min(10, Math.max(1, Math.round(Number(PLAN.accounts) || 1)));
  const ALERT_KEYS = ['opening', 'closing', 'allotment', 'listing', 'verdict'];
  let ALERTS = Object.assign({ opening: true, closing: true, allotment: true, listing: true, verdict: true }, load('alerts', {}));
  // UI state: survives data reloads (the refresh bug was that a reload reset the filters but not the buttons)
  const UI = { tab: 'home', ipo: null, status: 'active', board: 'all', q: '', sort: 'smart', ledger: 'locked', edits: {}, scroll: {} };
  function nativeStatus() { if (!has('status')) return null; try { return JSON.parse(N.status()); } catch (e) { return null; } }
  let STATUS = nativeStatus();
  if (STATUS && STATUS.alerts && typeof STATUS.alerts === 'object') ALERTS = Object.assign(ALERTS, STATUS.alerts);

  // --------------------------------------------------------------- i18n ---
  // English text is the key; HI (at the bottom of this file) maps it to Hindi.
  // Anything without a translation shows in English rather than breaking.
  function t(s, vars) {
    let r = (PREF.lang === 'hi' && HI[s]) || s;
    if (vars) for (const k in vars) r = r.split('{' + k + '}').join(vars[k]);
    return r;
  }
  function applyPrefs() {
    const r = document.documentElement;
    if (PREF.theme === 'light' || PREF.theme === 'dark') r.setAttribute('data-theme', PREF.theme); else r.removeAttribute('data-theme');
    r.style.setProperty('--scale', String(PREF.scale));
    r.setAttribute('lang', PREF.lang === 'hi' ? 'hi' : 'en');
    call('setTheme', PREF.theme);
  }

  // ---------------------------------------------------------- formatting ---
  function inr(n, opts) {
    if (n === null || n === undefined || !isFinite(n)) return '–';
    const sign = n < 0 ? '−' : (opts && opts.plus && n > 0 ? '+' : '');
    let s = String(Math.round(Math.abs(n)));
    if (s.length > 3) { const last3 = s.slice(-3); s = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3; }
    return sign + (sign ? '⁠' : '') + '₹' + s;   // word joiner: never wrap between the sign and ₹
  }
  function inrShort(n) {
    if (n === null || n === undefined || !isFinite(n)) return '–';
    const a = Math.abs(n), sign = n < 0 ? '−⁠' : '';
    if (a >= 1e7) return sign + '₹' + (a / 1e7).toFixed(a >= 1e9 ? 0 : 1).replace(/\.0$/, '') + ' ' + t('cr');
    if (a >= 1e5) return sign + '₹' + (a / 1e5).toFixed(a >= 1e6 ? 0 : 1).replace(/\.0$/, '') + ' ' + t('lakh');
    return inr(n);
  }
  const fin = (v) => v !== null && v !== undefined && v !== '' && isFinite(Number(v));
  const pct = (v, d) => !fin(v) ? '–' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(d === undefined ? 1 : d) + '%';
  const pct0 = (p) => !fin(p) ? '–' : Math.round(p * 100) + '%';
  const xm = (v) => !fin(v) ? '–' : (v >= 100 ? Number(v).toFixed(0) : v >= 10 ? Number(v).toFixed(1) : Number(v).toFixed(2)) + 'x';
  const MON = { en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], hi: ['जन', 'फ़र', 'मार्च', 'अप्रै', 'मई', 'जून', 'जुला', 'अग', 'सित', 'अक्टू', 'नव', 'दिस'] };
  const DOW = { en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], hi: ['रवि', 'सोम', 'मंगल', 'बुध', 'गुरु', 'शुक्र', 'शनि'] };
  const DOWL = { en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'], hi: ['रविवार', 'सोमवार', 'मंगलवार', 'बुधवार', 'गुरुवार', 'शुक्रवार', 'शनिवार'] };
  const isIso = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s);
  const utc = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
  const L = () => (PREF.lang === 'hi' ? 'hi' : 'en');
  function dshort(iso) { return isIso(iso) ? +iso.slice(8, 10) + ' ' + MON[L()][+iso.slice(5, 7) - 1] : '–'; }
  function dday(iso) { return isIso(iso) ? DOW[L()][new Date(utc(iso)).getUTCDay()] + ' ' + dshort(iso) : '–'; }
  function dlong(iso) { return isIso(iso) ? dshort(iso) + ' ' + iso.slice(0, 4) : '–'; }
  // "today" is the real date in India, not the snapshot's date: a stale snapshot must not say "closes today" a week later
  function istDate(ms) { return new Date((ms || Date.now()) + 5.5 * 3600e3).toISOString().slice(0, 10); }
  let TODAY = istDate();
  const daysTo = (iso) => (isIso(iso) ? Math.round((utc(iso) - utc(TODAY)) / 864e5) : null);
  const addDays = (iso, n) => new Date(utc(iso) + n * 864e5).toISOString().slice(0, 10);
  function relTime(ms) {
    if (!ms) return t('unknown');
    const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
    if (m < 2) return t('just now'); if (m < 60) return t('{n} min ago', { n: m });
    const h = Math.round(m / 60); if (h < 36) return t('{n} h ago', { n: h });
    return t('{n} days ago', { n: Math.round(h / 24) });
  }
  function relDay(iso) {
    const d = daysTo(iso); if (d === null) return '–';
    if (d === 0) return t('today'); if (d === 1) return t('tomorrow'); if (d === -1) return t('yesterday');
    return dday(iso);
  }

  // ------------------------------------------------------------- verdicts ---
  const VERDICT = {
    apply: { label: 'Apply', line: 'The odds are clearly on your side and nothing is flashing red.' },
    lean: { label: 'Leaning yes', line: 'Good odds, with one thing to keep in mind.' },
    coinflip: { label: '50-50 gamble', line: 'Could go either way. Apply only if a small loss is fine with you.' },
    avoid: { label: 'Avoid', line: 'The odds are against a listing-day gain.' },
    watch: { label: 'Too early', line: 'Wait for the demand figures on the last bidding day.' },
    nodata: { label: 'Not enough info', line: 'There is not enough information to judge this one yet.' },
  };
  const TIER_ORDER = { apply: 0, lean: 1, coinflip: 2, watch: 3, avoid: 4, nodata: 5 };
  const vlabel = (tier) => t((VERDICT[tier] || VERDICT.nodata).label);
  const vline = (tier) => t((VERDICT[tier] || VERDICT.nodata).line);
  function verdictPill(tier, big) { return el('span', { class: 'verdict ' + (tier || 'nodata') + (big ? ' lg' : '') }, el('span', { class: 'dot' }), vlabel(tier)); }
  function oddsWords(p) { if (!fin(p)) return ''; if (p >= 0.95) return t('almost every'); if (p <= 0.05) return t('almost no'); return t('about {n} in 10', { n: Math.max(1, Math.round(p * 10)) }); }
  function allotText(p) { if (!fin(p)) return '–'; if (p >= 0.999) return t('Everyone'); const n = 1 / p; return t('1 in {n}', { n: n >= 10 ? Math.round(n) : n.toFixed(1).replace(/\.0$/, '') }); }

  // ---------------------------------------------------------------- data ---
  let D = { live: { ipos: [], market: {}, sources: [] }, params: null, hist: [], track: null };
  let SCORED = [], BYID = new Map();
  function slimHistory(rows) {
    if (!Array.isArray(rows)) return [];
    return rows.map(r => {
      if (r && r.listing === undefined && r.gain_pct !== undefined) return r;
      const lst = (r && r.listing) || {}; if (!fin(lst.gain_pct)) return null;
      const g = r.gmp || {}; let p = g.pct; if (!fin(p) && fin(g.rs) && r.issue_price) p = 100 * Number(g.rs) / Number(r.issue_price);
      return { name: r.name, board: r.board, listing_date: r.listing_date, gmp_pct: fin(p) ? Math.round(p * 100) / 100 : null, gain_pct: Math.round(Number(lst.gain_pct) * 100) / 100, basis: lst.gain_basis || 'close' };
    }).filter(Boolean);
  }
  function setData(payload) {
    const live = payload.live || { ipos: [], market: {}, sources: [] };
    D = {
      live: Object.assign({ ipos: [], market: {}, sources: [] }, live),
      params: payload.params || null,
      hist: slimHistory(payload.history && payload.history.rows ? payload.history.rows : payload.history),
      track: payload.track && typeof payload.track === 'object' ? payload.track : null,
    };
    if (!Array.isArray(D.live.ipos)) D.live.ipos = [];
    if (!Array.isArray(PLAN.picked) || PLAN.snapshot !== (D.live.generated_at || null)) { PLAN.picked = null; PLAN.snapshot = D.live.generated_at || null; }
  }

  // Brokers' delivery-sell charges as published in Oct 2026; DP charge incl. GST.
  const BROKERS = {
    zerodha: { name: 'Zerodha', brokerage_pct: 0, brokerage_min: 0, brokerage_cap: 0, dp_charge: 15.34 },
    groww: { name: 'Groww', brokerage_pct: 0.1, brokerage_min: 5, brokerage_cap: 20, dp_charge: 23.6 },
    upstox: { name: 'Upstox', brokerage_pct: 0, brokerage_min: 20, brokerage_cap: 20, dp_charge: 23.6 },
    angel: { name: 'Angel One', brokerage_pct: 0.1, brokerage_min: 5, brokerage_cap: 20, dp_charge: 23.6 },
    dhan: { name: 'Dhan', brokerage_pct: 0, brokerage_min: 0, brokerage_cap: 0, dp_charge: 15.93 },
    custom: { name: 'Custom' },
  };
  function costsFor(key) {
    const c = S.defaultCosts(); const b = Object.assign({}, BROKERS[key] || {}); delete b.name;
    Object.assign(c, b); if (key === 'custom') Object.assign(c, load('customCosts', {}));
    return c;
  }
  let COSTS = costsFor(PLAN.broker);

  // The status shown is derived from the dates against today's date in India,
  // so a snapshot that is a few hours old never says "open" after bids closed.
  function liveStatus(ipo) {
    const st = ipo.status, o = ipo.open_date, c = ipo.close_date, l = ipo.listing_date;
    if (st === 'listed' || (ipo.listing && fin(ipo.listing.gain_pct))) return 'listed';
    if (isIso(l) && TODAY >= l.slice(0, 10)) return 'listed';
    if (isIso(c) && TODAY > c.slice(0, 10)) return 'closed';
    if (isIso(o) && TODAY >= o.slice(0, 10) && (!isIso(c) || TODAY <= c.slice(0, 10))) return 'open';
    if (isIso(o) && TODAY < o.slice(0, 10)) return 'upcoming';
    return st || 'upcoming';
  }
  function effective(ipo) {
    const e = UI.edits[ipo.id];
    const c = Object.assign({}, ipo, { status: liveStatus(ipo) });
    if (!e) return c;
    c.gmp = Object.assign({}, ipo.gmp || {}); c.subscription = Object.assign({}, ipo.subscription || {});
    if (e.gmp_rs !== undefined) { c.gmp.rs = e.gmp_rs; c.gmp.pct = null; c.gmp.as_of = TODAY; }
    for (const k of ['qib', 'nii', 'retail']) if (e[k] !== undefined) c.subscription[k] = e[k];
    return c;
  }
  function computeAll() {
    TODAY = istDate();
    SCORED = D.live.ipos.filter(i => i && i.id && i.name).map(ipo => {
      const eff = effective(ipo);
      let score = null;
      if (D.params) { try { score = S.scoreIpo(eff, D.params, D.live.market || {}, COSTS, TODAY); } catch (e) { score = null; } }
      return { ipo, eff, score, st: eff.status, edited: !!UI.edits[ipo.id] };
    });
    BYID = new Map(SCORED.map(r => [r.ipo.id, r]));
  }
  const tierOf = (r) => (r.score && r.score.verdict ? r.score.verdict.tier : 'nodata');
  const isLive = (r) => r.st === 'open' || r.st === 'upcoming';
  const minInvest = (r) => { const i = r.eff; if (!i.issue_price && !i.price_band_high) return null; const p = i.issue_price || i.price_band_high; const ml = Number(i.min_lots) || (i.board === 'sme' ? 2 : 1); return i.lot_size ? p * i.lot_size * ml : null; };
  const gmpPct = (r) => (r.score && r.score.flags && r.score.flags.includes('gmp_unquoted')) ? null : S.gmpPctOf(r.eff);
  const trackRow = (id) => (D.track && Array.isArray(D.track.rows) ? D.track.rows.find(x => x.id === id) : null);
  const boardName = (b) => (b === 'sme' ? t('SME') : t('Mainboard'));
  const statusName = (st) => t(({ open: 'Open now', upcoming: 'Upcoming', closed: 'Awaiting listing', listed: 'Listed' })[st] || 'Upcoming');
  function rankLive(a, b) {
    const sa = a.st === 'open' ? 0 : 1, sb = b.st === 'open' ? 0 : 1;
    return (sa - sb) || (TIER_ORDER[tierOf(a)] - TIER_ORDER[tierOf(b)]) || ((b.score && b.score.p_up || 0) - (a.score && a.score.p_up || 0));
  }

  // ----------------------------------------------------- dates & steps ---
  function nextWorkday(iso, n) { let d = iso, k = 0; while (k < n) { d = addDays(d, 1); const w = new Date(utc(d)).getUTCDay(); if (w !== 0 && w !== 6) k++; } return d; }
  function timeline(i) {
    const c = isIso(i.close_date) ? i.close_date.slice(0, 10) : null;
    const est = !!i.timeline_estimated;
    const allot = isIso(i.allotment_date) ? i.allotment_date.slice(0, 10) : (c ? nextWorkday(c, 1) : null);
    const refund = isIso(i.refund_date) ? i.refund_date.slice(0, 10) : (isIso(i.demat_date) ? i.demat_date.slice(0, 10) : (c ? nextWorkday(c, 2) : null));
    return [
      { k: 'open', t: t('Bidding opens'), s: t('Apply through your broker or bank (UPI)'), d: isIso(i.open_date) ? i.open_date.slice(0, 10) : null },
      { k: 'close', t: t('Last day to apply'), s: t('UPI mandates must be approved by 5 pm'), d: c },
      { k: 'allot', t: t('Allotment result'), s: t('Find out if you got shares'), d: allot, est: est || !isIso(i.allotment_date) },
      { k: 'refund', t: t('Money back or shares in demat'), s: t('Blocked money is released if you got nothing'), d: refund, est: est || !(isIso(i.refund_date) || isIso(i.demat_date)) },
      { k: 'list', t: t('Listing day'), s: t('Shares start trading; most sell the same day'), d: isIso(i.listing_date) ? i.listing_date.slice(0, 10) : null },
    ];
  }
  function dueInfo(r) {
    const i = r.eff, st = r.st;
    if (st === 'open') { const d = daysTo(i.close_date); if (d === 0) return { t: t('Last day to apply: today, till 5 pm'), hot: true }; if (d === 1) return { t: t('Last day to apply: tomorrow'), hot: true }; return { t: t('Apply by {d}', { d: dday(i.close_date) }), hot: false }; }
    if (st === 'upcoming') { const d = daysTo(i.open_date); if (d === null) return { t: t('Dates not announced yet'), hot: false }; return { t: d === 0 ? t('Opens today') : d === 1 ? t('Opens tomorrow') : t('Opens {d}', { d: dday(i.open_date) }), hot: d <= 1 }; }
    if (st === 'closed') {
      const tl = timeline(i), al = tl[2].d, ls = tl[4].d;
      if (al && daysTo(al) === 0) return { t: t('Allotment result today'), hot: true };
      if (ls) return { t: t('Lists {d}', { d: relDay(ls) }), hot: daysTo(ls) <= 1 };
      return { t: t('Bidding closed'), hot: false };
    }
    return { t: t('Listed {d}', { d: dshort(i.listing_date) }), hot: false };
  }

  // ------------------------------------------------------------- visuals ---
  function ringEl(p, big) {
    const known = fin(p);
    const r = 23, circ = 2 * Math.PI * r, off = circ * (1 - (known ? Math.max(0, Math.min(1, p)) : 0));
    const cls = !known ? 'n' : p >= 0.7 ? 'g' : p >= 0.5 ? 'w' : 'c';
    const w = el('div', { class: 'ring ' + cls + (big ? ' lg' : ''), role: 'img', 'aria-label': known ? t('{p} chance of a listing gain', { p: pct0(p) }) : t('No estimate yet') });
    w.append(svgEl('svg', { viewBox: '0 0 56 56', 'aria-hidden': 'true' },
      svgEl('circle', { class: 't', cx: 28, cy: 28, r }),
      known ? svgEl('circle', { class: 'v', cx: 28, cy: 28, r, 'stroke-dasharray': circ.toFixed(1), 'stroke-dashoffset': off.toFixed(1), style: '--circ:' + circ.toFixed(1) }) : null));
    w.append(el('div', { class: 'pv', text: known ? pct0(p) : '?' }));
    return w;
  }
  function rangeEl(g) {
    const lo = Math.min(-20, Math.floor((g.p10 - 5) / 10) * 10), hi = Math.max(40, Math.ceil((g.p90 + 5) / 10) * 10);
    const cx = v => Math.max(0, Math.min(100, (v - lo) / (hi - lo) * 100));
    const wrap = el('div', null);
    const r = el('div', { class: 'range', role: 'img', 'aria-label': t('Likely gain from {a} to {b}, most likely {m}', { a: pct(g.p10, 0), b: pct(g.p90, 0), m: pct(g.p50, 0) }) });
    r.append(el('div', { class: 'track' }), el('div', { class: 'neg', style: 'width:' + cx(0) + '%' }), el('div', { class: 'band', style: 'left:' + cx(g.p10) + '%;width:' + Math.max(1.5, cx(g.p90) - cx(g.p10)) + '%' }), el('div', { class: 'zero', style: 'left:' + cx(0) + '%' }), el('div', { class: 'mid', style: 'left:' + cx(g.p50) + '%' }));
    wrap.append(r, el('div', { class: 'range-l' }, el('span', null, t('Bad case') + ' ' + pct(g.p10, 0)), el('span', null, t('Good case') + ' ' + pct(g.p90, 0))));
    return wrap;
  }
  function note(kind, ...kids) { return el('div', { class: 'note ' + kind }, icon(kind === 'good' ? 'check' : kind === 'info' ? 'info' : 'alert'), el('div', null, ...kids)); }
  function termBtn(key, label) { return el('button', { type: 'button', class: 'term', 'data-term': key }, label); }
  function qmark(key) { return el('button', { type: 'button', class: 'qmark', 'data-term': key, 'aria-label': t('What does this mean?') }, '?'); }

  // -------------------------------------------------- plain-language summary ---
  function netAt(inv, gainPct) { return S.netProfitOnSale(inv, inv * (1 + gainPct / 100), COSTS); }
  function plainSummary(r) {
    const i = r.eff, s = r.score, st = r.st, p = el('p', { class: 'plain' });
    const add = (...parts) => { if (p.childNodes.length) p.append(' '); p.append(...parts); };
    if (st === 'listed') {
      const lg = i.listing && fin(i.listing.gain_pct) ? Number(i.listing.gain_pct) : null;
      if (lg !== null) add(t('It listed on {d}', { d: dshort(i.listing_date) }), el('b', { class: lg > 0 ? 'good' : 'bad', text: ' ' + pct(lg, 1) + ' ' }), t('versus its issue price on day one.'));
      else add(t('It has listed. The first-day result has not been recorded yet.'));
      const tr = trackRow(i.id);
      if (tr && fin(tr.p_up)) add(t('Before listing we gave it a {p} chance of a gain and called it “{v}”.', { p: pct0(tr.p_up), v: vlabel(tr.verdict_tier) }));
      const pl = i.post_listing; if (pl && fin(pl.last_price) && i.issue_price) { const now = 100 * (pl.last_price / i.issue_price - 1); add(t('Today it trades at'), el('b', { class: now > 0 ? 'good' : 'bad', text: ' ₹' + pl.last_price + ' (' + pct(now, 1) + ')' }), t('against the issue price.')); }
      return p;
    }
    if (!s || !fin(s.p_up)) { add(vline('nodata')); if (st === 'upcoming') add(t('We will have a first read once a grey-market price or demand figures appear.')); return p; }
    add(t('Of 10 IPOs that looked like this one,'), el('b', null, ' ' + t('about {n}', { n: Math.max(0, Math.min(10, Math.round(s.p_up * 10))) }) + ' '), t('ended their first day above the issue price.'));
    const inv = minInvest(r);
    if (s.gain && inv) {
      const net = netAt(inv, s.gain.p50).net;
      add(t('If you get shares, the most likely result is'), el('b', { class: net >= 0 ? 'good' : 'bad', text: ' ' + inr(net, { plus: true }) + ' ' }), t('on {inv} after charges and tax.', { inv: inr(inv) }));
    }
    const al = s.allotment && fin(s.allotment.p_min_lot) ? s.allotment.p_min_lot : null;
    if (al !== null) add(al >= 0.999 ? t('Everyone who applies gets shares right now.') : t('Shares go by lottery: roughly {a} applicants gets them.', { a: allotText(al) }));
    else if (st === 'upcoming' || st === 'open') add(t('Your chance of getting shares will show once retail demand is known.'));
    add(el('b', null, vline(tierOf(r))));
    return p;
  }

  // -------------------------------------------------------------- IPO card ---
  function kpi(label, value, cls) { return el('div', { class: 'kpi' }, el('div', { class: 'l', text: label }), el('div', { class: 'v num ' + (cls || ''), text: value })); }
  function ipoCard(r) {
    const i = r.eff, s = r.score, st = r.st, tier = tierOf(r);
    const card = el('button', { type: 'button', class: 'card tap ipo' + (st === 'listed' ? ' listed' : ''), 'data-id': i.id, onclick: () => openIpo(i.id) });
    const tags = el('div', { class: 'meta' }, el('span', { class: 'tag ' + (i.board === 'sme' ? 'sme' : 'main'), text: boardName(i.board) }), el('span', { class: 'tag' + (st === 'open' ? ' open' : ''), text: statusName(st) }), WATCH.has(i.id) ? el('span', { class: 'tag gold' }, '★ ' + t('Watching')) : null, r.edited ? el('span', { class: 'tag', text: t('your numbers') }) : null);
    const lg = st === 'listed' && i.listing && fin(i.listing.gain_pct) ? Number(i.listing.gain_pct) : null;
    card.append(el('div', { class: 'top' }, el('div', { class: 'grow' }, el('div', { class: 'nm', text: i.name }), tags), st === 'listed' ? null : ringEl(s && s.p_up)));
    if (st !== 'listed') {
      card.append(el('div', { class: 'row wrapf' }, verdictPill(tier)));
      card.append(el('div', { class: 'say', text: s && fin(s.p_up) ? t('{o} similar IPOs listed above their price.', { o: cap(oddsWords(s.p_up)) }) + ' ' + vline(tier) : vline(tier) }));
      const inv = minInvest(r), al = s && s.allotment && fin(s.allotment.p_min_lot) ? s.allotment.p_min_lot : null;
      card.append(el('div', { class: 'kpis' },
        kpi(t('You need'), inv ? inrShort(inv) : '–'),
        kpi(t('Likely gain'), s && s.gain ? pct(s.gain.p50, 0) : '–', s && s.gain ? (s.gain.p50 > 0 ? 'good' : 'bad') : ''),
        kpi(t('Get shares'), al !== null ? allotText(al) : (st === 'upcoming' ? t('later') : '–'))));
    } else {
      const tr = trackRow(i.id), pl = i.post_listing, now = pl && fin(pl.last_price) && i.issue_price ? 100 * (pl.last_price / i.issue_price - 1) : null;
      card.append(el('div', { class: 'kpis' },
        kpi(t('Day one'), lg !== null ? pct(lg, 1) : '–', lg === null ? '' : lg > 0 ? 'good' : 'bad'),
        kpi(t('Now'), now !== null ? pct(now, 1) : '–', now === null ? '' : now > 0 ? 'good' : 'bad'),
        kpi(t('We said'), tr ? vlabel(tr.verdict_tier) : (s ? pct0(s.p_up) : '–'), tr ? 'txt' : '')));
    }
    const due = dueInfo(r);
    card.append(el('div', { class: 'due' + (due.hot ? ' hot' : '') }, icon('clock'), due.t));
    return card;
  }
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

  // --------------------------------------------------------------- shell ---
  const TABS = [
    { k: 'home', label: 'Today', icon: 'sun' },
    { k: 'ipos', label: 'IPOs', icon: 'list' },
    { k: 'plan', label: 'Planner', icon: 'calc' },
    { k: 'proof', label: 'Track record', icon: 'shield' },
    { k: 'more', label: 'More', icon: 'menu' },
  ];
  const SCREENS = ['home', 'ipos', 'ipo', 'plan', 'proof', 'more'];
  function renderTabbar() {
    const nav = $('#tabbar'); nav.replaceChildren();
    for (const tb of TABS) {
      const cur = UI.tab === tb.k || (UI.tab === 'ipo' && tb.k === (UI.prevTab || 'ipos'));
      nav.append(el('button', { type: 'button', class: 'tab', 'aria-current': cur ? 'page' : null, onclick: () => go(tb.k) }, el('span', { class: 'ic' }, icon(tb.icon)), el('span', { class: 'lab', text: t(tb.label) })));
    }
  }
  let pushedDetail = false;
  function parseHash() {
    const h = decodeURIComponent((location.hash || '').replace(/^#/, ''));
    if (h.startsWith('ipo/')) return { tab: 'ipo', id: h.slice(4) };
    return { tab: SCREENS.includes(h) && h !== 'ipo' ? h : null };
  }
  function setHash(h, push) { try { if (push) history.pushState(null, '', '#' + h); else history.replaceState(null, '', '#' + h); } catch (e) { /* sandboxed */ } }
  function go(tab, opts) {
    if (!SCREENS.includes(tab) || tab === 'ipo') tab = 'home';
    if (UI.tab === 'ipo' && pushedDetail) { pushedDetail = false; try { history.replaceState(null, '', '#' + tab); } catch (e) { /* ignore */ } }
    UI.scroll[UI.tab] = window.scrollY;
    UI.tab = tab; store('tab', tab);
    if (!(opts && opts.noHash)) setHash(tab, false);
    show({ top: !(opts && opts.keepScroll) });
  }
  function openIpo(id) {
    if (!BYID.has(id)) return;
    if (UI.tab !== 'ipo') { UI.prevTab = UI.tab; UI.scroll[UI.tab] = window.scrollY; }
    UI.ipo = id; UI.tab = 'ipo';
    setHash('ipo/' + encodeURIComponent(id), !pushedDetail); pushedDetail = true;
    show({ top: true });
  }
  function leaveDetail() {
    const back = UI.prevTab || 'ipos';
    if (pushedDetail) { pushedDetail = false; try { history.back(); return; } catch (e) { /* fall through */ } }
    UI.tab = back; setHash(back, false); show({ restore: true });
  }
  window.addEventListener('popstate', () => {
    const r = parseHash();
    if (r.tab === 'ipo' && BYID.has(r.id)) { UI.ipo = r.id; UI.tab = 'ipo'; pushedDetail = true; show({ top: true }); return; }
    pushedDetail = false;
    const tab = r.tab || UI.prevTab || 'home';
    UI.tab = tab; show({ restore: true });
  });
  function show(opts) {
    for (const s of SCREENS) { const n = document.getElementById('screen-' + s); if (n) n.hidden = s !== UI.tab; }
    $('#topbar').classList.toggle('detail', UI.tab === 'ipo');
    renderTabbar();
    renderScreen(UI.tab);
    if (opts && opts.top) window.scrollTo(0, 0);
    else if (opts && opts.restore) window.scrollTo(0, UI.scroll[UI.tab] || 0);
  }
  function renderScreen(tab) {
    try {
      ({ home: renderHome, ipos: renderIpos, ipo: renderIpo, plan: renderPlan, proof: renderProof, more: renderMore })[tab]();
    } catch (e) {
      console.error('render ' + tab, e);
      const n = document.getElementById('screen-' + tab);
      if (n) n.replaceChildren(note('crit', t('Something went wrong drawing this screen. Pull down to refresh; if it keeps happening, tell us from More → Get help.')));
    }
  }
  function rerender() { const y = window.scrollY; computeAll(); renderTop(); renderTabbar(); renderScreen(UI.tab); window.scrollTo(0, y); }

  // --------------------------------------------------------------- sheet ---
  let sheetClose = null;
  function openSheet(title, nodes, onClose) {
    const back = $('#sheet');
    $('#sheet-title').textContent = title;
    $('#sheet-body').replaceChildren(...[].concat(nodes).filter(Boolean));
    back.hidden = false; sheetClose = onClose || null;
    document.body.style.overflow = 'hidden';
    setTimeout(() => { const f = $('#sheet-body [autofocus]') || $('#sheet-close'); if (f) f.focus({ preventScroll: true }); }, 30);
  }
  function closeSheet() {
    const back = $('#sheet'); if (back.hidden) return false;
    back.hidden = true; document.body.style.overflow = '';
    const f = sheetClose; sheetClose = null; if (f) f();
    return true;
  }
  let toastT = null;
  function toast(msg) { const n = $('#toast'); n.textContent = msg; n.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { n.hidden = true; }, 2600); }
  // Android back: a sheet closes first, then the IPO page, then back to Today; false lets the app exit.
  window.ipoRadarBack = function () {
    if (closeSheet()) return true;
    if (UI.tab === 'ipo') { leaveDetail(); return true; }
    if (UI.tab !== 'home') { go('home'); return true; }
    return false;
  };

  // ---------------------------------------------------- top bar & refresh ---
  let manual = false;
  function dataAgeMs() { const g = D.live.generated_at ? Date.parse(D.live.generated_at) : NaN; return isFinite(g) ? g : null; }
  function renderTop() {
    const pill = $('#fresh'), btn = $('#refresh'), gen = dataAgeMs();
    const busy = !!(STATUS && STATUS.refreshing);
    let cls = 'fresh', txt;
    const ageH = gen ? (Date.now() - gen) / 36e5 : null;
    if (busy) { cls += ' busy'; txt = t('Updating…'); }
    else if (STATUS && STATUS.online === false) { cls += ' off'; txt = t('Offline') + ' · ' + relTime(gen); }
    else if (STATUS && STATUS.error && manual) { cls += ' err'; txt = t('Update failed'); }
    else { txt = t('Updated {r}', { r: relTime(gen) }); if (ageH !== null && ageH > 30) cls += ' stale'; }
    if (D.live.health && D.live.health.ok === false && !busy) cls += ' stale';
    pill.className = cls; pill.lastChild.textContent = txt;
    pill.setAttribute('aria-label', t('Data status: {s}. Tap for details.', { s: txt }));
    btn.classList.toggle('spinning', busy); btn.disabled = busy;
  }
  function doRefresh() {
    if (has('refresh')) { manual = true; STATUS = Object.assign({}, STATUS || {}, { refreshing: true, error: null }); renderTop(); call('refresh'); return; }
    toast(t('Live refresh works in the Android app. This page shows the data it was built with.'));
  }
  window.ipoRadarStatus = function (st) {
    const was = STATUS && STATUS.refreshing;
    STATUS = st || null; renderTop();
    if (STATUS && STATUS.alerts && typeof STATUS.alerts === 'object') ALERTS = Object.assign(ALERTS, STATUS.alerts);
    if (was && STATUS && !STATUS.refreshing && manual) {
      if (STATUS.error) toast(t('Could not update. Showing the last saved data.'));
      else if (STATUS.changed === false) toast(t('Already up to date'));
      manual = STATUS.changed === true ? manual : false;
    }
    if (UI.tab === 'more') { const y = window.scrollY; renderMore(); window.scrollTo(0, y); }
  };
  function dataSheet() {
    const gen = dataAgeMs(), h = D.live.health, nodes = [];
    nodes.push(el('div', { class: 'money' },
      line(t('Prices and demand as of'), gen ? new Date(gen).toLocaleString(PREF.lang === 'hi' ? 'hi-IN' : 'en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '–'),
      STATUS ? line(t('Last downloaded'), STATUS.downloaded_at ? relTime(STATUS.downloaded_at) : t('bundled with the app')) : null,
      STATUS && STATUS.schedule_hours > 0 ? line(t('Background refresh'), t('every {n} h', { n: STATUS.schedule_hours })) : null,
      line(t('Model'), D.params ? (D.params.status === 'calibrated' ? t('fitted on {n} past listings', { n: D.params.n_rows }) : t('starting weights (not yet fitted)')) : '–')));
    if (h && Array.isArray(h.issues) && h.issues.length) nodes.push(note(h.ok === false ? 'warn' : 'info', t('Data checks found {n} thing(s) to be careful about. See More → Data quality.', { n: h.issues.length })));
    else if (h) nodes.push(note('good', t('All automatic data checks passed.')));
    nodes.push(el('p', { class: 'small muted', text: t('The data is refreshed from public sources several times on every trading day. Pull down on any screen, or tap the refresh button, to fetch the latest.') }));
    nodes.push(el('div', { class: 'btn-row' }, el('button', { type: 'button', class: 'btn primary', onclick: () => { closeSheet(); doRefresh(); } }, icon('up'), t('Refresh now'))));
    openSheet(t('About this data'), nodes);
  }
  function line(k, v, cls) { return el('div', { class: 'ln' + (cls ? ' ' + cls : '') }, el('span', { class: 'k' }, k), el('span', { class: 'v' }, v)); }

  // ---------------------------------------------------------------- home ---
  function introCard() {
    return el('div', { class: 'card intro' },
      el('h2', { text: t('New here? Three things to know') }),
      el('ol', null,
        el('li', null, el('div', null, el('b', null, t('Start with the coloured label.')), ' ', t('Apply, Leaning yes, 50-50 gamble, Avoid or Too early. It already weighs everything else.'))),
        el('li', null, el('div', null, el('b', null, t('“70%” means 7 in 10.')), ' ', t('Of ten IPOs that looked like this one, about seven ended their first day above the issue price. It is not the profit you will make.'))),
        el('li', null, el('div', null, el('b', null, t('Most people get no shares.')), ' ', t('Popular IPOs are given out by lottery. Your money is simply returned in a few days if you are not picked.')))),
      el('div', { class: 'btn-row' },
        el('button', { type: 'button', class: 'btn primary', onclick: () => { store('intro_seen', true); renderHome(); } }, t('Got it')),
        el('button', { type: 'button', class: 'btn ghost', 'data-term': 'howto' }, t('Read the 1-minute guide'))));
  }
  function actionRow(ic, kind, title, sub, onclick) {
    return el('button', { type: 'button', class: 'card tap action', onclick }, el('span', { class: 'ico ' + (kind || '') }, icon(ic)), el('div', { class: 'grow' }, el('div', { class: 't', text: title }), sub ? el('div', { class: 's', text: sub }) : null), icon('chev', 'chev'));
  }
  function attention() {
    const out = [];
    for (const r of SCORED) {
      const i = r.eff, w = WATCH.has(i.id), tier = tierOf(r), good = tier === 'apply' || tier === 'lean';
      if (r.st === 'open' && daysTo(i.close_date) === 0 && (w || good)) out.push([0, actionRow('clock', 'urgent', t('Last day to apply: {n}', { n: i.name }), vlabel(tier) + ' · ' + t('UPI approval needed by 5 pm'), () => openIpo(i.id))]);
      if (r.st === 'closed') {
        const tl = timeline(i);
        if (tl[2].d === TODAY) out.push([1, actionRow('bell', 'gold', t('Allotment result today: {n}', { n: i.name }), i.registrar && i.registrar.name ? t('Check on the {r} website', { r: i.registrar.name }) : t('Tap to see how to check'), () => openIpo(i.id))]);
        if (tl[4].d === TODAY) out.push([2, actionRow('flag', '', t('{n} lists today', { n: i.name }), t('Trading starts at 10 am. Most people sell the same day.'), () => openIpo(i.id))]);
      }
      if (r.st === 'upcoming' && w && daysTo(i.open_date) !== null && daysTo(i.open_date) <= 1) out.push([3, actionRow('star', 'gold', t('{n} opens {d}', { n: i.name, d: relDay(i.open_date) }), vlabel(tier), () => openIpo(i.id))]);
    }
    return out.sort((a, b) => a[0] - b[0]).slice(0, 4).map(x => x[1]);
  }
  function calendar() {
    const days = new Map();
    const addEv = (iso, kind, r) => { if (!isIso(iso)) return; const d = iso.slice(0, 10), k = daysTo(d); if (k === null || k < 0 || k > 14) return; if (!days.has(d)) days.set(d, []); days.get(d).push([kind, r]); };
    for (const r of SCORED) {
      if (r.st === 'listed') continue;
      const tl = timeline(r.eff);
      addEv(tl[0].d, t('Opens'), r); addEv(tl[1].d, t('Last day'), r); if (r.st !== 'upcoming') addEv(tl[2].d, t('Allotment'), r); addEv(tl[4].d, t('Lists'), r);
    }
    const keys = [...days.keys()].sort().slice(0, 10);
    if (!keys.length) return null;
    const strip = el('div', { class: 'cal-strip', role: 'list' });
    for (const d of keys) {
      const box = el('div', { class: 'cal-day' + (d === TODAY ? ' today' : ''), role: 'listitem' }, el('div', { class: 'd', text: relDay(d) }));
      for (const [kind, r] of days.get(d).slice(0, 4)) box.append(el('button', { type: 'button', class: 'ev', onclick: () => openIpo(r.ipo.id) }, el('b', null, kind), r.eff.name));
      strip.append(box);
    }
    return strip;
  }
  function trustCard() {
    const tk = D.track;
    let big = '—', txt;
    if (tk && tk.by_verdict) {
      const a = tk.by_verdict.apply || {}, l = tk.by_verdict.lean || {};
      const n = (a.n || 0) + (l.n || 0), up = (a.n_up || 0) + (l.n_up || 0);
      if (n >= 3) { big = Math.round(100 * up / n) + '%'; txt = el('p', null, t('When we said'), ' ', el('b', null, t('Apply')), ' ', t('or'), ' ', el('b', null, t('Leaning yes')), ', ', t('{u} of {n} IPOs listed above their price.', { u: up, n })); }
    }
    if (!txt) txt = el('p', null, t('Every call is saved before listing and checked against what actually happened. Nothing is edited afterwards.'));
    return el('div', { class: 'card trust' }, el('div', { class: 'big num', text: big }), el('div', { class: 'stack', style: 'gap:8px' }, el('b', null, tk && tk.n_backfill && !tk.n_locked ? t('Our record on past IPOs (back-test)') : t('Our track record')), txt, el('div', null, el('button', { type: 'button', class: 'btn sm', onclick: () => go('proof') }, t('See every call')))));
  }
  function renderHome() {
    const host = $('#screen-home'); host.replaceChildren();
    if (!load('intro_seen', false)) host.append(introCard());
    const open = SCORED.filter(r => r.st === 'open'), up = SCORED.filter(r => r.st === 'upcoming');
    const listingSoon = SCORED.filter(r => r.st === 'closed' && (() => { const d = daysTo(r.eff.listing_date); return d !== null && d >= 0 && d <= 7; })());
    const goodOpen = open.filter(r => ['apply', 'lean'].includes(tierOf(r)));
    const dow = DOWL[L()][new Date(utc(TODAY)).getUTCDay()];
    const head = open.length === 0 ? t('No IPO is open for bidding today') : open.length === 1 ? t('1 IPO is open for bidding') : t('{n} IPOs are open for bidding', { n: open.length });
    const lede = [];
    if (open.length) lede.push(goodOpen.length === 0 ? t('None of them looks like a clear yes.') : goodOpen.length === 1 ? t('1 of them looks worth applying.') : t('{n} of them look worth applying.', { n: goodOpen.length }));
    const nextUp = up.filter(r => isIso(r.eff.open_date)).sort((a, b) => a.eff.open_date < b.eff.open_date ? -1 : 1)[0];
    if (nextUp) lede.push(t('Next to open: {n}, {d}.', { n: nextUp.eff.name, d: relDay(nextUp.eff.open_date) }));
    host.append(el('div', { class: 'hello' }, el('div', { class: 'date', text: dow + ', ' + dshort(TODAY) }), el('h1', { text: head }), lede.length ? el('p', { class: 'lede', text: lede.join(' ') }) : null));
    const stat = (n, label, st) => el('button', { type: 'button', class: 'stat', onclick: () => { UI.status = st; go('ipos'); } }, el('div', { class: 'v num', text: String(n) }), el('div', { class: 'l', text: label }));
    host.append(el('div', { class: 'stats' }, stat(open.length, t('Open now'), 'open'), stat(up.length, t('Opening soon'), 'upcoming'), stat(listingSoon.length, t('Listing this week'), 'closed')));
    const acts = attention();
    if (acts.length) host.append(el('div', { class: 'sec' }, el('div', { class: 'sec-h' }, el('h2', { text: t('Needs your attention') })), ...acts));
    const best = SCORED.filter(r => isLive(r) && tierOf(r) !== 'nodata').sort(rankLive).slice(0, 3);
    const bestSec = el('div', { class: 'sec' }, el('div', { class: 'sec-h' }, el('h2', { text: t('Best right now') }), el('button', { type: 'button', class: 'link', onclick: () => { UI.status = 'active'; go('ipos'); } }, t('See all'))));
    if (best.length) bestSec.append(el('div', { class: 'grid2' }, ...best.map(ipoCard)));
    else bestSec.append(el('div', { class: 'card empty' }, icon('search'), el('div', { text: t('Nothing open or upcoming has enough information for a call yet.') })));
    host.append(bestSec);
    const cal = calendar();
    if (cal) host.append(el('div', { class: 'sec' }, el('div', { class: 'sec-h' }, el('h2', { text: t('Coming up') })), cal));
    host.append(trustCard());
    const watched = SCORED.filter(r => WATCH.has(r.ipo.id) && r.st !== 'listed');
    if (watched.length) host.append(el('div', { class: 'sec' }, el('div', { class: 'sec-h' }, el('h2', { text: t('Your watchlist') }), el('button', { type: 'button', class: 'link', onclick: () => { UI.status = 'watch'; go('ipos'); } }, t('See all'))), el('div', { class: 'grid2' }, ...watched.sort(rankLive).slice(0, 4).map(ipoCard))));
    host.append(footer());
  }
  function footer() {
    return el('footer', { class: 'foot' }, el('div', { text: t('Not investment advice. A 75% chance of a gain is a 25% chance of a loss.') }), el('div', { text: 'IPO Radar · ' + t('a Layerbit tool') }));
  }

  // ---------------------------------------------------------------- list ---
  const STATUS_FILTERS = [['active', 'Active'], ['open', 'Open now'], ['upcoming', 'Upcoming'], ['closed', 'Awaiting listing'], ['listed', 'Listed'], ['watch', 'Watchlist'], ['all', 'All']];
  const SORTS = [['smart', 'Best first'], ['chance', 'Highest chance of gain'], ['worth', 'Most worth per application'], ['date', 'By date']];
  function inStatus(r, f) { return f === 'all' || (f === 'active' ? r.st !== 'listed' : f === 'watch' ? WATCH.has(r.ipo.id) : r.st === f); }
  function matchQ(r) { const q = UI.q.trim().toLowerCase(); return !q || r.eff.name.toLowerCase().includes(q); }
  function listRows() {
    let rows = SCORED.filter(r => (UI.board === 'all' || r.eff.board === UI.board) && inStatus(r, UI.status) && matchQ(r));
    const ev = r => (r.score && fin(r.score.ev.ev) ? r.score.ev.ev : -1e9), pu = r => (r.score && fin(r.score.p_up) ? r.score.p_up : -1);
    const SO = { open: 0, closed: 1, upcoming: 2, listed: 3 };
    const key = {
      smart: r => [SO[r.st] ?? 9, TIER_ORDER[tierOf(r)], -pu(r)],
      chance: r => [r.st === 'listed' ? 1 : 0, -pu(r)],
      worth: r => [r.st === 'listed' ? 1 : 0, -ev(r)],
      date: r => [r.st === 'listed' ? 1 : 0, r.st === 'listed' ? -(utc(r.eff.listing_date || '2000-01-01')) : utc(r.eff.close_date || r.eff.open_date || '2099-01-01')],
    }[UI.sort] || (r => [0]);
    rows.sort((a, b) => { const ka = key(a), kb = key(b); for (let i = 0; i < ka.length; i++) { if (ka[i] < kb[i]) return -1; if (ka[i] > kb[i]) return 1; } return 0; });
    if (UI.status === 'listed' || UI.status === 'all') rows = rows.slice(0, 120);
    return rows;
  }
  function renderIpoList() {
    const host = $('#ipo-list'); if (!host) return;
    const rows = listRows(); host.replaceChildren();
    if (!rows.length) {
      host.append(el('div', { class: 'card empty' }, icon('search'), el('div', { text: UI.q ? t('No IPO matches “{q}”.', { q: UI.q }) : UI.status === 'watch' ? t('Your watchlist is empty. Open any IPO and tap Watch.') : t('Nothing here right now.') }),
        (UI.status !== 'all' || UI.board !== 'all' || UI.q) ? el('button', { type: 'button', class: 'btn sm', onclick: () => { UI.status = 'all'; UI.board = 'all'; UI.q = ''; renderIpos(); } }, t('Show all IPOs')) : null));
      return;
    }
    host.append(el('div', { class: 'grid2' }, ...rows.map(ipoCard)));
  }
  function renderIpos() {
    const host = $('#screen-ipos'); host.replaceChildren();
    host.append(el('div', { class: 'hello' }, el('h1', { text: t('IPOs') }), el('p', { class: 'lede', text: t('Every mainboard and SME IPO in India. Tap one for the full picture.') })));
    const search = el('input', { type: 'search', placeholder: t('Search by company name'), value: UI.q, 'aria-label': t('Search by company name'), enterkeyhint: 'search' });
    search.addEventListener('input', () => { UI.q = search.value; renderIpoList(); });
    host.append(el('label', { class: 'search' }, icon('search'), search));
    const onBoard = SCORED.filter(r => UI.board === 'all' || r.eff.board === UI.board);
    const chips = el('div', { class: 'chips', role: 'group', 'aria-label': t('Filter by status') });
    for (const [k, lab] of STATUS_FILTERS) {
      const n = onBoard.filter(r => inStatus(r, k)).length;
      chips.append(el('button', { type: 'button', class: 'chip-btn', 'aria-pressed': UI.status === k ? 'true' : 'false', onclick: () => { UI.status = k; renderIpos(); } }, t(lab), el('span', { class: 'n', text: String(n) })));
    }
    host.append(chips);
    const seg = el('div', { class: 'seg', role: 'group', 'aria-label': t('Board') });
    for (const [k, lab] of [['all', 'All'], ['mainboard', 'Mainboard'], ['sme', 'SME']]) seg.append(el('button', { type: 'button', 'aria-pressed': UI.board === k ? 'true' : 'false', onclick: () => { UI.board = k; renderIpos(); } }, t(lab)));
    const sortBtn = el('button', { type: 'button', class: 'btn sm', onclick: () => pickSheet(t('Sort'), SORTS.map(([k, l]) => [k, t(l)]), UI.sort, (v) => { UI.sort = v; renderIpos(); }) }, icon('list'), t((SORTS.find(s => s[0] === UI.sort) || SORTS[0])[1]));
    host.append(el('div', { class: 'row wrapf', style: 'justify-content:space-between' }, seg, el('div', { class: 'row', style: 'gap:6px' }, qmark('sme'), sortBtn)));
    host.append(el('div', { id: 'ipo-list' }));
    renderIpoList();
    const act = chips.querySelector('[aria-pressed="true"]'); if (act && act.scrollIntoView) setTimeout(() => act.scrollIntoView({ block: 'nearest', inline: 'center' }), 0);
  }
  function pickSheet(title, options, cur, onPick) {
    const nodes = options.map(([k, lab]) => el('button', { type: 'button', class: 'opt-row', role: 'option', 'aria-selected': String(k) === String(cur) ? 'true' : 'false', onclick: () => { closeSheet(); onPick(k); } }, el('span', { text: lab }), icon('check')));
    openSheet(title, el('div', { class: 'stack', style: 'gap:8px', role: 'listbox' }, ...nodes));
  }

  // -------------------------------------------------------------- detail ---
  function fact(label, value, sub, cls, term) {
    return el('div', { class: 'fact' }, el('div', { class: 'l' }, label, term ? qmark(term) : null), el('div', { class: 'v num ' + (cls || ''), text: value }), sub ? el('div', { class: 's', text: sub }) : null);
  }
  function section(title, ...kids) { return el('div', { class: 'card stack' }, el('h3', { text: title }), ...kids); }
  function renderIpo() {
    const host = $('#screen-ipo'); host.replaceChildren();
    const r = BYID.get(UI.ipo);
    if (!r) { host.append(el('div', { class: 'card empty' }, el('div', { text: t('This IPO is no longer in the data.') }), el('button', { type: 'button', class: 'btn', onclick: () => go('ipos') }, t('Back to IPOs')))); return; }
    const i = r.eff, s = r.score, st = r.st, tier = tierOf(r);
    // hero
    const hero = el('div', { class: 'card hero' });
    hero.append(el('div', { class: 'meta row wrapf', style: 'gap:6px' }, el('span', { class: 'tag ' + (i.board === 'sme' ? 'sme' : 'main'), text: boardName(i.board) }), el('span', { class: 'tag' + (st === 'open' ? ' open' : ''), text: statusName(st) }), i.exchange ? el('span', { class: 'tag', text: i.exchange }) : null, r.edited ? el('span', { class: 'tag gold', text: t('your numbers') }) : null));
    hero.append(el('h1', { class: 'nm', text: i.name }));
    if (i.about) hero.append(el('p', { class: 'about', text: i.about }));
    if (st !== 'listed') hero.append(el('div', { class: 'verdict-box' }, ringEl(s && s.p_up, true), el('div', { class: 'stack', style: 'gap:6px' }, el('div', null, verdictPill(tier, true)), el('div', { class: 'small ink2', text: s && fin(s.p_up) ? t('Chance of ending day one above the issue price') : '' }), s && s.verdict.gamble ? el('button', { type: 'button', class: 'tag ' + (s.verdict.gamble === 'sure' ? 'crit' : 'gold'), 'data-term': 'gamble', style: 'justify-self:start;border:0' }, s.verdict.gamble === 'sure' ? t('Sure gamble') : t('Possible gamble')) : null)));
    hero.append(plainSummary(r));
    const due = dueInfo(r); hero.append(el('div', { class: 'ipo' }, el('div', { class: 'due' + (due.hot ? ' hot' : '') }, icon('clock'), due.t)));
    const on = WATCH.has(i.id);
    hero.append(el('div', { class: 'btn-row' },
      st !== 'listed' ? el('button', { type: 'button', class: 'btn star', 'aria-pressed': on ? 'true' : 'false', onclick: () => { toggleWatch(i.id); renderIpo(); } }, icon('star'), on ? t('Watching') : t('Watch')) : null,
      el('button', { type: 'button', class: 'btn', onclick: () => shareIpoCard(r) }, icon('share'), t('Share')),
      el('button', { type: 'button', class: 'btn', onclick: () => journalSheet(i.id) }, icon('wallet'), journalFor(i.id) ? t('My application') : t('I applied'))));
    host.append(hero);
    // cautions
    const cautions = [];
    if (D.params && D.params.status !== 'calibrated' && st !== 'listed' && s && fin(s.p_up)) cautions.push(note('info', t('The chance figures are first estimates: the model is still on its starting weights until it has enough past listings to check itself against.'), ' ', el('button', { type: 'button', class: 'linkish', onclick: () => go('proof') }, t('Why?'))));
    if (i.gmp && i.gmp.disagree) cautions.push(note('warn', t('Grey-market quotes from different sources disagree a lot for this IPO. Treat the premium with extra caution.')));
    const hf = (i.health_flags || []).length; if (hf) cautions.push(note('warn', t('Our automatic checks flagged something odd in this IPO’s data. Double-check the numbers before deciding.')));
    if (s && s.flags && s.flags.includes('gmp_stale') && st !== 'listed') cautions.push(note('warn', t('The grey-market quote is 3 or more days old.')));
    if (cautions.length) host.append(el('div', { class: 'stack' }, ...cautions));
    const colA = el('div', { class: 'stack-lg' }), colB = el('div', { class: 'stack-lg' });
    // numbers
    const inv = minInvest(r), ml = Number(i.min_lots) || (i.board === 'sme' ? 2 : 1);
    const al = s && s.allotment && fin(s.allotment.p_min_lot) ? s.allotment.p_min_lot : null;
    const g = gmpPct(r);
    if (st !== 'listed') {
      const facts = el('div', { class: 'facts' },
        fact(t('Minimum to apply'), inv ? inr(inv) : '–', i.lot_size ? (ml > 1 ? t('{m} lots of {l} shares at ₹{p}', { m: ml, l: i.lot_size, p: i.issue_price || i.price_band_high }) : t('1 lot of {l} shares at ₹{p}', { l: i.lot_size, p: i.issue_price || i.price_band_high })) : t('lot size not announced'), '', 'lot'),
        fact(t('Chance of getting shares'), al !== null ? allotText(al) : '–', al !== null ? (al >= 0.999 ? t('everyone who applies') : t('retail asked for {x} the shares on offer', { x: xm(i.subscription && (i.subscription.retail || i.subscription.total)) })) : (st === 'upcoming' ? t('known once bidding starts') : t('no demand figures yet')), '', 'allot'),
        fact(t('Likely gain'), s && s.gain ? pct(s.gain.p50, 0) : '–', s && s.gain ? t('most likely; range {a} to {b}', { a: pct(s.gain.p10, 0), b: pct(s.gain.p90, 0) }) : '', s && s.gain ? (s.gain.p50 > 0 ? 'good' : 'bad') : '', 'range'),
        fact(t('Worth per application'), s && fin(s.ev.ev) ? inr(s.ev.ev, { plus: true }) : '–', s && fin(s.ev.ev) ? t('average, counting the lottery, after charges and tax') : t('needs demand figures'), s && fin(s.ev.ev) ? (s.ev.ev > 0 ? 'good' : 'bad') : '', 'worth'));
      const sec = section(t('The numbers'), facts);
      if (s && s.gain) sec.append(el('div', null, el('div', { class: 'small ink2', style: 'margin-bottom:4px' }, t('Where the listing-day gain could land')), rangeEl(s.gain)));
      colA.append(sec);
    } else colA.append(listedSection(r));
    // timeline
    const tl = timeline(i), ol = el('ol', { class: 'timeline' });
    let nowSet = false;
    for (const step of tl) {
      const passed = step.d && step.d < TODAY, isNow = !nowSet && step.d && step.d >= TODAY;
      if (isNow) nowSet = true;
      ol.append(el('li', { class: passed ? 'done' : isNow ? 'now' : '' }, el('span', { class: 'dot' }, passed ? icon('check') : null), el('div', null, el('div', { class: 't', text: step.t }), el('div', { class: 's', text: step.s })), el('span', { class: 'd', text: step.d ? (step.est ? '~' : '') + dday(step.d) : t('not announced') })));
    }
    const tsec = section(t('Key dates'), ol);
    if (tl.some(x => x.est && x.d)) tsec.append(el('p', { class: 'tiny muted', text: t('~ marks a date estimated from SEBI’s T+3 timetable; the company’s own dates replace it when announced.') }));
    colB.append(tsec);
    // allotment check
    if (st === 'closed' || st === 'listed') colB.append(allotSection(i));
    // money
    if (st !== 'listed' && inv && s && s.gain) colA.append(moneySection(r, inv));
    // demand
    colA.append(demandSection(r));
    // gmp
    colA.append(gmpSection(r, g));
    // why
    const why = el('ul', { class: 'reasons' });
    if (s) { for (const w of s.verdict.warnings) why.append(el('li', { class: 'w' }, icon('alert'), el('span', { text: w }))); for (const w of s.verdict.reasons) why.append(el('li', { class: 'r' }, icon('info'), el('span', { text: w }))); }
    if (!why.children.length) why.append(el('li', { class: 'r' }, icon('info'), el('span', { text: t('Nothing to report yet.') })));
    const wsec = section(t('Why we say this'), why);
    if (s && s.similar && s.similar.n >= 5 && fin(s.similar.lo)) wsec.append(el('p', { class: 'small ink2', text: t('Past {b} IPOs with a premium of {k}: {u} of {n} listed up; typical gain {m}.', { b: boardName(i.board), k: s.similar.bucket, u: s.similar.n_up, n: s.similar.n, m: pct(s.similar.median_gain, 0) }) }));
    colB.append(wsec);
    colB.append(issueSection(r));
    if (st !== 'listed') colB.append(whatIfSection(r));
    colB.append(sourcesSection(i));
    host.append(el('div', { class: 'detail-grid' }, colA, colB));
    host.append(footer());
  }
  function listedSection(r) {
    const i = r.eff, s = r.score, lst = i.listing || {}, tr = trackRow(i.id), pl = i.post_listing || {};
    const lg = fin(lst.gain_pct) ? Number(lst.gain_pct) : null;
    const sec = section(t('How it did'));
    sec.append(el('div', { class: 'facts' },
      fact(t('Day one'), lg !== null ? pct(lg, 1) : '–', lst.close ? t('closed at ₹{c} (issue ₹{p})', { c: lst.close, p: i.issue_price }) : '', lg === null ? '' : lg > 0 ? 'good' : 'bad'),
      fact(t('We said before listing'), tr ? vlabel(tr.verdict_tier) : (s ? pct0(s.p_up) : '–'), tr ? t('{p} chance of a gain · saved {d}', { p: pct0(tr.p_up), d: tr.locked_at ? dshort(String(tr.locked_at).slice(0, 10)) : '–' }) + (tr.lock_stage === 'backfill' ? ' · ' + t('reconstructed') : '') : t('no saved call for this one'))));
    const hz = [['d1', '1 day'], ['w1', '1 week'], ['m1', '1 month'], ['m3', '3 months'], ['m6', '6 months']].filter(([k]) => fin(pl[k]));
    if (hz.length) {
      sec.append(el('div', { class: 'small ink2', text: t('Since listing, versus the issue price') }));
      sec.append(el('div', { class: 'perf' }, ...hz.map(([k, lab]) => el('div', { class: 'p' }, el('div', { class: 'l', text: t(lab) }), el('div', { class: 'v ' + (pl[k] > 0 ? 'good' : 'bad'), text: pct(pl[k], 0) })))));
      if (fin(pl.last_price)) sec.append(el('p', { class: 'tiny muted', text: t('Last price ₹{p} on {d}.', { p: pl.last_price, d: dshort(pl.as_of) }) }));
    }
    if (i.anchor && (isIso(i.anchor.lockin_50pct_date) || isIso(i.anchor.lockin_rest_date))) sec.append(note('info', t('Big investors who bought before the IPO (anchors) may sell from {a} (half) and {b} (rest). Prices often dip around these dates.', { a: dshort(i.anchor.lockin_50pct_date), b: dshort(i.anchor.lockin_rest_date) })));
    return sec;
  }
  function allotSection(i) {
    const reg = i.registrar || {};
    const sec = section(t('Did you get shares?'));
    sec.append(el('p', { class: 'small ink2', text: t('The allotment result is published by the registrar. Check with your PAN number. You can also see it in your broker app or bank statement.') }));
    const url = reg.status_url && /^https?:\/\//.test(reg.status_url) ? reg.status_url : null;
    const btns = el('div', { class: 'btn-row' });
    if (url) btns.append(el('a', { class: 'btn primary', href: url, target: '_blank', rel: 'noopener', onclick: (ev) => { if (has('openExternal')) { ev.preventDefault(); call('openExternal', url); } } }, icon('ext'), t('Check on {r}', { r: reg.name || t('registrar') })));
    btns.append(el('a', { class: 'btn', href: 'https://www.bseindia.com/investors/appli_check.aspx', target: '_blank', rel: 'noopener', onclick: (ev) => { if (has('openExternal')) { ev.preventDefault(); call('openExternal', ev.currentTarget.href); } } }, icon('ext'), t('Check on BSE')));
    sec.append(btns);
    if (!reg.name) sec.append(el('p', { class: 'tiny muted', text: t('Registrar not captured for this IPO; the exchange pages work for every issue.') }));
    return sec;
  }
  function moneySection(r, inv) {
    const s = r.score, i = r.eff, mid = netAt(inv, s.gain.p50), bad = netAt(inv, s.gain.p10);
    const sec = section(t('Your money, if you get shares'));
    sec.append(el('div', { class: 'money' },
      line(t('Money blocked when you apply'), inr(inv)),
      line(t('Sold on listing day at the likely gain ({g})', { g: pct(s.gain.p50, 0) }), inr(inv * (1 + s.gain.p50 / 100))),
      line(t('Profit before costs'), inr(mid.gross, { plus: true })),
      line(el('span', null, termBtn('charges', t('Broker & exchange charges')), ' ', el('span', { class: 'muted', text: '(' + (BROKERS[PLAN.broker] || BROKERS.custom).name + ')' })), '−' + inr(mid.charges)),
      line(termBtn('tax', t('Tax on the profit')), '−' + inr(mid.tax)),
      line(t('In your hand'), inr(mid.net, { plus: true }), 'total ' + (mid.net >= 0 ? 'good' : 'bad')),
      line(t('On a bad day ({g})', { g: pct(s.gain.p10, 0) }), inr(bad.net, { plus: true }))));
    sec.append(el('p', { class: 'tiny muted', text: t('If you get no shares, the full amount is unblocked within a few days and you lose nothing. Change your broker in the Planner.') }));
    return sec;
  }
  function demandSection(r) {
    const i = r.eff, sub = i.subscription || {}, sec = section(t('Demand: how many times over people bid'));
    const rows = [['qib', t('Big institutions'), 'qib'], ['nii', t('Wealthy investors'), 'nii'], ['retail', i.board === 'sme' ? t('Individuals (you)') : t('Retail (you)'), 'retail'], ['total', t('Overall'), 'sub']];
    const any = rows.some(([k]) => fin(sub[k]));
    if (!any) { sec.append(el('p', { class: 'muted', text: r.st === 'upcoming' ? t('Bidding has not started. Demand figures appear from the first bidding day.') : t('No demand figures captured yet.') })); return sec; }
    const max = Math.max(10, ...rows.map(([k]) => Number(sub[k]) || 0));
    const sc = v => Math.min(100, 100 * Math.log1p(v) / Math.log1p(max));
    const bars = el('div', { class: 'bars' });
    for (const [k, lab, term] of rows) {
      const v = fin(sub[k]) ? Number(sub[k]) : null;
      bars.append(el('div', { class: 'bar-row' }, termBtn(term, lab), el('div', { class: 'track' }, el('i', { class: v !== null && v < 1 ? 'lo' : '', style: 'width:' + (v === null ? 0 : Math.max(2, sc(v))) + '%' })), el('span', { class: 'v', text: xm(v) })));
    }
    sec.append(bars);
    sec.append(el('p', { class: 'tiny muted', text: (r.st === 'open' ? t('Bidding is still on; big institutions usually bid on the last day.') : t('Final figures after bidding closed.')) + ' ' + t('“10x” means people asked for ten times the shares on offer.') }));
    return sec;
  }
  function gmpSection(r, g) {
    const i = r.eff, gm = i.gmp || {}, sec = section(t('Grey-market premium (unofficial)'));
    sec.append(el('p', { class: 'small ink2' }, t('What unofficial dealers pay over the issue price before listing.'), ' ', termBtn('gmp', t('Read the caveats'))));
    if (g === null) { sec.append(el('p', { class: 'muted', text: r.score && r.score.flags.includes('gmp_unquoted') ? t('Nobody is quoting a premium for this IPO.') : t('No premium quote yet.') })); return sec; }
    sec.append(el('div', { class: 'facts' }, fact(t('Premium now'), pct(g, 1), fin(gm.rs) ? t('₹{r} a share', { r: gm.rs }) + (gm.as_of ? ' · ' + dshort(gm.as_of) : '') : '', g > 0 ? 'good' : 'bad'), fact(t('Implied listing price'), fin(gm.rs) && i.issue_price ? '₹' + (Number(i.issue_price) + Number(gm.rs)) : '–', t('if the premium holds'))));
    const hist = S.gmpHistoryOf(i);
    if (hist.length >= 2) sec.append(el('div', null, el('div', { class: 'small ink2', text: t('Premium over the last {n} quotes', { n: Math.min(12, hist.length) }) }), sparkline(hist.slice(-12))));
    const srcs = Array.isArray(gm.sources) ? gm.sources.filter(x => x && fin(x.rs)) : [];
    if (srcs.length > 1) {
      sec.append(el('div', { class: 'small ink2', text: t('Quotes from {n} sources (we use the middle one)', { n: srcs.length }) }));
      sec.append(el('div', { class: 'src' }, ...srcs.map(x => el('div', { class: 'ln' }, el('span', { text: String(x.source || '').replace(/^www\./, '') }), el('span', { class: 'num', text: '₹' + x.rs + (x.as_of ? ' · ' + dshort(x.as_of) : '') })))));
    }
    return sec;
  }
  function sparkline(hist) {
    const W = 320, H = 56, vals = hist.map(h => h.rs), lo = Math.min(0, ...vals), hi = Math.max(1, ...vals);
    const sx = k => 4 + k * (W - 8) / Math.max(1, hist.length - 1), sy = v => H - 6 - (v - lo) * (H - 12) / (hi - lo || 1);
    const d = vals.map((v, k) => (k ? 'L' : 'M') + sx(k).toFixed(1) + ' ' + sy(v).toFixed(1)).join(' ');
    return svgEl('svg', { class: 'spark', viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none', role: 'img', 'aria-label': t('Premium went from ₹{a} to ₹{b}', { a: vals[0], b: vals[vals.length - 1] }) },
      lo < 0 ? svgEl('line', { x1: 0, x2: W, y1: sy(0), y2: sy(0), stroke: 'var(--axis)', 'stroke-dasharray': '3 3' }) : null,
      svgEl('path', { d, fill: 'none', stroke: 'var(--brand)', 'stroke-width': 2.5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'vector-effect': 'non-scaling-stroke' }),
      svgEl('circle', { cx: sx(vals.length - 1), cy: sy(vals[vals.length - 1]), r: 4, fill: 'var(--brand)' }));
  }
  function issueSection(r) {
    const i = r.eff, sec = section(t('About the issue')), m = el('div', { class: 'money' });
    const cr = v => (fin(v) ? '₹' + Number(v).toLocaleString('en-IN', { maximumFractionDigits: 0 }) + ' ' + t('cr') : null);
    if (i.price_band_low && i.price_band_high && i.price_band_low !== i.price_band_high) m.append(line(t('Price band'), '₹' + i.price_band_low + ' – ₹' + i.price_band_high));
    if (i.issue_price) m.append(line(t('Issue price'), '₹' + i.issue_price));
    if (i.lot_size) m.append(line(termBtn('lot', t('Lot size')), i.lot_size + ' ' + t('shares')));
    if (cr(i.issue_size_cr)) m.append(line(t('Total issue size'), cr(i.issue_size_cr)));
    if (cr(i.fresh_issue_cr)) m.append(line(termBtn('fresh', t('New money for the company')), cr(i.fresh_issue_cr)));
    if (cr(i.ofs_cr)) m.append(line(termBtn('ofs', t('Existing owners selling')), cr(i.ofs_cr)));
    if (i.anchor && cr(i.anchor.amount_cr)) m.append(line(termBtn('anchor', t('Raised from anchor investors')), cr(i.anchor.amount_cr)));
    if (i.anchor && isIso(i.anchor.lockin_50pct_date)) m.append(line(t('Anchor lock-in ends (half / rest)'), dshort(i.anchor.lockin_50pct_date) + ' / ' + dshort(i.anchor.lockin_rest_date)));
    if (i.face_value) m.append(line(t('Face value'), '₹' + i.face_value));
    if (i.registrar && i.registrar.name) m.append(line(t('Registrar'), i.registrar.name));
    if (!m.children.length) m.append(el('p', { class: 'muted', text: t('Details not captured yet.') }));
    sec.append(m);
    return sec;
  }
  function whatIfSection(r) {
    const i = r.ipo, sub = i.subscription || {}, e = UI.edits[i.id] || {};
    const det = el('details', { class: 'more' }, el('summary', null, t('Try your own numbers')));
    const box = el('div', { class: 'stack', style: 'margin-top:10px' });
    box.append(el('p', { class: 'small ink2', text: t('Heard a newer premium, or the latest demand figures? Type them and everything above updates. Only on this phone.') }));
    const inp = (k, lab, v) => { const n = el('input', { type: 'number', inputmode: 'decimal', step: 'any', value: fin(v) ? String(v) : '', placeholder: '–' }); return [n, el('label', { class: 'field' }, lab, n)]; };
    const [iG, lG] = inp('gmp', t('Premium ₹ per share'), e.gmp_rs !== undefined ? e.gmp_rs : (i.gmp && i.gmp.rs));
    const [iQ, lQ] = inp('qib', t('Institutions (x)'), e.qib !== undefined ? e.qib : sub.qib);
    const [iN, lN] = inp('nii', t('Wealthy (x)'), e.nii !== undefined ? e.nii : sub.nii);
    const [iR, lR] = inp('retail', t('Retail (x)'), e.retail !== undefined ? e.retail : sub.retail);
    box.append(el('div', { class: 'whatif' }, lG, lQ, lN, lR));
    const num = n => (n.value === '' ? undefined : Number(n.value));
    const differs = (v, o) => v !== undefined && !(fin(o) && Number(o) === v);
    box.append(el('div', { class: 'btn-row' },
      el('button', { type: 'button', class: 'btn primary', onclick: () => { const ed = {}; const sg = i.gmp || {}; if (differs(num(iG), sg.rs)) ed.gmp_rs = num(iG); if (differs(num(iQ), sub.qib)) ed.qib = num(iQ); if (differs(num(iN), sub.nii)) ed.nii = num(iN); if (differs(num(iR), sub.retail)) ed.retail = num(iR); if (Object.keys(ed).length) UI.edits[i.id] = ed; else delete UI.edits[i.id]; computeAll(); renderIpo(); toast(t('Updated with your numbers')); } }, t('Recalculate')),
      UI.edits[i.id] ? el('button', { type: 'button', class: 'btn', onclick: () => { delete UI.edits[i.id]; computeAll(); renderIpo(); } }, t('Reset')) : null));
    if (UI.edits[i.id]) det.open = true;
    det.append(box);
    return el('div', { class: 'card' }, det);
  }
  function sourcesSection(i) {
    const srcs = i.sources || {}, seen = new Map();
    for (const k of Object.keys(srcs)) { try { const u = new URL(String(srcs[k])); if (/^https?:$/.test(u.protocol)) { const hn = u.hostname.replace(/^www\./, ''); if (!seen.has(hn)) seen.set(hn, u.href); } } catch (e) { /* not a URL */ } }
    const gm = (i.gmp && Array.isArray(i.gmp.sources)) ? i.gmp.sources : [];
    for (const x of gm) { try { if (x.url) { const u = new URL(x.url); const hn = u.hostname.replace(/^www\./, ''); if (!seen.has(hn)) seen.set(hn, u.href); } } catch (e) { /* ignore */ } }
    const sec = section(t('Where these numbers come from'));
    if (!seen.size) { sec.append(el('p', { class: 'muted small', text: t('Exchange filings and public IPO trackers.') })); return sec; }
    const row = el('div', { class: 'btn-row' });
    for (const [hn, href] of seen) row.append(el('a', { class: 'btn sm', href, target: '_blank', rel: 'noopener', onclick: (ev) => { if (has('openExternal')) { ev.preventDefault(); call('openExternal', href); } } }, icon('ext'), hn));
    sec.append(row);
    sec.append(el('p', { class: 'tiny muted', text: t('Data as of {d}. Something looks wrong? Tell us from More → Get help.', { d: D.live.generated_at ? new Date(D.live.generated_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '–' }) }));
    return sec;
  }
  function toggleWatch(id) {
    if (WATCH.has(id)) { WATCH.delete(id); toast(t('Removed from your watchlist')); }
    else { WATCH.add(id); toast(has('setWatchlist') ? t('Added. We will remind you before bidding closes.') : t('Added to your watchlist')); }
    const ids = [...WATCH]; store('watch', ids); call('setWatchlist', JSON.stringify(ids));
  }

  // ------------------------------------------------------------- planner ---
  function stepper(value, min, max, onChange, label) {
    const inp = el('input', { type: 'number', inputmode: 'numeric', min, max, value: String(value), 'aria-label': label });
    const set = (v) => { v = Math.min(max, Math.max(min, Math.round(Number(v) || min))); inp.value = String(v); onChange(v); };
    inp.addEventListener('change', () => set(inp.value));
    return el('div', { class: 'stepper' }, el('button', { type: 'button', 'aria-label': t('Fewer'), onclick: () => set(Number(inp.value) - 1) }, '−'), inp, el('button', { type: 'button', 'aria-label': t('More'), onclick: () => set(Number(inp.value) + 1) }, '+'));
  }
  function moneyInput(value, onChange, label) {
    const inp = el('input', { type: 'number', inputmode: 'numeric', min: 0, step: 1000, value: String(value), 'aria-label': label });
    inp.addEventListener('input', () => { if (inp.value !== '') onChange(Math.max(0, Number(inp.value) || 0)); });
    return inp;
  }
  function savePlan() { store('plan', PLAN); }
  function renderPlan() {
    const host = $('#screen-plan'); host.replaceChildren();
    host.append(el('div', { class: 'hello' }, el('h1', { text: t('Planner') }), el('p', { class: 'lede', text: t('How much can IPOs realistically make you? Tell us your budget and how many demat accounts your family can apply from.') })));
    const inputs = el('div', { class: 'card stack' });
    inputs.append(el('div', { class: 'whatif' },
      el('label', { class: 'field' }, t('Money you can keep blocked (₹)'), moneyInput(PLAN.capital, v => { PLAN.capital = v; savePlan(); renderPlanResult(); }, t('Money you can keep blocked'))),
      el('label', { class: 'field' }, t('Monthly target (₹)'), moneyInput(PLAN.target, v => { PLAN.target = v; savePlan(); renderPlanResult(); }, t('Monthly target'))),
      el('div', { class: 'field' }, el('span', null, t('Demat accounts'), ' ', el('span', { class: 'hint', text: t('(yours + family, each with its own PAN)') })), stepper(PLAN.accounts, 1, 10, v => { PLAN.accounts = v; savePlan(); renderPlanResult(); }, t('Demat accounts'))),
      el('div', { class: 'field' }, t('Your broker'), el('button', { type: 'button', class: 'btn', style: 'justify-content:space-between', onclick: () => pickSheet(t('Your broker'), Object.keys(BROKERS).map(k => [k, BROKERS[k].name === 'Custom' ? t('Custom charges') : BROKERS[k].name]), PLAN.broker, (v) => { PLAN.broker = v; COSTS = costsFor(v); savePlan(); computeAll(); renderPlan(); }) }, (BROKERS[PLAN.broker] || BROKERS.custom).name, icon('chev')))));
    inputs.append(costsEditor());
    host.append(inputs);
    host.append(el('div', { id: 'plan-result', class: 'stack-lg' }));
    renderPlanResult();
    host.append(footer());
  }
  function costsEditor() {
    const det = el('details', { class: 'more' }, el('summary', null, t('Charges and tax used (edit if yours differ)')));
    const grid = el('div', { class: 'whatif', style: 'margin-top:10px' });
    const fields = [['brokerage_pct', 'Brokerage %'], ['brokerage_min', 'Brokerage min ₹'], ['brokerage_cap', 'Brokerage cap ₹'], ['dp_charge', 'DP charge ₹'], ['stt_pct', 'STT %'], ['stcg_tax_pct', 'Short-term gains tax %'], ['cess_pct', 'Cess on tax %']];
    for (const [k, lab] of fields) {
      const n = el('input', { type: 'number', inputmode: 'decimal', step: 'any', min: 0, value: String(COSTS[k]) });
      n.addEventListener('change', () => { COSTS[k] = Number(n.value) || 0; PLAN.broker = 'custom'; savePlan(); const cc = {}; for (const [kk] of fields) cc[kk] = COSTS[kk]; store('customCosts', cc); computeAll(); renderPlanResult(); });
      grid.append(el('label', { class: 'field' }, t(lab), n));
    }
    det.append(grid, el('p', { class: 'tiny muted', style: 'margin-top:8px', text: t('Your inputs stay on this phone.') }));
    return det;
  }
  function renderPlanResult() {
    const out = $('#plan-result'); if (!out) return; out.replaceChildren();
    const cands = SCORED.filter(r => r.score && isLive(r) && fin(r.score.p_up) && r.eff.issue_price && r.eff.lot_size);
    if (!cands.length) { out.append(el('div', { class: 'card empty' }, icon('calc'), el('div', { text: t('Nothing open or upcoming has enough information to plan with right now. Check back when the next IPO opens.') }))); return; }
    if (PLAN.picked === null) PLAN.picked = cands.filter(r => ['apply', 'lean'].includes(tierOf(r))).map(r => r.ipo.id);
    const picked = new Set(PLAN.picked), acc = PLAN.accounts;
    let total = 0, block = 0, pNone = 1, gross = 0, cost = 0, unknown = false, posEv = 0, posBlock = 0;
    const rows = cands.sort(rankLive).map(r => {
      const s = r.score, inv = s.ev.invested_if_allotted || minInvest(r);
      const pa = s.allotment && fin(s.allotment.p_min_lot) ? s.allotment.p_min_lot : null;
      const evIf = fin(s.ev.ev_if_allotted) ? s.ev.ev_if_allotted : netAt(inv, s.gain.mean).net;
      const ev1 = pa === null ? null : pa * evIf, on = picked.has(r.ipo.id);
      if (on) {
        block += inv * acc;
        if (ev1 === null) unknown = true; else { total += ev1 * acc; pNone *= Math.pow(1 - pa, acc); if (ev1 > 0) { posEv += ev1 * acc; posBlock += inv * acc; } }
        const res = netAt(inv, s.gain.mean); gross += res.gross * acc; cost += (res.charges + res.tax) * acc;
      }
      return { r, inv, pa, evIf, ev1, on };
    });
    const hero = el('div', { class: 'card plan-hero' });
    hero.append(el('div', { class: 'small ink2', text: t('Expected profit from the ticked IPOs, across {n} account(s), after charges and tax', { n: acc }) }));
    hero.append(el('div', { class: 'big num ' + (total >= 0 ? 'good' : 'bad'), text: inr(total, { plus: true }) }));
    if (PLAN.target > 0) {
      const share = Math.max(0, Math.min(1, total / PLAN.target));
      hero.append(el('div', { class: 'meter', role: 'img', 'aria-label': t('{p} of your target', { p: Math.round(share * 100) + '%' }) }, el('i', { style: 'width:' + Math.max(2, share * 100) + '%' })));
      hero.append(el('div', { class: 'small ink2', text: total >= PLAN.target ? t('On paper, this covers your {t} target.', { t: inr(PLAN.target) }) : t('That is {p} of your {t} monthly target.', { p: Math.round(share * 100) + '%', t: inr(PLAN.target) }) }));
    }
    out.append(hero);
    const facts = [];
    facts.push(note(block > PLAN.capital ? 'warn' : 'info', t('Money blocked at once: {b}', { b: inr(block) }), block > PLAN.capital ? ' ' + t('— more than the {c} you set. Untick some IPOs or use fewer accounts.', { c: inr(PLAN.capital) }) : ' ' + t('of your {c}.', { c: inr(PLAN.capital) })));
    if (!unknown && block > 0) facts.push(note('info', t('Chance that none of these applications gets any shares: {p}. Profits come in lumps, not every month.', { p: pct0(pNone) })));
    if (unknown) facts.push(note('info', t('Some ticked IPOs have no retail demand figures yet, so their lottery odds (and profit) are not counted.')));
    const need = posEv > 0 ? PLAN.target / (posEv / Math.max(1, posBlock)) : null;
    if (need && isFinite(need) && PLAN.target > total) facts.push(note('info', t('At these odds you would need about {n} blocked per round to expect {t}. The share lottery, not the premium, sets the limit; more family accounts help most.', { n: inrShort(need), t: inr(PLAN.target) })));
    if (cost > 0) facts.push(el('p', { class: 'tiny muted', text: t('If every application got shares, charges and tax would take {c} out of {g} profit. All figures above are after that.', { c: inr(cost), g: inr(gross, { plus: true }) }) }));
    out.append(el('div', { class: 'stack' }, ...facts));
    const list = el('div', { class: 'pick-list' });
    for (const q of rows) {
      const cb = el('input', { type: 'checkbox', 'aria-label': t('Include {n}', { n: q.r.eff.name }) }); cb.checked = q.on;
      cb.addEventListener('change', () => { const set = new Set(PLAN.picked); if (cb.checked) set.add(q.r.ipo.id); else set.delete(q.r.ipo.id); PLAN.picked = [...set]; savePlan(); renderPlanResult(); });
      const pAny = q.pa === null ? null : 1 - Math.pow(1 - q.pa, acc);
      list.append(el('label', { class: 'pick-row' }, cb,
        el('div', { class: 'grow' }, el('div', { class: 'n' }, q.r.eff.name, ' ', verdictPill(tierOf(q.r))), el('div', { class: 's', text: [inrShort(q.inv * acc) + ' ' + t('blocked'), q.pa === null ? t('odds not known yet') : t('{p} chance at least one account gets shares', { p: pct0(pAny) }), t('{v} if you get shares', { v: inr(q.evIf, { plus: true }) })].join(' · ') })),
        el('div', { class: 'v ' + (q.ev1 === null ? '' : q.ev1 > 0 ? 'good' : 'bad') }, q.ev1 === null ? '?' : inr(q.ev1 * acc, { plus: true }), el('small', null, t('expected')))));
    }
    out.append(el('div', { class: 'sec' }, el('div', { class: 'sec-h' }, el('h2', { text: t('Choose IPOs') })), el('p', { class: 'sec-sub', text: t('One minimum application per account per IPO. Bidding for more lots does not improve your odds in a popular IPO.') }), list));
  }

  // ------------------------------------------------------------- journal ---
  function journalFor(id) { return JOURNAL.find(e => e.id === id) || null; }
  function saveJournal() { store('journal', JOURNAL); }
  function entryProfit(e) {
    if (!(e.allotted > 0) || !e.price || !e.lot) return { profit: 0, known: e.allotted === 0, est: false };
    const r = BYID.get(e.id), lst = r && r.eff.listing;
    const sell = fin(e.sell) ? Number(e.sell) : (lst && fin(lst.close) ? Number(lst.close) : null);
    if (sell === null) return { profit: null, known: false, est: false };
    const inv = e.price * e.lot * (e.minLots || 1);
    return { profit: S.netProfitOnSale(inv, inv * sell / e.price, COSTS).net * e.allotted, known: true, est: !fin(e.sell) };
  }
  function journalSheet(id) {
    const r = BYID.get(id); if (!r) return;
    const i = r.eff, cur = journalFor(id) || { id, name: i.name, board: i.board, price: i.issue_price || i.price_band_high, lot: i.lot_size, minLots: Number(i.min_lots) || (i.board === 'sme' ? 2 : 1), accounts: 1, allotted: null, sell: null, at: TODAY };
    const draft = Object.assign({}, cur);
    const allotBox = el('div');
    const drawAllot = () => {
      allotBox.replaceChildren();
      if (r.st === 'open' || r.st === 'upcoming') { allotBox.append(el('p', { class: 'small muted', text: t('Come back after the allotment result to record whether you got shares.') })); return; }
      allotBox.append(el('div', { class: 'field' }, t('How many accounts got shares?'), stepper(fin(draft.allotted) ? draft.allotted : 0, 0, draft.accounts, v => { draft.allotted = v; }, t('Accounts that got shares'))));
      const sell = el('input', { type: 'number', inputmode: 'decimal', step: 'any', value: fin(draft.sell) ? String(draft.sell) : '', placeholder: i.listing && fin(i.listing.close) ? t('listing close ₹{c}', { c: i.listing.close }) : '₹' });
      sell.addEventListener('input', () => { draft.sell = sell.value === '' ? null : Number(sell.value); });
      allotBox.append(el('label', { class: 'field' }, t('Price you sold at (per share)'), sell, el('span', { class: 'hint', text: t('Leave empty to use the listing-day close.') })));
    };
    drawAllot();
    const body = [
      el('p', { class: 'small', text: t('Keep a private record of your IPO applications and see what you really made. Saved only on this phone.') }),
      el('div', { class: 'field' }, t('How many accounts did you apply from?'), stepper(draft.accounts, 1, 10, v => { draft.accounts = v; if (fin(draft.allotted) && draft.allotted > v) draft.allotted = v; drawAllot(); }, t('Accounts applied'))),
      allotBox,
      el('div', { class: 'btn-row' },
        el('button', { type: 'button', class: 'btn primary', onclick: () => { JOURNAL = JOURNAL.filter(e => e.id !== id); if (!(r.st === 'open' || r.st === 'upcoming') && !fin(draft.allotted)) draft.allotted = 0; JOURNAL.unshift(draft); saveJournal(); closeSheet(); toast(t('Saved to My IPOs')); if (UI.tab === 'ipo') renderIpo(); else if (UI.tab === 'more') renderMore(); } }, t('Save')),
        journalFor(id) ? el('button', { type: 'button', class: 'btn', onclick: () => { JOURNAL = JOURNAL.filter(e => e.id !== id); saveJournal(); closeSheet(); toast(t('Removed')); if (UI.tab === 'ipo') renderIpo(); else if (UI.tab === 'more') renderMore(); } }, icon('trash'), t('Remove')) : null),
    ];
    openSheet(i.name, body);
  }
  function journalBlock() {
    const sec = el('div', { class: 'sec' }, el('div', { class: 'sec-h' }, el('h2', { text: t('My IPOs') })));
    if (!JOURNAL.length) { sec.append(el('div', { class: 'card empty' }, icon('wallet'), el('div', { text: t('Record the IPOs you apply for (open any IPO → I applied) and see your real hit rate and profit here.') }))); return sec; }
    let apps = 0, got = 0, done = 0, profit = 0, est = false;
    for (const e of JOURNAL) { apps += e.accounts || 1; if (fin(e.allotted)) { done += e.accounts || 1; got += e.allotted; } const p = entryProfit(e); if (fin(p.profit)) profit += p.profit; if (p.est) est = true; }
    sec.append(el('div', { class: 'journal-sum' },
      el('div', { class: 'stat' }, el('div', { class: 'v num', text: String(apps) }), el('div', { class: 'l', text: t('Applications') })),
      el('div', { class: 'stat' }, el('div', { class: 'v num', text: done ? Math.round(100 * got / done) + '%' : '–' }), el('div', { class: 'l', text: t('Got shares') })),
      el('div', { class: 'stat' }, el('div', { class: 'v num ' + (profit >= 0 ? 'good' : 'bad'), text: inrShort(profit) }), el('div', { class: 'l', text: t('Profit after costs') + (est ? '*' : '') }))));
    const list = el('div', { class: 'list' });
    for (const e of JOURNAL) {
      const p = entryProfit(e);
      list.append(el('button', { type: 'button', class: 'list-row', onclick: () => (BYID.has(e.id) ? journalSheet(e.id) : null) }, el('span', { class: 'ico' }, icon('wallet')),
        el('div', { class: 'grow' }, el('div', { class: 't', text: e.name }), el('div', { class: 's', text: t('{a} account(s)', { a: e.accounts }) + ' · ' + (fin(e.allotted) ? t('{g} got shares', { g: e.allotted }) : t('result pending')) })),
        el('span', { class: 'end num ' + (fin(p.profit) && p.profit !== 0 ? (p.profit > 0 ? 'good' : 'bad') : '') }, fin(p.profit) ? inr(p.profit, { plus: true }) : '–')));
    }
    sec.append(list);
    if (est) sec.append(el('p', { class: 'tiny muted', text: t('* Where you did not enter a sale price, the listing-day close is used.') }));
    return sec;
  }

  // --------------------------------------------------------------- proof ---
  const REPO = 'https://github.com/vysakhsuresh/ipo-radar';
  function extLink(href, label, cls) { return el('a', { class: cls || 'btn sm', href, target: '_blank', rel: 'noopener', onclick: (ev) => { if (has('openExternal')) { ev.preventDefault(); call('openExternal', href); } } }, icon('ext'), label); }
  function renderProof() {
    const host = $('#screen-proof'); host.replaceChildren();
    host.append(el('div', { class: 'hello' }, el('h1', { text: t('Track record') }), el('p', { class: 'lede', text: t('Every call is saved when bidding closes, before anyone knows the result, and checked after listing. Nothing is edited later, so you can judge us on our record.') })));
    const tk = D.track;
    const rows = tk && Array.isArray(tk.rows) ? tk.rows.filter(x => fin(x.actual_gain_pct) || x.listed_up !== undefined) : [];
    if (tk && rows.length) {
      const bv = tk.by_verdict || {}, a = bv.apply || {}, l = bv.lean || {};
      const n = (a.n || 0) + (l.n || 0), up = (a.n_up || 0) + (l.n_up || 0);
      const hero = el('div', { class: 'card proof-hero' });
      const live = tk.n_locked || 0;
      hero.append(el('span', { class: 'seal' }, icon('lock'), live ? t('Saved before listing · never edited') : t('Back-test on past IPOs')));
      hero.append(el('div', { class: 'big num', text: n ? Math.round(100 * up / n) + '%' : '–' }));
      hero.append(el('p', null, t('When we said'), ' ', el('b', null, t('Apply')), ' ', t('or'), ' ', el('b', null, t('Leaning yes')), ', ', el('b', null, t('{u} of {n}', { u: up, n })), ' ', t('IPOs listed above their issue price.'), fin(tk.base_rate) ? ' ' + t('Across all IPOs in the same period, {b} did.', { b: pct0(tk.base_rate) }) : ''));
      if (tk.n_backfill && !live) hero.append(el('p', { class: 'tiny', text: t('These {b} calls were worked out afterwards, from the numbers known before each IPO listed. The model learned from these same IPOs, so real results will likely be a little worse. Live calls, saved before listing and never edited, start from {d}.', { b: tk.n_backfill, d: dshort(tk.started) }) }));
      else if (tk.n_backfill) hero.append(el('p', { class: 'tiny', text: t('{a} calls were saved live; {b} older ones were reconstructed from the data we had before they listed and are marked as such.', { a: live, b: tk.n_backfill }) }));
      host.append(hero);
      const vb = el('div', { class: 'vbars' });
      for (const tier of ['apply', 'lean', 'coinflip', 'watch', 'avoid']) {
        const v = bv[tier]; if (!v || !v.n) continue;
        const upP = v.n_up / v.n;
        vb.append(el('div', { class: 'vbar' }, el('div', { class: 'h' }, verdictPill(tier), el('span', { class: 'small ink2' }, t('{u} of {n} listed up', { u: v.n_up, n: v.n }), fin(v.median_gain) ? ' · ' + t('typical {g}', { g: pct(v.median_gain, 0) }) : '')),
          el('div', { class: 'track', role: 'img', 'aria-label': pct0(upP) }, el('i', { class: 'up', style: 'width:' + (upP * 100) + '%' }), el('i', { class: 'dn', style: 'width:' + ((1 - upP) * 100) + '%' }))));
      }
      host.append(el('div', { class: 'card stack' }, el('h3', { text: t('How each label turned out') }), el('p', { class: 'small ink2', text: t('Green: listed above the issue price. Red: at or below. A good label system shows mostly green at the top and more red at the bottom.') }), vb));
      const checks = [];
      if (fin(tk.brier) && fin(tk.brier_gmp_only)) checks.push(note(tk.brier <= tk.brier_gmp_only ? 'good' : 'warn', tk.brier <= tk.brier_gmp_only ? t('Our chances were more accurate than going by the grey-market premium alone.') : t('Our chances were not yet more accurate than going by the grey-market premium alone. We show this because hiding it would be dishonest.'), el('span', { class: 'tiny muted', style: 'display:block', text: t('Accuracy score (lower is better): ours {a}, premium-only {b}.', { a: tk.brier.toFixed(3), b: tk.brier_gmp_only.toFixed(3) }) })));
      if (fin(tk.range_coverage)) checks.push(note('info', t('{p} of actual listing gains landed inside our “likely range”. The range is built to catch about 8 in 10.', { p: pct0(tk.range_coverage) })));
      if (checks.length) host.append(el('div', { class: 'stack' }, ...checks));
      if (Array.isArray(tk.calibration) && tk.calibration.length) host.append(el('div', { class: 'card chart' }, relChart(tk.calibration.map(b => ({ pred: b.pred_mean, obs: b.obs_rate, n: b.n })))));
      host.append(ledgerCard(rows));
    } else {
      host.append(el('div', { class: 'card proof-hero' }, el('span', { class: 'seal' }, icon('lock'), t('Saved before listing · never edited')), el('p', null, t('The public record of our calls starts building as IPOs close and list. Until it has enough entries, the evidence below (how past IPOs actually listed) is the best check.'))));
    }
    host.append(modelCard());
    const exp = el('details', { class: 'card more' }, el('summary', null, t('For the curious: the raw evidence')));
    const box = el('div', { class: 'stack-lg', style: 'margin-top:12px' });
    box.append(chartGmp(), bucketTable(), coefTable());
    exp.append(box);
    host.append(exp);
    host.append(el('div', { class: 'btn-row' }, extLink(REPO + '/blob/main/data/predictions.json', t('Every saved call (raw file)')), extLink(REPO + '/commits/main/data/predictions.json', t('Change history'))));
    host.append(footer());
  }
  function ledgerCard(rows) {
    const card = el('div', { class: 'card stack' }, el('div', { class: 'sec-h' }, el('h3', { text: t('Every call, newest first') })));
    const seg = el('div', { class: 'seg', role: 'group' });
    for (const [k, lab] of [['locked', 'Saved live'], ['all', 'Include reconstructed']]) seg.append(el('button', { type: 'button', 'aria-pressed': UI.ledger === k ? 'true' : 'false', onclick: () => { UI.ledger = k; const y = window.scrollY; renderProof(); window.scrollTo(0, y); } }, t(lab)));
    if (rows.some(x => x.lock_stage === 'backfill')) card.append(seg);
    let shown = rows.filter(x => UI.ledger === 'all' || x.lock_stage !== 'backfill');
    if (!shown.length) shown = rows;
    const list = el('div', { class: 'ledger' });
    const draw = (lim) => {
      list.replaceChildren();
      for (const x of shown.slice(0, lim)) {
        const up = x.listed_up === true || (fin(x.actual_gain_pct) && x.actual_gain_pct > 0);
        const said = x.verdict_tier === 'apply' || x.verdict_tier === 'lean' ? 'yes' : x.verdict_tier === 'avoid' ? 'no' : 'mid';
        const right = said === 'mid' ? 'm' : (said === 'yes') === up ? 'y' : 'n';
        list.append(el('div', { class: 'ln' },
          el('div', { style: 'min-width:0' }, el('div', { class: 'n', text: x.name }), el('div', { class: 's' }, (x.board === 'sme' ? t('SME') + ' · ' : '') + dshort(x.listing_date) + ' · ' + t('we said') + ' ', el('b', null, vlabel(x.verdict_tier)), fin(x.p_up) ? ' (' + pct0(x.p_up) + ')' : '', x.lock_stage === 'backfill' ? ' · ' + t('reconstructed') : '')),
          el('span', { class: 'res ' + (up ? 'good' : 'bad'), text: fin(x.actual_gain_pct) ? pct(x.actual_gain_pct, 1) : '–' }),
          el('span', { class: 'ok ' + right, title: right === 'y' ? t('Our call was right') : right === 'n' ? t('Our call was wrong') : t('We called it a toss-up') }, icon(right === 'y' ? 'check' : right === 'n' ? 'x' : 'minus'))));
      }
    };
    draw(25);
    card.append(list);
    if (shown.length > 25) { const more = el('button', { type: 'button', class: 'btn sm', onclick: () => { draw(shown.length); more.remove(); } }, t('Show all {n}', { n: shown.length })); card.append(more); }
    card.append(el('p', { class: 'tiny muted', text: t('✓ the call was right (said yes and it listed up, or said avoid and it did not), ✗ wrong, – a 50-50 or too-early call.') }));
    return card;
  }
  function modelCard() {
    const P = D.params, card = el('div', { class: 'card stack' }, el('h3', { text: t('How the chances are worked out') }));
    card.append(el('p', { class: 'small ink2', text: t('A statistical model learns from past Indian listings how the grey-market premium, demand from each investor group, the issue size and the market mood turned into first-day results, then applies that to each new IPO.') }));
    if (!P) return card;
    if (P.status === 'calibrated' && P.metrics) {
      card.append(note('good', t('Fitted on {n} past listings and tested on IPOs it had not seen: it put a winner ahead of a loser {a} of the time (50% would be a coin toss).', { n: P.n_rows, a: Math.round(P.metrics.auc * 100) + '%' })));
      if (P.metrics.reliability && P.metrics.reliability.length) card.append(el('div', { class: 'chart' }, relChart(P.metrics.reliability)));
    } else {
      card.append(note('info', t('Still on documented starting weights: it needs {m} past listings with full figures to fit itself and has {n}. Until then, treat every chance as a first estimate.', { m: P.min_rows_to_calibrate || 120, n: P.n_rows_gating || 0 })));
    }
    card.append(el('button', { type: 'button', class: 'btn sm', style: 'justify-self:start', onclick: methodSheet }, icon('book'), t('Read the full method')));
    return card;
  }
  // charts --------------------------------------------------------------
  const tip = () => $('#tip');
  function showTip(evt, lines) { const tp = tip(); tp.replaceChildren(); lines.forEach((l, k) => tp.append(k ? el('div', { text: l }) : el('b', { text: l }))); tp.hidden = false; tp.style.left = Math.min(evt.clientX + 12, window.innerWidth - 250) + 'px'; tp.style.top = Math.min(evt.clientY + 12, window.innerHeight - 90) + 'px'; }
  function hideTip() { tip().hidden = true; }
  function axisText(x, y, s, anchor, extra) { return svgEl('text', Object.assign({ x, y, 'text-anchor': anchor || 'middle', 'font-size': 12, fill: 'var(--muted)', 'font-family': 'var(--mono)' }, extra || {}), s); }
  function relChart(bins) {
    const wrap = el('div', { class: 'chart' }, el('h3', { text: t('When we say 70%, does it happen 7 times in 10?') }), el('p', { class: 'small ink2', text: t('Dots on the dashed line mean the chances are honest. Above the line we were too cautious, below it too hopeful. Bigger dots hold more IPOs.') }));
    const W = 520, H = 330, m = { t: 12, r: 14, b: 40, l: 46 };
    const sx = v => m.l + v * (W - m.l - m.r), sy = v => H - m.b - v * (H - m.t - m.b);
    const svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': t('Predicted chance against how often IPOs actually listed up') });
    for (let v = 0; v <= 1.0001; v += 0.2) { svg.append(svgEl('line', { x1: m.l, x2: W - m.r, y1: sy(v), y2: sy(v), stroke: 'var(--grid)' })); svg.append(axisText(m.l - 6, sy(v) + 4, Math.round(v * 100) + '%', 'end')); svg.append(axisText(sx(v), H - m.b + 18, Math.round(v * 100) + '%')); }
    svg.append(svgEl('line', { x1: sx(0), y1: sy(0), x2: sx(1), y2: sy(1), stroke: 'var(--muted)', 'stroke-dasharray': '5 5' }));
    svg.append(svgEl('text', { x: (m.l + W - m.r) / 2, y: H - 4, 'text-anchor': 'middle', 'font-size': 12, fill: 'var(--ink-2)' }, t('chance we gave')));
    svg.append(svgEl('text', { x: 13, y: (m.t + H - m.b) / 2, 'text-anchor': 'middle', 'font-size': 12, fill: 'var(--ink-2)', transform: 'rotate(-90 13 ' + ((m.t + H - m.b) / 2) + ')' }, t('how often it listed up')));
    const good = bins.filter(b => fin(b.pred) && fin(b.obs) && b.n > 0), maxN = Math.max(1, ...good.map(b => b.n));
    svg.append(svgEl('path', { d: good.map((b, k) => (k ? 'L' : 'M') + sx(b.pred).toFixed(1) + ' ' + sy(b.obs).toFixed(1)).join(' '), fill: 'none', stroke: 'var(--brand)', 'stroke-width': 2 }));
    for (const b of good) { const c = svgEl('circle', { cx: sx(b.pred), cy: sy(b.obs), r: 5 + 7 * Math.sqrt(b.n / maxN), fill: 'var(--brand)', stroke: 'var(--surface)', 'stroke-width': 2 }); c.addEventListener('pointermove', (e) => showTip(e, [t('{o} listed up', { o: pct0(b.obs) }), t('when we said {p}', { p: pct0(b.pred) }), t('{n} IPOs', { n: b.n })])); c.addEventListener('pointerleave', hideTip); svg.append(c); }
    wrap.append(svg);
    wrap.append(tableView(t('Show as a table'), [t('We said'), t('Listed up'), t('IPOs')], good.map(b => [pct0(b.pred), pct0(b.obs), String(b.n)])));
    return wrap;
  }
  function tableView(title, head, rows) {
    const d = el('details', { class: 'more' }, el('summary', null, title));
    const tb = el('table', { class: 'data' }, el('thead', null, el('tr', null, ...head.map(h => el('th', { text: h })))), el('tbody', null, ...rows.map(r => el('tr', null, ...r.map(c => el('td', { class: 'num', text: c }))))));
    d.append(el('div', { class: 'tbl-wrap', style: 'max-height:280px;overflow-y:auto' }, tb));
    return d;
  }
  function chartGmp() {
    const host = el('div', { class: 'chart' }, el('h3', { text: t('What the grey-market premium promised vs what listing day delivered') }), el('p', { class: 'small ink2', text: t('Each dot is a past IPO. Dots below the dashed line listed worse than the premium suggested.') }));
    const pts = D.hist.filter(h => fin(h.gmp_pct) && fin(h.gain_pct) && (h.basis === 'close' || h.basis === 'reported'));
    if (pts.length < 10) { host.append(el('p', { class: 'muted small', text: t('Not enough past listings with both numbers yet.') })); return host; }
    const W = 520, H = 340, m = { t: 12, r: 14, b: 40, l: 48 };
    const xs = pts.map(p => p.gmp_pct), ys = pts.map(p => p.gain_pct);
    const xlo = Math.max(-30, Math.min(...xs) - 5), xhi = Math.min(160, Math.max(...xs) + 5), ylo = Math.max(-60, Math.min(...ys) - 5), yhi = Math.min(200, Math.max(...ys) + 5);
    const sx = v => m.l + (Math.min(xhi, Math.max(xlo, v)) - xlo) / (xhi - xlo) * (W - m.l - m.r), sy = v => H - m.b - (Math.min(yhi, Math.max(ylo, v)) - ylo) / (yhi - ylo) * (H - m.t - m.b);
    const ticks = (lo, hi) => { const st = (hi - lo) > 150 ? 50 : (hi - lo) > 60 ? 20 : 10; const o = []; for (let v = Math.ceil(lo / st) * st; v <= hi; v += st) o.push(v); return o; };
    const svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': t('Premium before listing against the actual listing gain for {n} past IPOs', { n: pts.length }) });
    for (const v of ticks(ylo, yhi)) { svg.append(svgEl('line', { x1: m.l, x2: W - m.r, y1: sy(v), y2: sy(v), stroke: 'var(--grid)' })); svg.append(axisText(m.l - 6, sy(v) + 4, v + '%', 'end')); }
    for (const v of ticks(xlo, xhi)) svg.append(axisText(sx(v), H - m.b + 18, v + '%'));
    svg.append(svgEl('line', { x1: m.l, x2: W - m.r, y1: sy(0), y2: sy(0), stroke: 'var(--axis)' }));
    const d0 = Math.max(xlo, ylo), d1 = Math.min(xhi, yhi);
    svg.append(svgEl('line', { x1: sx(d0), y1: sy(d0), x2: sx(d1), y2: sy(d1), stroke: 'var(--muted)', 'stroke-dasharray': '5 5' }));
    svg.append(svgEl('text', { x: (m.l + W - m.r) / 2, y: H - 4, 'text-anchor': 'middle', 'font-size': 12, fill: 'var(--ink-2)' }, t('premium before listing')));
    svg.append(svgEl('text', { x: 13, y: (m.t + H - m.b) / 2, 'text-anchor': 'middle', 'font-size': 12, fill: 'var(--ink-2)', transform: 'rotate(-90 13 ' + ((m.t + H - m.b) / 2) + ')' }, t('actual listing gain')));
    for (const p of pts) svg.append(svgEl('circle', { cx: sx(p.gmp_pct), cy: sy(p.gain_pct), r: 4.5, fill: p.board === 'sme' ? 'var(--series-sme)' : 'var(--series-main)', 'fill-opacity': 0.8, stroke: 'var(--surface)', 'stroke-width': 1.5 }));
    svg.addEventListener('pointermove', (evt) => {
      const rc = svg.getBoundingClientRect(), px = (evt.clientX - rc.left) * W / rc.width, py = (evt.clientY - rc.top) * H / rc.height;
      let best = null, bd = 1e9; for (const p of pts) { const dd = Math.hypot(sx(p.gmp_pct) - px, sy(p.gain_pct) - py); if (dd < bd) { bd = dd; best = p; } }
      if (best && bd < 24) showTip(evt, [best.name, boardName(best.board) + ' · ' + dlong(best.listing_date), t('premium {a}, listed {b}', { a: pct(best.gmp_pct, 1), b: pct(best.gain_pct, 1) })]); else hideTip();
    });
    svg.addEventListener('pointerleave', hideTip);
    host.append(svg, el('div', { class: 'legend' }, el('span', null, el('i', { style: 'background:var(--series-main)' }), t('Mainboard')), el('span', null, el('i', { style: 'background:var(--series-sme)' }), t('SME'))));
    const neg = pts.filter(p => p.gmp_pct > 0 && p.gain_pct <= 0).length, posN = pts.filter(p => p.gmp_pct > 0).length;
    host.append(el('p', { class: 'small ink2', text: t('Of {n} IPOs with a positive premium, {k} ({p}) still listed at or below the issue price. A premium is a hint, not a promise.', { n: posN, k: neg, p: Math.round(100 * neg / Math.max(1, posN)) + '%' }) }));
    host.append(tableView(t('Show as a table'), [t('IPO'), t('Premium'), t('Listed')], pts.slice().sort((a, b) => (b.listing_date || '') < (a.listing_date || '') ? -1 : 1).map(p => [p.name, pct(p.gmp_pct, 1), pct(p.gain_pct, 1)])));
    return host;
  }
  function bucketTable() {
    const host = el('div', { class: 'stack' }, el('h3', { text: t('Past IPOs grouped by their premium') }), el('p', { class: 'small ink2', text: t('No model, just counting. Find the row matching an IPO’s premium and see how many like it listed up.') }));
    if (!D.params || !Array.isArray(D.params.empirical)) return host;
    const tb = el('tbody');
    for (const r of D.params.empirical) if (r.n) tb.append(el('tr', null, el('td', { text: r.bucket }), el('td', { text: boardName(r.board) }), el('td', { class: 'num', text: String(r.n) }), el('td', { class: 'num', text: Math.round(100 * r.p_up) + '%' }), el('td', { class: 'num', text: pct(r.median_gain, 0) }), el('td', { class: 'num', text: pct(r.p10_gain, 0) })));
    host.append(el('div', { class: 'tbl-wrap' }, el('table', { class: 'data' }, el('thead', null, el('tr', null, ...[t('Premium'), t('Board'), t('IPOs'), t('Listed up'), t('Typical gain'), t('Bad case')].map(h => el('th', { text: h })))), tb)));
    return host;
  }
  function coefTable() {
    const host = el('div', { class: 'stack' }, el('h3', { text: t('What moves the chance up or down') }));
    if (!D.params || !Array.isArray(D.params.coef_table)) return host;
    const NAMES = { gmp_pct: 'Grey-market premium', gmp_missing: 'No premium quote', log_sub_qib: 'Institutional demand', log_sub_nii: 'Wealthy-investor demand', log_sub_retail: 'Retail demand', sub_missing: 'No demand figures', is_sme: 'SME issue', log_issue_size: 'Issue size', nifty_1m_pct: 'Nifty, past month', gmp_trend_pct: 'Premium trend' };
    const rows = D.params.coef_table.slice().sort((a, b) => Math.abs(b.coef_std) - Math.abs(a.coef_std)), mx = Math.max(0.01, ...rows.map(r => Math.abs(r.coef_std)));
    const box = el('div', { class: 'coef' });
    for (const r of rows) { const w = Math.abs(r.coef_std) / mx * 50; box.append(el('div', { class: 'r' }, el('span', { text: t(NAMES[r.feature] || r.feature) }), el('div', { class: 'bar' }, el('div', { class: 'z' }), el('i', { style: r.coef_std >= 0 ? 'left:50%;width:' + w + '%' : 'left:' + (50 - w) + '%;width:' + w + '%' })), el('span', { class: 'num', style: 'text-align:right', text: (r.coef_std >= 0 ? '+' : '') + r.coef_std.toFixed(2) }))); }
    host.append(box, el('p', { class: 'tiny muted', text: t('Bars to the right raise the chance, to the left lower it; longer is stronger.') }));
    return host;
  }

  // ------------------------------------------------------------ glossary ---
  const TERMS = {
    howto: { t: 'How to read this app in 1 minute', d: ['Every IPO gets one coloured label: Apply, Leaning yes, 50-50 gamble, Avoid or Too early. Start there; it already weighs everything else.', 'The ring shows the chance of a listing gain. 70% means that out of ten IPOs that looked like this one, about seven ended their first day above the issue price, and three did not.', '“Get shares” is your chance in the share lottery. In a popular IPO most people get nothing and their money is simply unblocked a few days later. “1 in 7” means one applicant in seven gets shares.', '“Worth per application” puts it all together: the average profit one application brings after broker charges and tax, counting the times you get nothing.', 'Tap any IPO for its dates, the money, the demand and the reasons. Tap any underlined word or ? for its meaning.'] },
    verdicts: { t: 'The labels', d: ['Apply: the odds are clearly on your side and nothing is flashing red.', 'Leaning yes: good odds with one caveat, or a strong early read before demand figures exist.', '50-50 gamble: about as likely to list down as up.', 'Avoid: the odds are against you before you start.', 'Too early: wait for the demand figures on the last bidding day.', 'Not enough info: no premium quote and no demand figures yet.'] },
    chance: { t: 'Chance of a listing gain', d: ['How likely the IPO is to close its first trading day above the issue price. It comes from a model that learned from past Indian listings.', '70% does not mean you will make 70%. It means about 7 in 10 IPOs that looked like this one listed up.'] },
    gain: { t: 'Listing gain', d: ['The difference between the IPO price you paid and the price at the end of the first trading day. A 10% gain on ₹15,000 of shares is ₹1,500 before charges and tax.'] },
    gmp: { t: 'Grey-market premium (GMP)', d: ['Before an IPO lists, some dealers informally trade its shares among themselves. The extra they pay over the issue price is the grey-market premium.', 'It is a hint of demand, nothing more: unofficial, unregulated, sometimes stale, and for small IPOs easy to push around. We treat it as one input among several, never as the answer.'] },
    sub: { t: 'Demand (subscription)', d: ['How many times over the IPO was bid for. “5x” means people asked for five times the shares on offer.', 'It is reported for three groups: big institutions (QIB), wealthy investors (NII) and retail (people applying up to ₹2 lakh, which is most of us).'] },
    qib: { t: 'Big institutions (QIB)', d: ['Mutual funds, banks, insurers and foreign funds. They do their own research, so their demand is the strongest signal. They usually bid on the last day.'] },
    nii: { t: 'Wealthy investors (NII / HNI)', d: ['People and firms bidding more than ₹2 lakh. Often borrowed money, so their demand swings with the premium.'] },
    retail: { t: 'Retail', d: ['Individuals applying for up to ₹2 lakh. That is you. When this group is oversubscribed, shares go by lottery, so this number sets your odds.'] },
    allot: { t: 'Chance of getting shares (allotment)', d: ['If retail demand is 7 times the shares on offer, roughly 1 applicant in 7 gets one lot, picked by a computerised lottery set by SEBI. Everyone else gets their money unblocked.', 'Bidding for more lots does not improve your chance in a popular IPO. Applying from more family demat accounts does.'] },
    lot: { t: 'Lot', d: ['IPO shares are sold in fixed bundles called lots. Price × lot size is the smallest amount you can apply for. SME IPOs need at least two lots.'] },
    range: { t: 'Likely gain and its range', d: ['The middle number is the most likely listing-day gain. The bad case is a result only 1 in 10 did worse than; the good case one only 1 in 10 did better than.', 'A wide range means more uncertainty, usually in small SME IPOs.'] },
    worth: { t: 'Worth per application', d: ['The average profit one application brings, after broker charges and tax, counting the chance you get no shares at all.', 'Example: a 1 in 5 chance of a ₹2,000 profit is worth about ₹400 per application. Any single application gives either ₹2,000 or nothing; over many, it averages out.'] },
    charges: { t: 'Broker and exchange charges', d: ['Selling on listing day costs: brokerage, securities transaction tax (STT, 0.1%), exchange and SEBI fees, GST on those, and a depository (DP) charge. Pick your broker in the Planner.'] },
    tax: { t: 'Tax on the profit', d: ['Selling within a year counts as a short-term capital gain: 20% tax plus 4% cess on that tax. Every “in your hand” figure has it deducted.'] },
    sme: { t: 'Mainboard and SME', d: ['Mainboard IPOs list on the main NSE and BSE exchanges. SME IPOs are small companies on NSE Emerge or BSE SME: bigger minimum amounts (₹2 lakh or more), thin trading and wilder results both ways.'] },
    gamble: { t: 'Gamble warnings', d: ['“Possible gamble” marks a toss-up; “Sure gamble” marks an IPO where the odds are against you. They appear before your money is blocked so you can walk away.'] },
    model: { t: 'The model', d: ['The chances come from a statistical model fitted on past Indian listings. Until it has enough history it runs on documented starting weights, and the app says so. The Track record tab shows how its calls turned out.'] },
    fresh: { t: 'Fresh issue', d: ['New shares created by the company. The money goes into the business, for growth or paying debt.'] },
    ofs: { t: 'Offer for sale (OFS)', d: ['Existing owners selling their shares. The money goes to them, not to the company. An IPO that is almost all OFS means insiders are cashing out.'] },
    anchor: { t: 'Anchor investors', d: ['Big institutions that buy a part of the IPO a day before it opens. Half of their shares are locked for 30 days after allotment and the rest for 90 days; prices often dip when those lock-ins end.'] },
  };
  const TERM_ORDER = ['howto', 'verdicts', 'chance', 'gain', 'range', 'allot', 'worth', 'gmp', 'sub', 'qib', 'nii', 'retail', 'lot', 'charges', 'tax', 'sme', 'fresh', 'ofs', 'anchor', 'gamble', 'model'];
  function openExplain(key) {
    const tm = TERMS[key]; if (!tm) return;
    openSheet(t(tm.t), [...tm.d.map(x => el('p', { text: t(x) })), el('button', { type: 'button', class: 'linkish', style: 'justify-self:start', onclick: glossarySheet }, t('All words used in this app'))]);
  }
  function glossarySheet() {
    openSheet(t('Words used in this app'), el('div', { class: 'list', style: 'box-shadow:none' }, ...TERM_ORDER.map(k => el('details', { class: 'gl' }, el('summary', null, t(TERMS[k].t)), el('div', { class: 'b' }, ...TERMS[k].d.map(x => el('p', { text: t(x) })))))));
  }
  function methodSheet() {
    const P = D.params;
    const body = el('div', { class: 'prose' },
      note('warn', el('b', null, t('A decision aid, not a tip sheet.')), ' ', t('A 75% chance of a gain is a 25% chance of a loss. Apply only with money that can stay blocked if a listing goes wrong, never with borrowed money.')),
      el('h3', { text: t('In plain words') }),
      el('ul', null, el('li', { text: t('We look at the grey-market premium, how many times over each investor group bid, the issue size and the market mood. From past listings the model has learned how these turned into first-day results.') }), el('li', { text: t('We then count the lottery: in a popular IPO most applicants get nothing, so the profit is multiplied by your chance of getting shares before anything is called worth it.') }), el('li', { text: t('Broker charges and tax come off every “in your hand” figure.') }), el('li', { text: t('When we are unsure we say so: Too early, Not enough info, and the gamble warnings.') })),
      el('h3', { text: t('The labels') }),
      el('ul', null, el('li', null, el('b', null, vlabel('apply')), ': ' + t('chance 75%+, likely gain 5%+, positive worth, no warnings. Mainboard only; an SME IPO tops out at Leaning yes.')), el('li', null, el('b', null, vlabel('lean')), ': ' + t('chance 60%+ with at most one warning, or a strong premium-only read.')), el('li', null, el('b', null, vlabel('coinflip')), ': ' + t('chance 40–60%, or a better read pulled down by two or more warnings.')), el('li', null, el('b', null, vlabel('avoid')), ': ' + t('chance under 40% or negative worth.')), el('li', null, el('b', null, vlabel('watch')), ': ' + t('only a premium so far and it does not justify a lean; decide on the last bidding day.'))),
      el('h3', { text: t('What triggers a warning') }),
      el('p', { text: t('A premium at or below zero or under 5%; a premium falling sharply; retail or institutions under-subscribed at close; only institutions bidding; any SME IPO; issues under ₹50 crore; a premium quote older than three days; an issue that is almost all offer-for-sale.') }),
      el('h3', { text: t('What nobody can know') }),
      el('ul', null, el('li', { text: t('The grey market is unofficial and can be thin or steered, especially for small SME issues.') }), el('li', { text: t('A market shock on listing morning is in nobody’s pre-listing numbers.') }), el('li', { text: P && P.status === 'calibrated' ? t('The model is fitted on {n} listings: enough to rank IPOs and flag gambles, not to promise a gain on any one IPO.', { n: P.n_rows }) : t('The model is not yet fitted to data; it runs on documented starting weights checked against recent outcomes.') }), el('li', { text: t('Expected profit is an average over many applications; most months bring zero or one allotment.') })),
      el('h3', { text: t('Technical summary') }),
      el('p', { class: 'small', text: 'Ridge-penalised logistic regression for P(listing-day close > issue price) on GMP % (clipped, trended), log subscription by category, board, log issue size and Nifty 1-month return, with missing-input indicators; a second regression for the gain size with P10–P90 bands from out-of-sample residuals by board. 5-fold cross-validated AUC, Brier and calibration. Allotment odds follow SEBI’s retail lottery (≈1 ÷ retail multiple). Source code and data are public.' }),
      el('div', { class: 'btn-row' }, extLink(REPO, t('Source code and data'))));
    openSheet(t('How IPO Radar works'), body);
  }
  function healthSheet() {
    const h = D.live.health, nodes = [];
    if (!h) { nodes.push(el('p', { text: t('This snapshot has no automatic data-check report.') })); openSheet(t('Data quality'), nodes); return; }
    nodes.push(note(h.ok === false ? 'warn' : 'good', h.ok === false ? t('Some checks need attention. The numbers are still shown, with care flags on the affected IPOs.') : t('All automatic data checks passed.')));
    const issues = Array.isArray(h.issues) ? h.issues : [];
    if (issues.length) nodes.push(el('ul', { class: 'reasons' }, ...issues.slice(0, 40).map(x => el('li', { class: x.level === 'error' ? 'w' : 'r' }, icon(x.level === 'error' ? 'alert' : 'info'), el('span', null, x.ipo_id && BYID.has(x.ipo_id) ? el('b', null, BYID.get(x.ipo_id).eff.name + ': ') : null, x.msg)))));
    const srcs = Array.isArray(h.sources) ? h.sources : [];
    if (srcs.length) nodes.push(el('div', { class: 'money' }, ...srcs.map(s => line(s.name, el('span', { class: s.ok ? 'good' : 'bad' }, s.ok ? t('working') : t('down'), s.last_ok_at ? ' · ' + relTime(Date.parse(s.last_ok_at)) : '')))));
    openSheet(t('Data quality'), nodes);
  }
  function helpSheet() {
    const mail = 'mailto:ceo@layerbit.co.in?subject=IPO%20Radar%20support', wa = 'https://wa.me/916282595823?text=Hi%2C%20I%20need%20help%20with%20IPO%20Radar';
    const open = (href) => (ev) => { if (has('openExternal')) { ev.preventDefault(); call('openExternal', href); closeSheet(); } };
    openSheet(t('Get help'), [el('p', { text: t('A number that looks wrong, an IPO we missed, a broker whose charges differ, or an idea: tell the people who build this.') }),
      el('a', { class: 'btn primary block', href: mail, onclick: open(mail) }, icon('mail'), t('Email us')),
      el('a', { class: 'btn wa block', href: wa, target: '_blank', rel: 'noopener', onclick: open(wa) }, icon('chat'), t('Chat on WhatsApp')),
      el('p', { class: 'tiny muted', text: t('Most messages get a reply within one to two business days.') })]);
  }
  function privacySheet() {
    openSheet(t('Privacy'), el('div', { class: 'prose' },
      el('p', { text: t('IPO Radar has no account, no ads and no tracking.') }),
      el('ul', null, el('li', { text: t('The app only downloads public data files. Nothing about you or your phone is sent.') }), el('li', { text: t('Your watchlist, planner inputs and My IPOs record stay on this phone.') }), el('li', { text: t('Notifications are created on the phone itself.') }), el('li', { text: t('Sharing only happens when you tap Share, through your phone’s own share menu.') })),
      el('div', { class: 'btn-row' }, extLink(REPO + '/blob/main/PRIVACY.md', t('Full privacy policy')))));
  }

  // ---------------------------------------------------------------- more ---
  function settingRow(ic, title, sub, end, onclick) {
    return el(onclick ? 'button' : 'div', { type: onclick ? 'button' : null, class: 'list-row', onclick }, el('span', { class: 'ico' }, icon(ic)), el('div', { class: 'grow' }, el('div', { class: 't', text: title }), sub ? el('div', { class: 's', text: sub }) : null), end || (onclick ? icon('chev', 'chev') : null));
  }
  function switchEl(on, onChange, label, disabled) {
    const inp = el('input', { type: 'checkbox', role: 'switch', 'aria-label': label, disabled: disabled ? true : null }); inp.checked = !!on;
    inp.addEventListener('change', () => onChange(inp.checked));
    return el('label', { class: 'switch' }, inp, el('span'));
  }
  function segEl(opts, cur, onPick, label) {
    const s = el('div', { class: 'seg', role: 'group', 'aria-label': label });
    for (const [k, lab] of opts) s.append(el('button', { type: 'button', 'aria-pressed': String(k) === String(cur) ? 'true' : 'false', onclick: () => onPick(k) }, lab));
    return s;
  }
  const REMINDER_OPTS = [[-1, 'Off'], [9, '9:00 am'], [10, '10:00 am'], [12, '12 noon'], [14, '2:00 pm'], [16, '4:00 pm']];
  const SCHEDULE_OPTS = [[0, 'Off'], [3, 'Every 3 hours'], [6, 'Every 6 hours'], [12, 'Every 12 hours'], [24, 'Once a day']];
  function renderMore() {
    const host = $('#screen-more'); host.replaceChildren();
    host.append(el('div', { class: 'hello' }, el('h1', { text: t('More') })));
    host.append(journalBlock());
    // look & language
    const look = el('div', { class: 'list' });
    look.append(settingRow('globe', t('Language'), null, segEl([['en', 'English'], ['hi', 'हिन्दी']], PREF.lang, (v) => { PREF.lang = v; store('lang', v); applyPrefs(); rerender(); }, t('Language'))));
    look.append(settingRow('text', t('Text size'), null, segEl([[1, 'A'], [1.15, 'A+'], [1.3, 'A++']], PREF.scale, (v) => { PREF.scale = Number(v); store('scale', PREF.scale); applyPrefs(); renderMore(); }, t('Text size'))));
    look.append(settingRow('moon', t('Appearance'), null, segEl([['system', t('Auto')], ['light', t('Light')], ['dark', t('Dark')]], PREF.theme, (v) => { PREF.theme = v; store('theme', v); applyPrefs(); renderMore(); }, t('Appearance'))));
    host.append(el('div', { class: 'sec' }, el('h2', { text: t('Display') }), look));
    // alerts
    const nat = !!N, al = el('div', { class: 'list' });
    const setAlert = (k) => (on) => { ALERTS[k] = on; store('alerts', ALERTS); call('setAlerts', JSON.stringify(ALERTS)); };
    const alertDefs = [['opening', 'bell', 'Bidding opens', 'For IPOs on your watchlist'], ['closing', 'clock', 'Last day to apply', 'Morning reminder for your watchlist'], ['allotment', 'check', 'Allotment result day', 'So you can check if you got shares'], ['listing', 'flag', 'Listing day', 'The day before and on the day'], ['verdict', 'shield', 'Label changes', 'When a watched IPO moves, say from Leaning yes to Avoid']];
    for (const [k, ic, tl, sub] of alertDefs) al.append(settingRow(ic, t(tl), t(sub), switchEl(ALERTS[k], setAlert(k), t(tl), !nat)));
    const rh = STATUS && STATUS.reminder_hour !== undefined && STATUS.reminder_hour !== null ? STATUS.reminder_hour : -1;
    al.append(settingRow('clock', t('Reminder time'), t((REMINDER_OPTS.find(o => o[0] === Number(rh)) || REMINDER_OPTS[0])[1]), null, nat ? () => pickSheet(t('Reminder time'), REMINDER_OPTS.map(([k, l]) => [k, t(l)]), rh, (v) => { call('setReminderHour', Number(v)); STATUS = Object.assign({}, STATUS || {}, { reminder_hour: Number(v) }); renderMore(); }) : null));
    al.append(settingRow('download', t('Tell me when new data arrives'), null, switchEl(STATUS && STATUS.notify, (on) => call('setNotify', on), t('Tell me when new data arrives'), !nat)));
    const sh = STATUS ? Number(STATUS.schedule_hours || 0) : 0;
    al.append(settingRow('db', t('Background refresh'), t((SCHEDULE_OPTS.find(o => o[0] === sh) || SCHEDULE_OPTS[0])[1]), null, nat ? () => pickSheet(t('Background refresh'), SCHEDULE_OPTS.map(([k, l]) => [k, t(l)]), sh, (v) => { call('setSchedule', Number(v)); STATUS = Object.assign({}, STATUS || {}, { schedule_hours: Number(v) }); renderMore(); }) : null));
    host.append(el('div', { class: 'sec' }, el('h2', { text: t('Alerts') }), nat ? null : note('info', t('Alerts and background refresh work in the Android app.')), al));
    // share
    const shr = el('div', { class: 'list' });
    shr.append(settingRow('share', t('Share today’s shortlist as a picture'), t('For WhatsApp, Instagram and more'), null, shareShortlistCard));
    shr.append(settingRow('share', t('Share the shortlist as text'), null, null, () => shareText(shortlistText(), 'IPO Radar')));
    shr.append(settingRow('download', t('Export all IPOs (spreadsheet)'), 'CSV', null, () => shareFile('ipo-radar-' + (D.live.generated_at || '').slice(0, 10) + '.csv', 'text/csv', csvText())));
    host.append(el('div', { class: 'sec' }, el('h2', { text: t('Share') }), shr));
    // learn
    const lrn = el('div', { class: 'list' });
    lrn.append(settingRow('help', t('How to read this app'), t('1 minute'), null, () => openExplain('howto')));
    lrn.append(settingRow('book', t('Words used in this app'), t('Plain-language glossary'), null, glossarySheet));
    lrn.append(settingRow('info', t('How IPO Radar works'), t('The method, the rules and the limits'), null, methodSheet));
    const h = D.live.health;
    lrn.append(settingRow('db', t('Data quality'), h ? (h.ok === false ? t('Some checks need attention') : t('All checks passed')) : t('No report in this snapshot'), null, healthSheet));
    host.append(el('div', { class: 'sec' }, el('h2', { text: t('Learn') }), lrn));
    // support
    const sup = el('div', { class: 'list' });
    sup.append(settingRow('chat', t('Get help'), t('Email or WhatsApp'), null, helpSheet));
    sup.append(el('a', { class: 'list-row', href: 'https://www.buymeacoffee.com/layerbit', target: '_blank', rel: 'noopener', onclick: (ev) => { if (has('openExternal')) { ev.preventDefault(); call('openExternal', 'https://www.buymeacoffee.com/layerbit'); } } }, el('span', { class: 'ico', style: 'background:#ffdd00;color:#1a1a1a' }, icon('coffee')), el('div', { class: 'grow' }, el('div', { class: 't', text: t('Buy us a coffee') }), el('div', { class: 's', text: t('Keeps the data and the model running') })), icon('chev', 'chev')));
    sup.append(settingRow('lock', t('Privacy'), t('No account, no ads, no tracking'), null, privacySheet));
    host.append(el('div', { class: 'sec' }, el('h2', { text: t('Support') }), sup));
    host.append(el('p', { class: 'tiny muted', style: 'text-align:center', text: 'IPO Radar ' + (STATUS && STATUS.version ? 'v' + STATUS.version : '') + ' · ' + t('a Layerbit tool') + ' · layerbit.co.in' }));
    host.append(footer());
  }

  // ------------------------------------------------------- share & export ---
  function shareText(text, subject) {
    if (has('shareText')) { call('shareText', text, subject); return; }
    if (navigator.share) { navigator.share({ title: subject, text }).catch(() => {}); return; }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => toast(t('Copied'))).catch(() => toast(t('Could not copy')));
  }
  function shareFile(name, mime, content) {
    if (has('shareFile')) { call('shareFile', name, mime, content); return; }
    try { const f = new File([content], name, { type: mime }); if (navigator.canShare && navigator.canShare({ files: [f] })) { navigator.share({ files: [f], title: name }).catch(() => {}); return; } } catch (e) { /* fall through */ }
    const a = el('a', { href: URL.createObjectURL(new Blob([content], { type: mime })), download: name }); document.body.append(a); a.click(); a.remove();
  }
  function shareImage(name, dataUrl, caption) {
    if (has('shareImage')) { call('shareImage', name, dataUrl, caption); return; }
    try {
      const bin = atob(dataUrl.split(',')[1]), arr = new Uint8Array(bin.length); for (let k = 0; k < bin.length; k++) arr[k] = bin.charCodeAt(k);
      const f = new File([arr], name, { type: 'image/png' });
      if (navigator.canShare && navigator.canShare({ files: [f] })) { navigator.share({ files: [f], title: name, text: caption }).catch(() => {}); return; }
      const a = el('a', { href: dataUrl, download: name }); document.body.append(a); a.click(); a.remove();
    } catch (e) { shareText(caption, name); }
  }
  function readText(r) {
    const i = r.eff, s = r.score, L2 = [];
    L2.push(i.name + ' (' + (i.board === 'sme' ? 'SME' : 'Mainboard') + ' IPO)');
    if (i.open_date || i.close_date) L2.push('Bidding ' + dlong(i.open_date) + ' to ' + dlong(i.close_date) + (i.listing_date ? ', lists ' + dlong(i.listing_date) : ''));
    const inv = minInvest(r); if (inv) L2.push('Minimum ' + inr(inv));
    if (s && fin(s.p_up)) L2.push('Chance of a listing gain: ' + pct0(s.p_up) + (s.gain ? ' · likely ' + pct(s.gain.p50, 0) + ' (range ' + pct(s.gain.p10, 0) + ' to ' + pct(s.gain.p90, 0) + ')' : ''));
    if (s && s.allotment && fin(s.allotment.p_min_lot)) L2.push('Chance of getting shares: ' + (s.allotment.p_min_lot >= 0.999 ? 'everyone' : '1 in ' + (1 / s.allotment.p_min_lot).toFixed(1)));
    if (s && fin(s.ev.ev)) L2.push('Worth per application after charges & tax: ' + inr(s.ev.ev, { plus: true }));
    if (s && r.st !== 'listed') { L2.push('IPO Radar says: ' + VERDICT[tierOf(r)].label); for (const w of s.verdict.warnings.slice(0, 3)) L2.push('⚠ ' + w); }
    L2.push('— IPO Radar · data as of ' + (D.live.generated_at || '').slice(0, 16).replace('T', ' ') + ' UTC. Not investment advice.');
    return L2.join('\n');
  }
  function shortlistRows() { return SCORED.filter(r => isLive(r) && r.score && fin(r.score.p_up)).sort(rankLive); }
  function shortlistText() {
    const L2 = ['IPO Radar shortlist, ' + dshort(TODAY)];
    for (const r of shortlistRows()) L2.push('• ' + r.eff.name + (r.eff.board === 'sme' ? ' (SME)' : '') + ': ' + VERDICT[tierOf(r)].label + ', ' + pct0(r.score.p_up) + ' chance' + (fin(r.score.ev.ev) ? ', worth ' + inr(r.score.ev.ev, { plus: true }) : '') + (r.st === 'open' ? ', closes ' + dshort(r.eff.close_date) : ', opens ' + dshort(r.eff.open_date)));
    L2.push('Not investment advice.');
    return L2.join('\n');
  }
  function csvText() {
    const esc = v => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const head = ['name', 'board', 'status', 'open_date', 'close_date', 'listing_date', 'issue_price', 'lot_size', 'min_lots', 'gmp_rs', 'gmp_pct', 'sub_qib', 'sub_nii', 'sub_retail', 'sub_total', 'chance_of_gain', 'gain_p10', 'gain_p50', 'gain_p90', 'allotment_p', 'worth_per_application', 'verdict', 'listing_gain_pct'];
    const out = [head.join(',')];
    for (const r of SCORED) { const i = r.eff, s = r.score || {}, g = i.gmp || {}, sub = i.subscription || {}; out.push([i.name, i.board, r.st, i.open_date, i.close_date, i.listing_date, i.issue_price, i.lot_size, i.min_lots, g.rs, S.gmpPctOf(i), sub.qib, sub.nii, sub.retail, sub.total, s.p_up, s.gain && s.gain.p10, s.gain && s.gain.p50, s.gain && s.gain.p90, s.allotment && s.allotment.p_min_lot, s.ev && s.ev.ev, s.verdict && s.verdict.tier, i.listing && i.listing.gain_pct].map(esc).join(',')); }
    return out.join('\n');
  }
  // Share cards: a 1080x1350 PNG in the app's own type, drawn on a canvas, previewed before sending.
  const CARD = { w: 1080, h: 1350, pad: 64 };
  const CP = { bg: '#f4f6f9', surface: '#ffffff', ink: '#0b1b2b', ink2: '#3f5064', muted: '#66768a', hair: '#e1e7ee', brand: '#0e7c86', brandSoft: '#dcf0f1', navy: '#0b2540', gold: '#e6a817', good: '#137a3a', goodFill: '#1fa855', goodSoft: '#dcf5e4', warn: '#9a5208', warnSoft: '#fdf0d6', crit: '#b3261e', critSoft: '#fde4e1', info: '#2a5db0', infoSoft: '#e3ecfb' };
  const VC = { apply: ['#ffffff', 'goodFill'], lean: ['good', 'goodSoft'], coinflip: ['warn', 'warnSoft'], avoid: ['crit', 'critSoft'], watch: ['info', 'infoSoft'], nodata: ['muted', 'hair'] };
  const col = (k) => (k.startsWith('#') ? k : CP[k]);
  function cFont(px, w, mono) { return (w || 400) + ' ' + px + 'px ' + (mono ? '"Fira Code", monospace' : '"Space Grotesk", "Noto Sans Devanagari", sans-serif'); }
  function rr(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
  function wrapT(c, text, x, y, maxW, lh, maxLines) {
    const words = String(text).split(/\s+/); let ln = '', n = 0;
    for (const w of words) { const tt = ln ? ln + ' ' + w : w; if (c.measureText(tt).width > maxW && ln) { if (maxLines && n === maxLines - 1) { let cut = ln; while (c.measureText(cut + '…').width > maxW && cut.length) cut = cut.slice(0, -1); c.fillText(cut + '…', x, y); return y + lh; } c.fillText(ln, x, y); y += lh; n++; ln = w; } else ln = tt; }
    if (ln) { c.fillText(ln, x, y); y += lh; } return y;
  }
  function pillC(c, x, y, text, fg, bg, px) { c.font = cFont(px || 30, 700); const w = c.measureText(text).width + 48, h = (px || 30) * 1.8; c.fillStyle = col(bg); rr(c, x, y, w, h, h / 2); c.fill(); c.fillStyle = col(fg); c.textBaseline = 'middle'; c.fillText(text, x + 24, y + h / 2 + 1); c.textBaseline = 'alphabetic'; return w; }
  function logoImg() { const svg = $('#brand svg'); if (!svg) return Promise.resolve(null); return new Promise(res => { const img = new Image(); img.onload = () => res(img); img.onerror = () => res(null); let src = svg.outerHTML; if (!/xmlns=/.test(src)) src = src.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"'); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(src); }); }
  function cardHead(c, logo, sub) {
    c.fillStyle = CP.bg; c.fillRect(0, 0, CARD.w, CARD.h);
    c.fillStyle = CP.navy; c.fillRect(0, 0, CARD.w, 172);
    const p = CARD.pad; if (logo) c.drawImage(logo, p, 48, 78, 78);
    c.fillStyle = '#ffffff'; c.font = cFont(42, 700); c.fillText('IPO Radar', p + 100, 92);
    c.fillStyle = '#9fd8dc'; c.font = cFont(23, 500); c.fillText(sub, p + 100, 126);
    c.textAlign = 'right'; c.fillStyle = '#c8dde4'; c.font = cFont(24, 500); c.fillText(t('Data as of') + ' ' + (D.live.generated_at ? new Date(D.live.generated_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '–'), CARD.w - p, 100); c.textAlign = 'left';
  }
  function cardFoot(c) {
    const p = CARD.pad, y = CARD.h - 96;
    c.strokeStyle = CP.hair; c.lineWidth = 2; c.beginPath(); c.moveTo(p, y - 32); c.lineTo(CARD.w - p, y - 32); c.stroke();
    c.fillStyle = CP.muted; c.font = cFont(22, 400); wrapT(c, t('Not investment advice. Chances come from a model on past listings; the grey-market premium is unofficial.'), p, y, CARD.w - 2 * p - 260, 30, 2);
    c.textAlign = 'right'; c.fillStyle = CP.brand; c.font = cFont(24, 700); c.fillText('IPO Radar', CARD.w - p, y); c.fillStyle = CP.muted; c.font = cFont(20, 500); c.fillText(t('a Layerbit tool'), CARD.w - p, y + 30); c.textAlign = 'left';
  }
  function statC(c, x, y, w, h, label, value, sub, vcol) {
    c.fillStyle = CP.surface; rr(c, x, y, w, h, 22); c.fill(); c.strokeStyle = CP.hair; c.lineWidth = 2; c.stroke();
    c.fillStyle = CP.muted; c.font = cFont(23, 600); wrapT(c, label, x + 28, y + 46, w - 56, 28, 1);
    c.fillStyle = vcol || CP.ink; c.font = cFont(60, 700, true); c.fillText(value, x + 28, y + 118);
    if (sub) { c.fillStyle = CP.ink2; c.font = cFont(23, 400); wrapT(c, sub, x + 28, y + 156, w - 56, 28, 2); }
  }
  async function fontsReady() { try { await document.fonts.load(cFont(40, 700)); await document.fonts.load(cFont(40, 700, true)); } catch (e) { /* fallbacks */ } }
  async function drawIpoCard(r) {
    const i = r.eff, s = r.score, st = r.st, tier = tierOf(r);
    const cv = document.createElement('canvas'); cv.width = CARD.w; cv.height = CARD.h; const c = cv.getContext('2d');
    await fontsReady(); cardHead(c, await logoImg(), t('Indian IPOs, in plain words'));
    const p = CARD.pad; let y = 248;
    c.fillStyle = CP.ink; c.font = cFont(56, 700); y = wrapT(c, i.name, p, y, CARD.w - 2 * p, 64, 2) + 6;
    let cx = p; cx += pillC(c, cx, y, boardName(i.board), CP.ink2, CP.hair, 26) + 12; pillC(c, cx, y, statusName(st), st === 'open' ? 'good' : 'ink2', st === 'open' ? 'goodSoft' : 'hair', 26);
    y += 74;
    const due = dueInfo(r); c.fillStyle = due.hot ? CP.crit : CP.ink2; c.font = cFont(28, 600); c.fillText(due.t, p, y + 10); y += 46;
    if (st !== 'listed') {
      const [fg, bg] = VC[tier] || VC.nodata;
      c.fillStyle = col(bg); rr(c, p, y, CARD.w - 2 * p, 150, 26); c.fill();
      c.fillStyle = col(fg); c.font = cFont(56, 700); c.fillText(vlabel(tier), p + 36, y + 72);
      c.font = cFont(25, 500); wrapT(c, vline(tier), p + 36, y + 114, CARD.w - 2 * p - 72, 30, 1);
      y += 178;
      const bw = (CARD.w - 2 * p - 24) / 2, bh = 210, pu = s && fin(s.p_up) ? s.p_up : null, inv = minInvest(r), al = s && s.allotment && fin(s.allotment.p_min_lot) ? s.allotment.p_min_lot : null;
      statC(c, p, y, bw, bh, t('Chance of a listing gain'), pu === null ? '–' : pct0(pu), pu === null ? t('not enough data yet') : t('{o} similar IPOs listed above their price.', { o: cap(oddsWords(pu)) }), pu === null ? CP.muted : pu >= 0.7 ? CP.good : pu >= 0.5 ? CP.warn : CP.crit);
      statC(c, p + bw + 24, y, bw, bh, t('Likely gain'), s && s.gain ? pct(s.gain.p50, 0) : '–', s && s.gain ? t('range {a} to {b}', { a: pct(s.gain.p10, 0), b: pct(s.gain.p90, 0) }) : '', s && s.gain && s.gain.p50 > 0 ? CP.good : CP.crit);
      y += bh + 24;
      statC(c, p, y, bw, bh, t('You need'), inv ? inrShort(inv) : '–', inv ? t('minimum application') : '', CP.ink);
      statC(c, p + bw + 24, y, bw, bh, t('Chance of getting shares'), al === null ? '–' : allotText(al), al === null ? (st === 'upcoming' ? t('known once bidding starts') : t('no demand figures yet')) : t('share lottery'), CP.ink);
      y += bh + 30;
      if (s) { c.font = cFont(25, 400); for (const w of s.verdict.warnings.slice(0, 2)) { if (y > CARD.h - 170) break; c.fillStyle = CP.warn; c.fillText('⚠', p, y); c.fillStyle = CP.ink2; y = wrapT(c, w, p + 40, y, CARD.w - 2 * p - 40, 32, 2) + 8; } }
    } else {
      const lg = i.listing && fin(i.listing.gain_pct) ? Number(i.listing.gain_pct) : null;
      c.fillStyle = lg !== null && lg > 0 ? CP.goodSoft : CP.critSoft; rr(c, p, y, CARD.w - 2 * p, 170, 26); c.fill();
      c.fillStyle = lg !== null && lg > 0 ? CP.good : CP.crit; c.font = cFont(72, 700, true); c.fillText(lg !== null ? pct(lg, 1) : '–', p + 36, y + 104);
      c.font = cFont(26, 500); c.fillText(t('on listing day'), p + 36, y + 146); y += 200;
      const tr = trackRow(i.id); if (tr) { c.fillStyle = CP.ink2; c.font = cFont(30, 500); wrapT(c, t('Before listing we gave it a {p} chance of a gain and called it “{v}”.', { p: pct0(tr.p_up), v: vlabel(tr.verdict_tier) }), p, y + 20, CARD.w - 2 * p, 40, 3); }
    }
    cardFoot(c); return cv;
  }
  async function drawShortlistCard() {
    const rows = shortlistRows().slice(0, 6);
    const cv = document.createElement('canvas'); cv.width = CARD.w; cv.height = CARD.h; const c = cv.getContext('2d');
    await fontsReady(); cardHead(c, await logoImg(), t('Today’s shortlist') + ' · ' + dshort(TODAY));
    const p = CARD.pad; let y = 250;
    c.fillStyle = CP.ink; c.font = cFont(50, 700); c.fillText(t('Open and upcoming IPOs, best first'), p, y); y += 36;
    if (!rows.length) { c.fillStyle = CP.muted; c.font = cFont(30, 400); c.fillText(t('Nothing open or upcoming has a read right now.'), p, y + 40); }
    for (const r of rows) {
      const s = r.score, i = r.eff, tier = tierOf(r);
      c.fillStyle = CP.surface; rr(c, p, y, CARD.w - 2 * p, 132, 22); c.fill(); c.strokeStyle = CP.hair; c.lineWidth = 2; c.stroke();
      c.fillStyle = CP.ink; c.font = cFont(32, 700); wrapT(c, i.name + (i.board === 'sme' ? ' (SME)' : ''), p + 28, y + 52, 560, 36, 1);
      c.fillStyle = CP.ink2; c.font = cFont(24, 400); c.fillText((r.st === 'open' ? t('Apply by {d}', { d: dshort(i.close_date) }) : t('Opens {d}', { d: dshort(i.open_date) })) + '  ·  ' + pct0(s.p_up) + ' ' + t('chance'), p + 28, y + 96);
      const [fg, bg] = VC[tier] || VC.nodata; c.font = cFont(26, 700); const pw = c.measureText(vlabel(tier)).width + 48;
      pillC(c, CARD.w - p - pw - 26, y + 40, vlabel(tier), fg, bg, 26);
      y += 148; if (y > CARD.h - 250) break;
    }
    cardFoot(c); return cv;
  }
  function openCard(title, draw, name, caption) {
    const pv = el('div', { class: 'preview' }, el('span', { class: 'spin' }));
    let data = null;
    const shareB = el('button', { type: 'button', class: 'btn primary', disabled: true, onclick: () => { if (data) shareImage(name, data, caption); } }, icon('share'), t('Share'));
    openSheet(title, [pv, el('div', { class: 'btn-row' }, shareB, el('button', { type: 'button', class: 'btn', onclick: () => shareText(caption, title) }, t('Share as text'))), el('p', { class: 'tiny muted', text: t('Sends as a picture with a short summary as the caption.') })]);
    Promise.resolve().then(draw).then(cv => { data = cv.toDataURL('image/png'); pv.replaceChildren(el('img', { src: data, alt: title })); shareB.disabled = false; }).catch(() => pv.replaceChildren(el('p', { class: 'muted', text: t('Could not draw the picture on this phone. Share as text instead.') })));
  }
  function shareIpoCard(r) { openCard(r.eff.name, () => drawIpoCard(r), r.eff.name.replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) + '-ipo-radar.png', readText(r)); }
  function shareShortlistCard() { openCard(t('Today’s shortlist'), drawShortlistCard, 'ipo-radar-shortlist-' + TODAY + '.png', shortlistText()); }

  // ---------------------------------------------------------------- boot ---
  let bound = false;
  function bindOnce() {
    if (bound) return; bound = true;
    $('#refresh').addEventListener('click', doRefresh);
    $('#fresh').addEventListener('click', dataSheet);
    $('#brand').addEventListener('click', () => go('home'));
    $('#back').addEventListener('click', leaveDetail);
    $('#sheet-close').addEventListener('click', closeSheet);
    $('#sheet').addEventListener('click', (ev) => { if (ev.target === ev.currentTarget) closeSheet(); });
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeSheet(); });
    // any element with data-term opens its plain-language explanation
    document.addEventListener('click', (ev) => { const tm = ev.target.closest && ev.target.closest('[data-term]'); if (!tm) return; ev.preventDefault(); ev.stopPropagation(); openExplain(tm.dataset.term); }, true);
    // relative times and "today" stay true while the app stays open
    setInterval(() => { const d = istDate(); if (d !== TODAY) rerender(); else renderTop(); }, 60000);
  }
  function boot(payload) {
    applyPrefs(); bindOnce();
    setData(payload); computeAll();
    const r = parseHash();
    if (r.tab === 'ipo' && BYID.has(r.id)) { UI.prevTab = 'ipos'; UI.ipo = r.id; UI.tab = 'ipo'; setHash('home', false); setHash('ipo/' + encodeURIComponent(r.id), true); pushedDetail = true; }
    else { const tb = r.tab || load('tab', 'home'); UI.tab = SCREENS.includes(tb) && tb !== 'ipo' ? tb : 'home'; setHash(UI.tab, false); }
    renderTop(); show({ top: true });
  }
  // The Android shell hands in fresher data. Re-render in place: same screen, same filters, same scroll.
  window.ipoRadarLoad = function (payload) {
    if (!payload || !payload.live) return;
    try {
      // never step back in time: a downloaded snapshot older than the one already
      // shown (e.g. the copy bundled in a newer app build) is ignored
      const now = dataAgeMs(), inc = Date.parse(payload.live.generated_at || '');
      if (now && isFinite(inc) && inc < now) { if (manual) { toast(t('You already have the latest data')); manual = false; } return; }
      setData(payload); rerender();
      if (UI.tab === 'ipo' && !BYID.has(UI.ipo)) go('ipos');
      if (manual) { toast(t('Updated with the latest data')); manual = false; }
    } catch (e) { console.error('ipoRadarLoad failed', e); }
  };

  // Hindi translations, keyed by the English text passed to t().
  const HI = {
    "cr": "करोड़",
    "lakh": "लाख",
    "unknown": "पता नहीं",
    "just now": "अभी-अभी",
    "{n} min ago": "{n} मिनट पहले",
    "{n} h ago": "{n} घंटे पहले",
    "{n} days ago": "{n} दिन पहले",
    "today": "आज",
    "tomorrow": "कल",
    "yesterday": "कल",
    "almost every": "लगभग हर",
    "almost no": "लगभग कोई नहीं",
    "about {n} in 10": "10 में से लगभग {n}",
    "Everyone": "सभी को",
    "1 in {n}": "{n} में से 1",
    "SME": "SME",
    "Mainboard": "मेनबोर्ड",
    "Bidding opens": "बोली शुरू",
    "Apply through your broker or bank (UPI)": "अपने ब्रोकर या बैंक (UPI) से आवेदन करें",
    "Last day to apply": "आवेदन का आखिरी दिन",
    "UPI mandates must be approved by 5 pm": "UPI मैंडेट शाम 5 बजे तक अप्रूव करना ज़रूरी है",
    "Allotment result": "अलॉटमेंट रिज़ल्ट",
    "Find out if you got shares": "जानें कि आपको शेयर मिले या नहीं",
    "Money back or shares in demat": "पैसा वापस या शेयर demat में",
    "Blocked money is released if you got nothing": "शेयर नहीं मिले तो ब्लॉक पैसा वापस खुल जाता है",
    "Listing day": "लिस्टिंग का दिन",
    "Shares start trading; most sell the same day": "शेयरों की ट्रेडिंग शुरू; ज़्यादातर लोग उसी दिन बेच देते हैं",
    "Last day to apply: today, till 5 pm": "आवेदन का आखिरी दिन: आज, शाम 5 बजे तक",
    "Last day to apply: tomorrow": "आवेदन का आखिरी दिन: कल",
    "Apply by {d}": "{d} तक आवेदन करें",
    "Dates not announced yet": "तारीखें अभी घोषित नहीं हुईं",
    "Opens today": "आज खुल रहा है",
    "Opens tomorrow": "कल खुलेगा",
    "Opens {d}": "{d} को खुलेगा",
    "Allotment result today": "अलॉटमेंट रिज़ल्ट आज",
    "Lists {d}": "{d} को लिस्टिंग",
    "Bidding closed": "बोली बंद",
    "Listed {d}": "{d} को लिस्ट हुआ",
    "{p} chance of a listing gain": "लिस्टिंग गेन का {p} मौका",
    "No estimate yet": "अभी कोई अनुमान नहीं",
    "Likely gain from {a} to {b}, most likely {m}": "संभावित फ़ायदा {a} से {b}, सबसे संभावित {m}",
    "Bad case": "बुरी स्थिति",
    "Good case": "अच्छी स्थिति",
    "What does this mean?": "इसका मतलब क्या है?",
    "It listed on {d}": "यह {d} को लिस्ट हुआ,",
    "versus its issue price on day one.": "पहले दिन इश्यू प्राइस के मुकाबले।",
    "It has listed. The first-day result has not been recorded yet.": "यह लिस्ट हो चुका है। पहले दिन का नतीजा अभी दर्ज नहीं हुआ है।",
    "Before listing we gave it a {p} chance of a gain and called it “{v}”.": "लिस्टिंग से पहले हमने इसे फ़ायदे का {p} मौका दिया था और इसे “{v}” कहा था।",
    "Today it trades at": "आज इसका भाव",
    "against the issue price.": "है, इश्यू प्राइस के मुकाबले।",
    "We will have a first read once a grey-market price or demand figures appear.": "ग्रे-मार्केट प्राइस या डिमांड के आंकड़े आते ही हम पहला अंदाज़ा देंगे।",
    "Of 10 IPOs that looked like this one,": "इसके जैसे 10 IPO में से",
    "about {n}": "लगभग {n}",
    "ended their first day above the issue price.": "पहले दिन इश्यू प्राइस से ऊपर बंद हुए।",
    "If you get shares, the most likely result is": "शेयर मिले तो सबसे संभावित नतीजा है",
    "on {inv} after charges and tax.": "{inv} पर, चार्ज और टैक्स के बाद।",
    "Everyone who applies gets shares right now.": "अभी आवेदन करने वाले सभी को शेयर मिल रहे हैं।",
    "Shares go by lottery: roughly {a} applicants gets them.": "शेयर लॉटरी से मिलते हैं: लगभग {a} आवेदकों को मिलते हैं।",
    "Your chance of getting shares will show once retail demand is known.": "रिटेल डिमांड पता चलते ही शेयर मिलने का आपका मौका दिखेगा।",
    "Watching": "वॉचलिस्ट में",
    "your numbers": "आपके नंबर",
    "{o} similar IPOs listed above their price.": "{o} मिलते-जुलते IPO अपने प्राइस से ऊपर लिस्ट हुए।",
    "You need": "ज़रूरी रकम",
    "Likely gain": "संभावित फ़ायदा",
    "Get shares": "शेयर मिलना",
    "later": "बाद में",
    "Day one": "पहला दिन",
    "Now": "अभी",
    "We said": "हमने कहा",
    "Something went wrong drawing this screen. Pull down to refresh; if it keeps happening, tell us from More → Get help.": "यह स्क्रीन दिखाने में कुछ गड़बड़ हुई। रिफ़्रेश के लिए नीचे खींचें; बार-बार हो तो और → मदद लें से हमें बताएं।",
    "Updating…": "अपडेट हो रहा है…",
    "Offline": "ऑफ़लाइन",
    "Update failed": "अपडेट नहीं हुआ",
    "Updated {r}": "{r} अपडेट हुआ",
    "Data status: {s}. Tap for details.": "डेटा स्थिति: {s}। जानकारी के लिए टैप करें।",
    "Live refresh works in the Android app. This page shows the data it was built with.": "लाइव रिफ़्रेश Android ऐप में काम करता है। यह पेज बनते समय का डेटा दिखाता है।",
    "Could not update. Showing the last saved data.": "अपडेट नहीं हो सका। आखिरी सेव किया गया डेटा दिखा रहे हैं।",
    "Already up to date": "पहले से अपडेटेड है",
    "Prices and demand as of": "प्राइस और डिमांड, इस समय तक:",
    "Last downloaded": "आखिरी डाउनलोड",
    "bundled with the app": "ऐप के साथ आया हुआ",
    "Background refresh": "बैकग्राउंड रिफ़्रेश",
    "every {n} h": "हर {n} घंटे",
    "Model": "मॉडल",
    "fitted on {n} past listings": "{n} पुरानी लिस्टिंग पर तैयार",
    "starting weights (not yet fitted)": "शुरुआती वेट (अभी तैयार नहीं)",
    "Data checks found {n} thing(s) to be careful about. See More → Data quality.": "डेटा जांच में {n} बात(ें) मिलीं जिन पर ध्यान देना है। देखें और → डेटा क्वालिटी।",
    "All automatic data checks passed.": "सभी ऑटोमैटिक डेटा जांच पास हुईं।",
    "The data is refreshed from public sources several times on every trading day. Pull down on any screen, or tap the refresh button, to fetch the latest.": "हर ट्रेडिंग दिन पब्लिक सोर्स से डेटा कई बार रिफ़्रेश होता है। नया डेटा लाने के लिए किसी भी स्क्रीन को नीचे खींचें या रिफ़्रेश बटन दबाएं।",
    "Refresh now": "अभी रिफ़्रेश करें",
    "About this data": "इस डेटा के बारे में",
    "New here? Three things to know": "नए हैं? तीन बातें जान लें",
    "Start with the coloured label.": "रंगीन लेबल से शुरू करें।",
    "Apply, Leaning yes, 50-50 gamble, Avoid or Too early. It already weighs everything else.": "आवेदन करें, शायद हाँ, 50-50 जुआ, बचें या अभी जल्दी। इसमें बाकी सब पहले से तौला गया है।",
    "“70%” means 7 in 10.": "“70%” का मतलब है 10 में से 7।",
    "Of ten IPOs that looked like this one, about seven ended their first day above the issue price. It is not the profit you will make.": "इसके जैसे दस IPO में से लगभग सात पहले दिन इश्यू प्राइस से ऊपर बंद हुए। यह आपका मुनाफ़ा नहीं है।",
    "Most people get no shares.": "ज़्यादातर लोगों को शेयर नहीं मिलते।",
    "Popular IPOs are given out by lottery. Your money is simply returned in a few days if you are not picked.": "लोकप्रिय IPO लॉटरी से बंटते हैं। नाम नहीं आया तो कुछ दिनों में आपका पैसा वापस मिल जाता है।",
    "Got it": "समझ गया",
    "Read the 1-minute guide": "1 मिनट की गाइड पढ़ें",
    "Last day to apply: {n}": "आवेदन का आखिरी दिन: {n}",
    "UPI approval needed by 5 pm": "UPI अप्रूवल शाम 5 बजे तक ज़रूरी",
    "Allotment result today: {n}": "अलॉटमेंट रिज़ल्ट आज: {n}",
    "Check on the {r} website": "{r} की वेबसाइट पर देखें",
    "Tap to see how to check": "कैसे देखें, जानने के लिए टैप करें",
    "{n} lists today": "{n} की लिस्टिंग आज",
    "Trading starts at 10 am. Most people sell the same day.": "ट्रेडिंग सुबह 10 बजे शुरू होती है। ज़्यादातर लोग उसी दिन बेच देते हैं।",
    "{n} opens {d}": "{n} {d} को खुलेगा",
    "Opens": "खुलेगा",
    "Last day": "आखिरी दिन",
    "Allotment": "अलॉटमेंट",
    "Lists": "लिस्टिंग",
    "When we said": "जब हमने कहा",
    "Apply": "आवेदन करें",
    "or": "या",
    "Leaning yes": "शायद हाँ",
    "{u} of {n} IPOs listed above their price.": "{n} में से {u} IPO अपने प्राइस से ऊपर लिस्ट हुए।",
    "Every call is saved before listing and checked against what actually happened. Nothing is edited afterwards.": "हर राय लिस्टिंग से पहले सेव होती है और असली नतीजे से मिलाई जाती है। बाद में कुछ भी बदला नहीं जाता।",
    "Our track record": "हमारा रिकॉर्ड",
    "See every call": "हर राय देखें",
    "No IPO is open for bidding today": "आज कोई IPO बोली के लिए खुला नहीं है",
    "1 IPO is open for bidding": "1 IPO बोली के लिए खुला है",
    "{n} IPOs are open for bidding": "{n} IPO बोली के लिए खुले हैं",
    "None of them looks like a clear yes.": "इनमें से कोई भी साफ़ हाँ नहीं लगता।",
    "1 of them looks worth applying.": "इनमें से 1 में आवेदन करना ठीक लगता है।",
    "{n} of them look worth applying.": "इनमें से {n} में आवेदन करना ठीक लगता है।",
    "Next to open: {n}, {d}.": "अगला खुलेगा: {n}, {d}।",
    "Open now": "अभी खुले",
    "Opening soon": "जल्द खुलेंगे",
    "Listing this week": "इस हफ़्ते लिस्टिंग",
    "Needs your attention": "आपका ध्यान चाहिए",
    "Best right now": "अभी सबसे अच्छे",
    "See all": "सब देखें",
    "Nothing open or upcoming has enough information for a call yet.": "खुले या आने वाले किसी IPO पर राय देने लायक जानकारी अभी नहीं है।",
    "Coming up": "आने वाले",
    "Your watchlist": "आपकी वॉचलिस्ट",
    "Not investment advice. A 75% chance of a gain is a 25% chance of a loss.": "यह निवेश सलाह नहीं है। फ़ायदे का 75% मौका यानी नुकसान का 25% मौका।",
    "a Layerbit tool": "Layerbit का टूल",
    "No IPO matches “{q}”.": "“{q}” से कोई IPO नहीं मिला।",
    "Your watchlist is empty. Open any IPO and tap Watch.": "आपकी वॉचलिस्ट खाली है। कोई भी IPO खोलें और वॉच दबाएं।",
    "Nothing here right now.": "अभी यहां कुछ नहीं है।",
    "Show all IPOs": "सभी IPO दिखाएं",
    "IPOs": "IPO",
    "Every mainboard and SME IPO in India. Tap one for the full picture.": "भारत के सभी मेनबोर्ड और SME IPO। पूरी जानकारी के लिए किसी पर टैप करें।",
    "Search by company name": "कंपनी के नाम से खोजें",
    "Filter by status": "स्थिति से फ़िल्टर करें",
    "Board": "बोर्ड",
    "Sort": "क्रम",
    "This IPO is no longer in the data.": "यह IPO अब डेटा में नहीं है।",
    "Back to IPOs": "IPO पर वापस",
    "Chance of ending day one above the issue price": "पहले दिन इश्यू प्राइस से ऊपर बंद होने का मौका",
    "Sure gamble": "पक्का जुआ",
    "Possible gamble": "शायद जुआ",
    "Watch": "वॉच",
    "Share": "शेयर करें",
    "My application": "मेरा आवेदन",
    "I applied": "मैंने आवेदन किया",
    "The chance figures are first estimates: the model is still on its starting weights until it has enough past listings to check itself against.": "मौके के आंकड़े शुरुआती अनुमान हैं: जब तक मॉडल के पास खुद को जांचने लायक पुरानी लिस्टिंग नहीं होतीं, वह शुरुआती वेट पर चलता है।",
    "Why?": "क्यों?",
    "Grey-market quotes from different sources disagree a lot for this IPO. Treat the premium with extra caution.": "इस IPO के लिए अलग-अलग सोर्स के ग्रे-मार्केट भाव में बहुत फ़र्क है। प्रीमियम को ज़्यादा सावधानी से देखें।",
    "Our automatic checks flagged something odd in this IPO’s data. Double-check the numbers before deciding.": "हमारी ऑटोमैटिक जांच को इस IPO के डेटा में कुछ अजीब मिला। फ़ैसले से पहले नंबर दोबारा जांच लें।",
    "The grey-market quote is 3 or more days old.": "ग्रे-मार्केट भाव 3 या ज़्यादा दिन पुराना है।",
    "Minimum to apply": "आवेदन के लिए कम से कम",
    "{m} lots of {l} shares at ₹{p}": "{l} शेयर के {m} लॉट, ₹{p} पर",
    "1 lot of {l} shares at ₹{p}": "{l} शेयर का 1 लॉट, ₹{p} पर",
    "lot size not announced": "लॉट साइज़ घोषित नहीं",
    "Chance of getting shares": "शेयर मिलने का मौका",
    "everyone who applies": "आवेदन करने वाले सभी को",
    "retail asked for {x} the shares on offer": "रिटेल ने ऑफ़र किए शेयरों का {x} मांगा",
    "known once bidding starts": "बोली शुरू होने पर पता चलेगा",
    "no demand figures yet": "अभी डिमांड के आंकड़े नहीं",
    "most likely; range {a} to {b}": "सबसे संभावित; रेंज {a} से {b}",
    "Worth per application": "प्रति आवेदन फ़ायदा",
    "average, counting the lottery, after charges and tax": "औसत, लॉटरी को गिनकर, चार्ज और टैक्स के बाद",
    "needs demand figures": "डिमांड के आंकड़े चाहिए",
    "The numbers": "आंकड़े",
    "Where the listing-day gain could land": "लिस्टिंग के दिन फ़ायदा कहां तक जा सकता है",
    "not announced": "घोषित नहीं",
    "Key dates": "ज़रूरी तारीखें",
    "~ marks a date estimated from SEBI’s T+3 timetable; the company’s own dates replace it when announced.": "~ वाली तारीख SEBI के T+3 टाइमटेबल से अनुमानित है; कंपनी की अपनी तारीखें आने पर बदल दी जाती है।",
    "Nothing to report yet.": "अभी बताने को कुछ नहीं।",
    "Why we say this": "हम ऐसा क्यों कहते हैं",
    "Past {b} IPOs with a premium of {k}: {u} of {n} listed up; typical gain {m}.": "{k} प्रीमियम वाले पिछले {b} IPO: {n} में से {u} ऊपर लिस्ट हुए; आम फ़ायदा {m}।",
    "How it did": "इसका प्रदर्शन",
    "closed at ₹{c} (issue ₹{p})": "₹{c} पर बंद (इश्यू ₹{p})",
    "We said before listing": "लिस्टिंग से पहले हमने कहा",
    "{p} chance of a gain · saved {d}": "फ़ायदे का {p} मौका · {d} को सेव",
    "reconstructed": "बाद में बनाया गया",
    "no saved call for this one": "इसके लिए कोई सेव राय नहीं",
    "Since listing, versus the issue price": "लिस्टिंग के बाद से, इश्यू प्राइस के मुकाबले",
    "Last price ₹{p} on {d}.": "{d} को आखिरी प्राइस ₹{p}।",
    "Big investors who bought before the IPO (anchors) may sell from {a} (half) and {b} (rest). Prices often dip around these dates.": "IPO से पहले खरीदने वाले बड़े निवेशक (एंकर) {a} से (आधे) और {b} से (बाकी) बेच सकते हैं। इन तारीखों के आसपास प्राइस अक्सर गिरता है।",
    "Did you get shares?": "क्या आपको शेयर मिले?",
    "The allotment result is published by the registrar. Check with your PAN number. You can also see it in your broker app or bank statement.": "अलॉटमेंट रिज़ल्ट रजिस्ट्रार जारी करता है। अपने PAN नंबर से देखें। आप इसे अपने ब्रोकर ऐप या बैंक स्टेटमेंट में भी देख सकते हैं।",
    "Check on {r}": "{r} पर देखें",
    "Back-test on past IPOs": "पिछले IPO पर जाँच",
    "These {b} calls were worked out afterwards, from the numbers known before each IPO listed. The model learned from these same IPOs, so real results will likely be a little worse. Live calls, saved before listing and never edited, start from {d}.": "ये {b} अनुमान बाद में, हर IPO की लिस्टिंग से पहले मौजूद आंकड़ों से निकाले गए। मॉडल ने इन्हीं IPO से सीखा है, इसलिए असली नतीजे थोड़े कमज़ोर हो सकते हैं। लिस्टिंग से पहले सेव होने वाले और कभी न बदलने वाले लाइव अनुमान {d} से शुरू हैं।",
    "Our record on past IPOs (back-test)": "पिछले IPO पर हमारा रिकॉर्ड (बैक-टेस्ट)",
    "You already have the latest data": "आपके पास पहले से नया डेटा है",
    "registrar": "रजिस्ट्रार",
    "Check on BSE": "BSE पर देखें",
    "Registrar not captured for this IPO; the exchange pages work for every issue.": "इस IPO का रजिस्ट्रार हमारे पास नहीं है; एक्सचेंज के पेज हर इश्यू के लिए काम करते हैं।",
    "Your money, if you get shares": "शेयर मिले तो आपका पैसा",
    "Money blocked when you apply": "आवेदन पर ब्लॉक होने वाला पैसा",
    "Sold on listing day at the likely gain ({g})": "लिस्टिंग के दिन संभावित फ़ायदे ({g}) पर बेचा",
    "Profit before costs": "खर्च से पहले मुनाफ़ा",
    "Broker & exchange charges": "ब्रोकर और एक्सचेंज चार्ज",
    "Tax on the profit": "मुनाफ़े पर टैक्स",
    "In your hand": "आपके हाथ में",
    "On a bad day ({g})": "बुरे दिन पर ({g})",
    "If you get no shares, the full amount is unblocked within a few days and you lose nothing. Change your broker in the Planner.": "शेयर नहीं मिले तो पूरी रकम कुछ दिनों में अनब्लॉक हो जाती है और आपका कोई नुकसान नहीं होता। प्लानर में अपना ब्रोकर बदलें।",
    "Demand: how many times over people bid": "डिमांड: लोगों ने कितने गुना बोली लगाई",
    "Big institutions": "बड़े संस्थान",
    "Wealthy investors": "अमीर निवेशक",
    "Individuals (you)": "आम निवेशक (आप)",
    "Retail (you)": "रिटेल (आप)",
    "Overall": "कुल",
    "Bidding has not started. Demand figures appear from the first bidding day.": "बोली अभी शुरू नहीं हुई। डिमांड के आंकड़े बोली के पहले दिन से दिखेंगे।",
    "No demand figures captured yet.": "अभी डिमांड के आंकड़े नहीं मिले।",
    "Bidding is still on; big institutions usually bid on the last day.": "बोली अभी चल रही है; बड़े संस्थान आमतौर पर आखिरी दिन बोली लगाते हैं।",
    "Final figures after bidding closed.": "बोली बंद होने के बाद के फ़ाइनल आंकड़े।",
    "“10x” means people asked for ten times the shares on offer.": "“10x” का मतलब है लोगों ने ऑफ़र किए शेयरों से दस गुना मांगे।",
    "Grey-market premium (unofficial)": "ग्रे-मार्केट प्रीमियम (अनौपचारिक)",
    "What unofficial dealers pay over the issue price before listing.": "लिस्टिंग से पहले अनौपचारिक डीलर इश्यू प्राइस से ऊपर कितना देते हैं।",
    "Read the caveats": "सावधानियां पढ़ें",
    "Nobody is quoting a premium for this IPO.": "इस IPO के लिए कोई प्रीमियम नहीं बता रहा।",
    "No premium quote yet.": "अभी कोई प्रीमियम भाव नहीं।",
    "Premium now": "अभी प्रीमियम",
    "₹{r} a share": "₹{r} प्रति शेयर",
    "Implied listing price": "अनुमानित लिस्टिंग प्राइस",
    "if the premium holds": "अगर प्रीमियम बना रहे",
    "Premium over the last {n} quotes": "पिछले {n} भावों में प्रीमियम",
    "Quotes from {n} sources (we use the middle one)": "{n} सोर्स के भाव (हम बीच वाला लेते हैं)",
    "Premium went from ₹{a} to ₹{b}": "प्रीमियम ₹{a} से ₹{b} हुआ",
    "About the issue": "इश्यू के बारे में",
    "Price band": "प्राइस बैंड",
    "Issue price": "इश्यू प्राइस",
    "Lot size": "लॉट साइज़",
    "shares": "शेयर",
    "Total issue size": "कुल इश्यू साइज़",
    "New money for the company": "कंपनी के लिए नया पैसा",
    "Existing owners selling": "मौजूदा मालिकों की बिक्री",
    "Raised from anchor investors": "एंकर निवेशकों से जुटाया",
    "Anchor lock-in ends (half / rest)": "एंकर लॉक-इन खत्म (आधा / बाकी)",
    "Face value": "फ़ेस वैल्यू",
    "Registrar": "रजिस्ट्रार",
    "Details not captured yet.": "जानकारी अभी नहीं मिली।",
    "Try your own numbers": "अपने नंबर डालकर देखें",
    "Heard a newer premium, or the latest demand figures? Type them and everything above updates. Only on this phone.": "नया प्रीमियम या ताज़ा डिमांड के आंकड़े सुने? उन्हें डालें और ऊपर सब अपडेट हो जाएगा। सिर्फ़ इसी फ़ोन पर।",
    "Premium ₹ per share": "प्रीमियम ₹ प्रति शेयर",
    "Institutions (x)": "संस्थान (x)",
    "Wealthy (x)": "अमीर (x)",
    "Retail (x)": "रिटेल (x)",
    "Updated with your numbers": "आपके नंबरों से अपडेट",
    "Recalculate": "फिर से गिनें",
    "Reset": "रीसेट",
    "Where these numbers come from": "ये नंबर कहां से आते हैं",
    "Exchange filings and public IPO trackers.": "एक्सचेंज फ़ाइलिंग और पब्लिक IPO ट्रैकर।",
    "Data as of {d}. Something looks wrong? Tell us from More → Get help.": "डेटा {d} तक का। कुछ गलत लगे? और → मदद लें से हमें बताएं।",
    "Removed from your watchlist": "आपकी वॉचलिस्ट से हटाया",
    "Added. We will remind you before bidding closes.": "जोड़ दिया। बोली बंद होने से पहले हम याद दिलाएंगे।",
    "Added to your watchlist": "आपकी वॉचलिस्ट में जोड़ा",
    "Fewer": "कम",
    "More": "और",
    "Planner": "प्लानर",
    "How much can IPOs realistically make you? Tell us your budget and how many demat accounts your family can apply from.": "IPO से असल में कितना कमा सकते हैं? अपना बजट बताएं और यह भी कि आपका परिवार कितने demat अकाउंट से आवेदन कर सकता है।",
    "Money you can keep blocked (₹)": "कितना पैसा ब्लॉक रख सकते हैं (₹)",
    "Money you can keep blocked": "कितना पैसा ब्लॉक रख सकते हैं",
    "Monthly target (₹)": "महीने का टारगेट (₹)",
    "Monthly target": "महीने का टारगेट",
    "Demat accounts": "Demat अकाउंट",
    "(yours + family, each with its own PAN)": "(आपके + परिवार के, हर एक का अपना PAN)",
    "Your broker": "आपका ब्रोकर",
    "Custom charges": "अपने चार्ज",
    "Charges and tax used (edit if yours differ)": "लगाए गए चार्ज और टैक्स (आपके अलग हों तो बदलें)",
    "Your inputs stay on this phone.": "आपकी जानकारी इसी फ़ोन पर रहती है।",
    "Nothing open or upcoming has enough information to plan with right now. Check back when the next IPO opens.": "खुले या आने वाले किसी IPO में अभी प्लान करने लायक जानकारी नहीं है। अगला IPO खुलने पर फिर देखें।",
    "Expected profit from the ticked IPOs, across {n} account(s), after charges and tax": "टिक किए IPO से {n} अकाउंट पर अनुमानित मुनाफ़ा, चार्ज और टैक्स के बाद",
    "{p} of your target": "आपके टारगेट का {p}",
    "On paper, this covers your {t} target.": "कागज़ पर, इससे आपका {t} का टारगेट पूरा होता है।",
    "That is {p} of your {t} monthly target.": "यह आपके {t} के मासिक टारगेट का {p} है।",
    "Money blocked at once: {b}": "एक साथ ब्लॉक पैसा: {b}",
    "— more than the {c} you set. Untick some IPOs or use fewer accounts.": "— आपके तय {c} से ज़्यादा। कुछ IPO अनटिक करें या कम अकाउंट इस्तेमाल करें।",
    "of your {c}.": "— आपके {c} में से।",
    "Chance that none of these applications gets any shares: {p}. Profits come in lumps, not every month.": "इनमें से किसी भी आवेदन पर शेयर न मिलने का मौका: {p}। मुनाफ़ा कभी-कभार एक साथ आता है, हर महीने नहीं।",
    "Some ticked IPOs have no retail demand figures yet, so their lottery odds (and profit) are not counted.": "कुछ टिक किए IPO के रिटेल डिमांड आंकड़े अभी नहीं हैं, इसलिए उनकी लॉटरी के मौके (और मुनाफ़ा) नहीं गिने गए।",
    "At these odds you would need about {n} blocked per round to expect {t}. The share lottery, not the premium, sets the limit; more family accounts help most.": "इन मौकों पर {t} की उम्मीद के लिए हर बार लगभग {n} ब्लॉक करना होगा। सीमा प्रीमियम नहीं, शेयर लॉटरी तय करती है; परिवार के ज़्यादा अकाउंट सबसे ज़्यादा मदद करते हैं।",
    "If every application got shares, charges and tax would take {c} out of {g} profit. All figures above are after that.": "अगर हर आवेदन पर शेयर मिलें, तो {g} मुनाफ़े में से {c} चार्ज और टैक्स में जाएगा। ऊपर के सभी आंकड़े उसके बाद के हैं।",
    "Include {n}": "{n} शामिल करें",
    "blocked": "ब्लॉक",
    "odds not known yet": "मौके अभी पता नहीं",
    "{p} chance at least one account gets shares": "कम से कम एक अकाउंट को शेयर मिलने का {p} मौका",
    "{v} if you get shares": "शेयर मिले तो {v}",
    "expected": "अनुमानित",
    "Choose IPOs": "IPO चुनें",
    "One minimum application per account per IPO. Bidding for more lots does not improve your odds in a popular IPO.": "हर IPO में हर अकाउंट से एक न्यूनतम आवेदन। लोकप्रिय IPO में ज़्यादा लॉट की बोली से आपका मौका नहीं बढ़ता।",
    "Come back after the allotment result to record whether you got shares.": "अलॉटमेंट रिज़ल्ट के बाद वापस आएं और दर्ज करें कि शेयर मिले या नहीं।",
    "How many accounts got shares?": "कितने अकाउंट को शेयर मिले?",
    "Accounts that got shares": "जिन अकाउंट को शेयर मिले",
    "listing close ₹{c}": "लिस्टिंग क्लोज़ ₹{c}",
    "Price you sold at (per share)": "आपने किस प्राइस पर बेचा (प्रति शेयर)",
    "Leave empty to use the listing-day close.": "लिस्टिंग के दिन का क्लोज़ प्राइस लेने के लिए खाली छोड़ें।",
    "Keep a private record of your IPO applications and see what you really made. Saved only on this phone.": "अपने IPO आवेदनों का निजी रिकॉर्ड रखें और देखें आपने असल में कितना कमाया। सिर्फ़ इसी फ़ोन पर सेव।",
    "How many accounts did you apply from?": "आपने कितने अकाउंट से आवेदन किया?",
    "Accounts applied": "आवेदन वाले अकाउंट",
    "Saved to My IPOs": "मेरे IPO में सेव हुआ",
    "Save": "सेव करें",
    "Removed": "हटाया गया",
    "Remove": "हटाएं",
    "My IPOs": "मेरे IPO",
    "Record the IPOs you apply for (open any IPO → I applied) and see your real hit rate and profit here.": "जिन IPO में आवेदन करें उन्हें दर्ज करें (कोई IPO खोलें → मैंने आवेदन किया) और यहां अपना असली हिट रेट और मुनाफ़ा देखें।",
    "Applications": "आवेदन",
    "Got shares": "शेयर मिले",
    "Profit after costs": "खर्च के बाद मुनाफ़ा",
    "{a} account(s)": "{a} अकाउंट",
    "{g} got shares": "{g} को शेयर मिले",
    "result pending": "रिज़ल्ट बाकी",
    "* Where you did not enter a sale price, the listing-day close is used.": "* जहां आपने बिक्री प्राइस नहीं डाला, वहां लिस्टिंग के दिन का क्लोज़ लिया गया है।",
    "Track record": "रिकॉर्ड",
    "Every call is saved when bidding closes, before anyone knows the result, and checked after listing. Nothing is edited later, so you can judge us on our record.": "हर राय बोली बंद होते ही, नतीजा पता चलने से पहले, सेव होती है और लिस्टिंग के बाद जांची जाती है। बाद में कुछ नहीं बदला जाता, ताकि आप हमें हमारे रिकॉर्ड से परख सकें।",
    "Saved before listing · never edited": "लिस्टिंग से पहले सेव · कभी नहीं बदला",
    "{u} of {n}": "{n} में से {u}",
    "IPOs listed above their issue price.": "IPO इश्यू प्राइस से ऊपर लिस्ट हुए।",
    "Across all IPOs in the same period, {b} did.": "उसी दौरान सभी IPO में, {b} ऊपर लिस्ट हुए।",
    "{a} calls were saved live; {b} older ones were reconstructed from the data we had before they listed and are marked as such.": "{a} राय लाइव सेव हुईं; {b} पुरानी राय लिस्टिंग से पहले के डेटा से बाद में बनाई गईं और उन पर यह निशान लगा है।",
    "{u} of {n} listed up": "{n} में से {u} ऊपर लिस्ट हुए",
    "typical {g}": "आम तौर पर {g}",
    "How each label turned out": "हर लेबल का नतीजा",
    "Green: listed above the issue price. Red: at or below. A good label system shows mostly green at the top and more red at the bottom.": "हरा: इश्यू प्राइस से ऊपर लिस्ट हुआ। लाल: बराबर या नीचे। अच्छे लेबल सिस्टम में ऊपर ज़्यादातर हरा और नीचे ज़्यादा लाल दिखता है।",
    "Our chances were more accurate than going by the grey-market premium alone.": "हमारे मौके सिर्फ़ ग्रे-मार्केट प्रीमियम देखने से ज़्यादा सही रहे।",
    "Our chances were not yet more accurate than going by the grey-market premium alone. We show this because hiding it would be dishonest.": "हमारे मौके अभी सिर्फ़ ग्रे-मार्केट प्रीमियम देखने से ज़्यादा सही नहीं रहे। हम यह दिखाते हैं क्योंकि इसे छिपाना बेईमानी होगी।",
    "Accuracy score (lower is better): ours {a}, premium-only {b}.": "सटीकता स्कोर (कम बेहतर): हमारा {a}, सिर्फ़ प्रीमियम {b}।",
    "{p} of actual listing gains landed inside our “likely range”. The range is built to catch about 8 in 10.": "असली लिस्टिंग गेन में से {p} हमारी “संभावित रेंज” के अंदर रहे। यह रेंज 10 में से लगभग 8 को पकड़ने के लिए बनी है।",
    "The public record of our calls starts building as IPOs close and list. Until it has enough entries, the evidence below (how past IPOs actually listed) is the best check.": "IPO बंद और लिस्ट होने के साथ हमारी राय का पब्लिक रिकॉर्ड बनता है। जब तक काफ़ी एंट्री न हों, नीचे के सबूत (पुराने IPO असल में कैसे लिस्ट हुए) सबसे अच्छी जांच हैं।",
    "For the curious: the raw evidence": "जिज्ञासु लोगों के लिए: कच्चे सबूत",
    "Every saved call (raw file)": "हर सेव राय (कच्ची फ़ाइल)",
    "Change history": "बदलाव का इतिहास",
    "Every call, newest first": "हर राय, नई पहले",
    "we said": "हमने कहा",
    "Our call was right": "हमारी राय सही रही",
    "Our call was wrong": "हमारी राय गलत रही",
    "We called it a toss-up": "हमने इसे 50-50 कहा था",
    "Show all {n}": "सभी {n} दिखाएं",
    "✓ the call was right (said yes and it listed up, or said avoid and it did not), ✗ wrong, – a 50-50 or too-early call.": "✓ राय सही रही (हाँ कहा और ऊपर लिस्ट हुआ, या बचें कहा और ऊपर नहीं हुआ), ✗ गलत, – 50-50 या अभी जल्दी वाली राय।",
    "How the chances are worked out": "मौके कैसे निकाले जाते हैं",
    "A statistical model learns from past Indian listings how the grey-market premium, demand from each investor group, the issue size and the market mood turned into first-day results, then applies that to each new IPO.": "एक स्टैटिस्टिकल मॉडल पुरानी भारतीय लिस्टिंग से सीखता है कि ग्रे-मार्केट प्रीमियम, हर निवेशक ग्रुप की डिमांड, इश्यू साइज़ और बाज़ार के मूड से पहले दिन के नतीजे कैसे बने, फिर इसे हर नए IPO पर लगाता है।",
    "Fitted on {n} past listings and tested on IPOs it had not seen: it put a winner ahead of a loser {a} of the time (50% would be a coin toss).": "{n} पुरानी लिस्टिंग पर तैयार और अनदेखे IPO पर जांचा गया: इसने {a} बार फ़ायदे वाले को नुकसान वाले से ऊपर रखा (50% यानी सिक्का उछालना)।",
    "Still on documented starting weights: it needs {m} past listings with full figures to fit itself and has {n}. Until then, treat every chance as a first estimate.": "अभी लिखे हुए शुरुआती वेट पर चल रहा है: खुद को तैयार करने के लिए इसे पूरे आंकड़ों वाली {m} पुरानी लिस्टिंग चाहिए और अभी {n} हैं। तब तक हर मौके को शुरुआती अनुमान मानें।",
    "Read the full method": "पूरा तरीका पढ़ें",
    "When we say 70%, does it happen 7 times in 10?": "जब हम 70% कहते हैं, क्या 10 में से 7 बार ऐसा होता है?",
    "Dots on the dashed line mean the chances are honest. Above the line we were too cautious, below it too hopeful. Bigger dots hold more IPOs.": "डैश वाली लाइन पर बिंदु मतलब मौके सही हैं। लाइन से ऊपर हम ज़्यादा सावधान थे, नीचे ज़्यादा उम्मीद में। बड़े बिंदु में ज़्यादा IPO हैं।",
    "Predicted chance against how often IPOs actually listed up": "अनुमानित मौका बनाम IPO असल में कितनी बार ऊपर लिस्ट हुए",
    "chance we gave": "हमारा दिया मौका",
    "how often it listed up": "कितनी बार ऊपर लिस्ट हुआ",
    "{o} listed up": "{o} ऊपर लिस्ट हुए",
    "when we said {p}": "जब हमने {p} कहा",
    "{n} IPOs": "{n} IPO",
    "Show as a table": "टेबल में दिखाएं",
    "Listed up": "ऊपर लिस्ट हुए",
    "What the grey-market premium promised vs what listing day delivered": "ग्रे-मार्केट प्रीमियम ने क्या बताया बनाम लिस्टिंग के दिन क्या मिला",
    "Each dot is a past IPO. Dots below the dashed line listed worse than the premium suggested.": "हर बिंदु एक पुराना IPO है। डैश वाली लाइन से नीचे वाले बिंदु प्रीमियम के अंदाज़े से खराब लिस्ट हुए।",
    "Not enough past listings with both numbers yet.": "दोनों नंबरों वाली काफ़ी पुरानी लिस्टिंग अभी नहीं हैं।",
    "Premium before listing against the actual listing gain for {n} past IPOs": "{n} पुराने IPO के लिए लिस्टिंग से पहले का प्रीमियम बनाम असली लिस्टिंग गेन",
    "premium before listing": "लिस्टिंग से पहले प्रीमियम",
    "actual listing gain": "असली लिस्टिंग गेन",
    "premium {a}, listed {b}": "प्रीमियम {a}, लिस्टिंग {b}",
    "Of {n} IPOs with a positive premium, {k} ({p}) still listed at or below the issue price. A premium is a hint, not a promise.": "पॉज़िटिव प्रीमियम वाले {n} IPO में से {k} ({p}) फिर भी इश्यू प्राइस पर या उससे नीचे लिस्ट हुए। प्रीमियम एक इशारा है, वादा नहीं।",
    "IPO": "IPO",
    "Premium": "प्रीमियम",
    "Listed": "लिस्टिंग",
    "Past IPOs grouped by their premium": "पुराने IPO, प्रीमियम के हिसाब से",
    "No model, just counting. Find the row matching an IPO’s premium and see how many like it listed up.": "कोई मॉडल नहीं, सिर्फ़ गिनती। IPO के प्रीमियम वाली लाइन ढूंढें और देखें उसके जैसे कितने ऊपर लिस्ट हुए।",
    "Typical gain": "आम फ़ायदा",
    "What moves the chance up or down": "मौका किससे ऊपर या नीचे जाता है",
    "Bars to the right raise the chance, to the left lower it; longer is stronger.": "दाईं ओर के बार मौका बढ़ाते हैं, बाईं ओर के घटाते हैं; लंबा यानी ज़्यादा असर।",
    "All words used in this app": "इस ऐप के सभी शब्द",
    "Words used in this app": "इस ऐप के शब्द",
    "A decision aid, not a tip sheet.": "फ़ैसले में मदद, टिप शीट नहीं।",
    "A 75% chance of a gain is a 25% chance of a loss. Apply only with money that can stay blocked if a listing goes wrong, never with borrowed money.": "फ़ायदे का 75% मौका यानी नुकसान का 25% मौका। सिर्फ़ उसी पैसे से आवेदन करें जो लिस्टिंग खराब होने पर भी फंसा रह सके, उधार के पैसे से कभी नहीं।",
    "In plain words": "आसान शब्दों में",
    "We look at the grey-market premium, how many times over each investor group bid, the issue size and the market mood. From past listings the model has learned how these turned into first-day results.": "हम ग्रे-मार्केट प्रीमियम, हर निवेशक ग्रुप ने कितने गुना बोली लगाई, इश्यू साइज़ और बाज़ार का मूड देखते हैं। पुरानी लिस्टिंग से मॉडल ने सीखा है कि इनसे पहले दिन के नतीजे कैसे बने।",
    "We then count the lottery: in a popular IPO most applicants get nothing, so the profit is multiplied by your chance of getting shares before anything is called worth it.": "फिर हम लॉटरी गिनते हैं: लोकप्रिय IPO में ज़्यादातर आवेदकों को कुछ नहीं मिलता, इसलिए किसी को फ़ायदेमंद कहने से पहले मुनाफ़े को आपके शेयर मिलने के मौके से गुणा किया जाता है।",
    "Broker charges and tax come off every “in your hand” figure.": "हर “आपके हाथ में” आंकड़े से ब्रोकर चार्ज और टैक्स घटाए जाते हैं।",
    "When we are unsure we say so: Too early, Not enough info, and the gamble warnings.": "जब हमें यकीन नहीं होता तो हम बताते हैं: अभी जल्दी, जानकारी कम, और जुआ वाली चेतावनियां।",
    "The labels": "लेबल",
    "chance 75%+, likely gain 5%+, positive worth, no warnings. Mainboard only; an SME IPO tops out at Leaning yes.": "मौका 75%+, संभावित फ़ायदा 5%+, पॉज़िटिव वैल्यू, कोई चेतावनी नहीं। सिर्फ़ मेनबोर्ड; SME IPO ज़्यादा से ज़्यादा शायद हाँ तक जाता है।",
    "chance 60%+ with at most one warning, or a strong premium-only read.": "मौका 60%+ और ज़्यादा से ज़्यादा एक चेतावनी, या सिर्फ़ प्रीमियम से मज़बूत संकेत।",
    "chance 40–60%, or a better read pulled down by two or more warnings.": "मौका 40–60%, या बेहतर संकेत जो दो या ज़्यादा चेतावनियों से नीचे आ गया।",
    "chance under 40% or negative worth.": "मौका 40% से कम या नेगेटिव वैल्यू।",
    "only a premium so far and it does not justify a lean; decide on the last bidding day.": "अभी सिर्फ़ प्रीमियम है और उससे कोई झुकाव तय नहीं होता; बोली के आखिरी दिन फ़ैसला करें।",
    "What triggers a warning": "चेतावनी कब आती है",
    "A premium at or below zero or under 5%; a premium falling sharply; retail or institutions under-subscribed at close; only institutions bidding; any SME IPO; issues under ₹50 crore; a premium quote older than three days; an issue that is almost all offer-for-sale.": "प्रीमियम शून्य या उससे कम, या 5% से कम; प्रीमियम तेज़ी से गिरना; बंद होने पर रिटेल या संस्थानों का अंडर-सब्सक्राइब होना; सिर्फ़ संस्थानों की बोली; कोई भी SME IPO; ₹50 करोड़ से छोटे इश्यू; तीन दिन से पुराना प्रीमियम भाव; लगभग पूरा ऑफ़र-फ़ॉर-सेल वाला इश्यू।",
    "What nobody can know": "जो कोई नहीं जान सकता",
    "The grey market is unofficial and can be thin or steered, especially for small SME issues.": "ग्रे मार्केट अनौपचारिक है और कमज़ोर या प्रभावित हो सकता है, खासकर छोटे SME इश्यू में।",
    "A market shock on listing morning is in nobody’s pre-listing numbers.": "लिस्टिंग की सुबह बाज़ार का झटका किसी के भी पहले के नंबरों में नहीं होता।",
    "The model is fitted on {n} listings: enough to rank IPOs and flag gambles, not to promise a gain on any one IPO.": "मॉडल {n} लिस्टिंग पर तैयार है: IPO को रैंक करने और जुए को पहचानने के लिए काफ़ी, किसी एक IPO पर फ़ायदे का वादा करने के लिए नहीं।",
    "The model is not yet fitted to data; it runs on documented starting weights checked against recent outcomes.": "मॉडल अभी डेटा पर तैयार नहीं है; यह हाल के नतीजों से जांचे गए लिखे हुए शुरुआती वेट पर चलता है।",
    "Expected profit is an average over many applications; most months bring zero or one allotment.": "अनुमानित मुनाफ़ा कई आवेदनों का औसत है; ज़्यादातर महीनों में शून्य या एक अलॉटमेंट मिलता है।",
    "Technical summary": "तकनीकी सार",
    "Source code and data": "सोर्स कोड और डेटा",
    "How IPO Radar works": "IPO Radar कैसे काम करता है",
    "This snapshot has no automatic data-check report.": "इस स्नैपशॉट में ऑटोमैटिक डेटा-जांच रिपोर्ट नहीं है।",
    "Data quality": "डेटा क्वालिटी",
    "Some checks need attention. The numbers are still shown, with care flags on the affected IPOs.": "कुछ जांचों पर ध्यान देना है। नंबर फिर भी दिखाए गए हैं, असर वाले IPO पर सावधानी के निशान के साथ।",
    "working": "चालू",
    "down": "बंद",
    "Get help": "मदद लें",
    "A number that looks wrong, an IPO we missed, a broker whose charges differ, or an idea: tell the people who build this.": "कोई गलत लगता नंबर, कोई छूटा IPO, अलग चार्ज वाला ब्रोकर, या कोई आइडिया: इसे बनाने वालों को बताएं।",
    "Email us": "हमें ईमेल करें",
    "Chat on WhatsApp": "WhatsApp पर बात करें",
    "Most messages get a reply within one to two business days.": "ज़्यादातर मैसेज का जवाब एक-दो कामकाजी दिनों में मिलता है।",
    "Privacy": "प्राइवेसी",
    "IPO Radar has no account, no ads and no tracking.": "IPO Radar में न अकाउंट है, न विज्ञापन, न ट्रैकिंग।",
    "The app only downloads public data files. Nothing about you or your phone is sent.": "ऐप सिर्फ़ पब्लिक डेटा फ़ाइलें डाउनलोड करता है। आपके या आपके फ़ोन के बारे में कुछ नहीं भेजा जाता।",
    "Your watchlist, planner inputs and My IPOs record stay on this phone.": "आपकी वॉचलिस्ट, प्लानर की जानकारी और मेरे IPO का रिकॉर्ड इसी फ़ोन पर रहते हैं।",
    "Notifications are created on the phone itself.": "नोटिफ़िकेशन फ़ोन पर ही बनते हैं।",
    "Sharing only happens when you tap Share, through your phone’s own share menu.": "शेयरिंग तभी होती है जब आप शेयर करें दबाते हैं, आपके फ़ोन के अपने शेयर मेनू से।",
    "Full privacy policy": "पूरी प्राइवेसी पॉलिसी",
    "Language": "भाषा",
    "Text size": "टेक्स्ट साइज़",
    "Appearance": "दिखावट",
    "Auto": "ऑटो",
    "Light": "लाइट",
    "Dark": "डार्क",
    "Display": "डिस्प्ले",
    "Reminder time": "रिमाइंडर का समय",
    "Tell me when new data arrives": "नया डेटा आने पर बताएं",
    "Alerts": "अलर्ट",
    "Alerts and background refresh work in the Android app.": "अलर्ट और बैकग्राउंड रिफ़्रेश Android ऐप में काम करते हैं।",
    "Share today’s shortlist as a picture": "आज की शॉर्टलिस्ट तस्वीर के रूप में शेयर करें",
    "For WhatsApp, Instagram and more": "WhatsApp, Instagram वगैरह के लिए",
    "Share the shortlist as text": "शॉर्टलिस्ट टेक्स्ट के रूप में शेयर करें",
    "Export all IPOs (spreadsheet)": "सभी IPO एक्सपोर्ट करें (स्प्रेडशीट)",
    "How to read this app": "यह ऐप कैसे पढ़ें",
    "1 minute": "1 मिनट",
    "Plain-language glossary": "आसान शब्दकोश",
    "The method, the rules and the limits": "तरीका, नियम और सीमाएं",
    "Some checks need attention": "कुछ जांचों पर ध्यान देना है",
    "All checks passed": "सभी जांच पास",
    "No report in this snapshot": "इस स्नैपशॉट में रिपोर्ट नहीं",
    "Learn": "सीखें",
    "Email or WhatsApp": "ईमेल या WhatsApp",
    "Buy us a coffee": "हमें एक कॉफ़ी पिलाएं",
    "Keeps the data and the model running": "डेटा और मॉडल को चालू रखता है",
    "No account, no ads, no tracking": "न अकाउंट, न विज्ञापन, न ट्रैकिंग",
    "Support": "सपोर्ट",
    "Copied": "कॉपी हो गया",
    "Could not copy": "कॉपी नहीं हो सका",
    "Data as of": "डेटा इस समय तक:",
    "Not investment advice. Chances come from a model on past listings; the grey-market premium is unofficial.": "यह निवेश सलाह नहीं है। मौके पुरानी लिस्टिंग पर बने मॉडल से आते हैं; ग्रे-मार्केट प्रीमियम अनौपचारिक है।",
    "Indian IPOs, in plain words": "भारतीय IPO, आसान शब्दों में",
    "Chance of a listing gain": "लिस्टिंग गेन का मौका",
    "not enough data yet": "अभी काफ़ी डेटा नहीं",
    "range {a} to {b}": "रेंज {a} से {b}",
    "minimum application": "न्यूनतम आवेदन",
    "share lottery": "शेयर लॉटरी",
    "on listing day": "लिस्टिंग के दिन",
    "Today’s shortlist": "आज की शॉर्टलिस्ट",
    "Open and upcoming IPOs, best first": "खुले और आने वाले IPO, सबसे अच्छे पहले",
    "Nothing open or upcoming has a read right now.": "खुले या आने वाले किसी IPO पर अभी कोई राय नहीं है।",
    "chance": "मौका",
    "Share as text": "टेक्स्ट के रूप में शेयर करें",
    "Sends as a picture with a short summary as the caption.": "तस्वीर के साथ छोटा सार कैप्शन में भेजता है।",
    "Could not draw the picture on this phone. Share as text instead.": "इस फ़ोन पर तस्वीर नहीं बन सकी। इसकी जगह टेक्स्ट के रूप में शेयर करें।",
    "Updated with the latest data": "ताज़ा डेटा से अपडेट",
    "50-50 gamble": "50-50 जुआ",
    "Avoid": "बचें",
    "Too early": "अभी जल्दी",
    "Not enough info": "जानकारी कम",
    "Today": "आज",
    "The odds are clearly on your side and nothing is flashing red.": "मौके साफ़ तौर पर आपके पक्ष में हैं और कोई खतरे का निशान नहीं है।",
    "Good odds, with one thing to keep in mind.": "अच्छे मौके, बस एक बात ध्यान में रखें।",
    "Could go either way. Apply only if a small loss is fine with you.": "कुछ भी हो सकता है। आवेदन तभी करें जब छोटा नुकसान आपको मंज़ूर हो।",
    "The odds are against a listing-day gain.": "लिस्टिंग के दिन फ़ायदे के मौके कम हैं।",
    "Wait for the demand figures on the last bidding day.": "बोली के आखिरी दिन डिमांड के आंकड़ों का इंतज़ार करें।",
    "There is not enough information to judge this one yet.": "इसे परखने के लिए अभी काफ़ी जानकारी नहीं है।",
    "Active": "चालू",
    "Upcoming": "आने वाले",
    "Awaiting listing": "लिस्टिंग बाकी",
    "Watchlist": "वॉचलिस्ट",
    "All": "सभी",
    "Best first": "सबसे अच्छे पहले",
    "Highest chance of gain": "फ़ायदे का सबसे ज़्यादा मौका",
    "Most worth per application": "प्रति आवेदन सबसे ज़्यादा फ़ायदा",
    "By date": "तारीख के हिसाब से",
    "1 day": "1 दिन",
    "1 week": "1 हफ़्ता",
    "1 month": "1 महीना",
    "3 months": "3 महीने",
    "6 months": "6 महीने",
    "Brokerage %": "ब्रोकरेज %",
    "Brokerage min ₹": "न्यूनतम ब्रोकरेज ₹",
    "Brokerage cap ₹": "अधिकतम ब्रोकरेज ₹",
    "DP charge ₹": "DP चार्ज ₹",
    "STT %": "STT %",
    "Short-term gains tax %": "शॉर्ट-टर्म गेन टैक्स %",
    "Cess on tax %": "टैक्स पर सेस %",
    "Saved live": "लाइव सेव",
    "Include reconstructed": "बाद में बनाई राय भी शामिल करें",
    "Off": "बंद",
    "9:00 am": "सुबह 9:00",
    "10:00 am": "सुबह 10:00",
    "12 noon": "दोपहर 12 बजे",
    "2:00 pm": "दोपहर 2:00",
    "4:00 pm": "शाम 4:00",
    "Every 3 hours": "हर 3 घंटे",
    "Every 6 hours": "हर 6 घंटे",
    "Every 12 hours": "हर 12 घंटे",
    "Once a day": "दिन में एक बार",
    "How to read this app in 1 minute": "1 मिनट में यह ऐप कैसे पढ़ें",
    "Every IPO gets one coloured label: Apply, Leaning yes, 50-50 gamble, Avoid or Too early. Start there; it already weighs everything else.": "हर IPO को एक रंगीन लेबल मिलता है: आवेदन करें, शायद हाँ, 50-50 जुआ, बचें या अभी जल्दी। वहीं से शुरू करें; इसमें बाकी सब पहले से तौला गया है।",
    "The ring shows the chance of a listing gain. 70% means that out of ten IPOs that looked like this one, about seven ended their first day above the issue price, and three did not.": "गोला लिस्टिंग गेन का मौका दिखाता है। 70% का मतलब है इसके जैसे दस IPO में से लगभग सात पहले दिन इश्यू प्राइस से ऊपर बंद हुए, और तीन नहीं।",
    "“Get shares” is your chance in the share lottery. In a popular IPO most people get nothing and their money is simply unblocked a few days later. “1 in 7” means one applicant in seven gets shares.": "“शेयर मिलना” शेयर लॉटरी में आपका मौका है। लोकप्रिय IPO में ज़्यादातर लोगों को कुछ नहीं मिलता और उनका पैसा कुछ दिन बाद अनब्लॉक हो जाता है। “7 में से 1” का मतलब है सात आवेदकों में से एक को शेयर मिलते हैं।",
    "“Worth per application” puts it all together: the average profit one application brings after broker charges and tax, counting the times you get nothing.": "“प्रति आवेदन फ़ायदा” सब कुछ जोड़ता है: ब्रोकर चार्ज और टैक्स के बाद एक आवेदन से औसत मुनाफ़ा, उन बारों को गिनकर जब कुछ नहीं मिलता।",
    "Tap any IPO for its dates, the money, the demand and the reasons. Tap any underlined word or ? for its meaning.": "तारीखें, पैसा, डिमांड और कारण देखने के लिए किसी भी IPO पर टैप करें। मतलब जानने के लिए किसी भी अंडरलाइन शब्द या ? पर टैप करें।",
    "Apply: the odds are clearly on your side and nothing is flashing red.": "आवेदन करें: मौके साफ़ तौर पर आपके पक्ष में हैं और कोई खतरे का निशान नहीं है।",
    "Leaning yes: good odds with one caveat, or a strong early read before demand figures exist.": "शायद हाँ: अच्छे मौके पर एक सावधानी के साथ, या डिमांड आंकड़ों से पहले मज़बूत शुरुआती संकेत।",
    "50-50 gamble: about as likely to list down as up.": "50-50 जुआ: नीचे और ऊपर लिस्ट होने का लगभग बराबर मौका।",
    "Avoid: the odds are against you before you start.": "बचें: शुरुआत से ही मौके आपके खिलाफ़ हैं।",
    "Too early: wait for the demand figures on the last bidding day.": "अभी जल्दी: बोली के आखिरी दिन डिमांड के आंकड़ों का इंतज़ार करें।",
    "Not enough info: no premium quote and no demand figures yet.": "जानकारी कम: अभी न प्रीमियम भाव है, न डिमांड के आंकड़े।",
    "How likely the IPO is to close its first trading day above the issue price. It comes from a model that learned from past Indian listings.": "IPO के पहले ट्रेडिंग दिन इश्यू प्राइस से ऊपर बंद होने की कितनी संभावना है। यह पुरानी भारतीय लिस्टिंग से सीखे मॉडल से आता है।",
    "70% does not mean you will make 70%. It means about 7 in 10 IPOs that looked like this one listed up.": "70% का मतलब यह नहीं कि आप 70% कमाएंगे। इसका मतलब है इसके जैसे 10 में से लगभग 7 IPO ऊपर लिस्ट हुए।",
    "Listing gain": "लिस्टिंग गेन",
    "The difference between the IPO price you paid and the price at the end of the first trading day. A 10% gain on ₹15,000 of shares is ₹1,500 before charges and tax.": "आपके दिए IPO प्राइस और पहले ट्रेडिंग दिन के आखिर के प्राइस का फ़र्क। ₹15,000 के शेयरों पर 10% फ़ायदा यानी चार्ज और टैक्स से पहले ₹1,500।",
    "Grey-market premium (GMP)": "ग्रे-मार्केट प्रीमियम (GMP)",
    "Before an IPO lists, some dealers informally trade its shares among themselves. The extra they pay over the issue price is the grey-market premium.": "IPO लिस्ट होने से पहले कुछ डीलर आपस में अनौपचारिक रूप से उसके शेयरों का सौदा करते हैं। इश्यू प्राइस से ऊपर जो अतिरिक्त वे देते हैं, वही ग्रे-मार्केट प्रीमियम है।",
    "It is a hint of demand, nothing more: unofficial, unregulated, sometimes stale, and for small IPOs easy to push around. We treat it as one input among several, never as the answer.": "यह डिमांड का बस एक इशारा है: अनौपचारिक, बिना नियमन, कभी-कभी पुराना, और छोटे IPO में आसानी से प्रभावित होने वाला। हम इसे कई चीज़ों में से एक मानते हैं, कभी जवाब नहीं।",
    "Demand (subscription)": "डिमांड (सब्सक्रिप्शन)",
    "How many times over the IPO was bid for. “5x” means people asked for five times the shares on offer.": "IPO के लिए कितने गुना बोली लगी। “5x” का मतलब है लोगों ने ऑफ़र किए शेयरों से पांच गुना मांगे।",
    "It is reported for three groups: big institutions (QIB), wealthy investors (NII) and retail (people applying up to ₹2 lakh, which is most of us).": "यह तीन ग्रुप के लिए बताया जाता है: बड़े संस्थान (QIB), अमीर निवेशक (NII) और रिटेल (₹2 लाख तक आवेदन करने वाले, यानी हम में से ज़्यादातर)।",
    "Big institutions (QIB)": "बड़े संस्थान (QIB)",
    "Mutual funds, banks, insurers and foreign funds. They do their own research, so their demand is the strongest signal. They usually bid on the last day.": "म्यूचुअल फ़ंड, बैंक, बीमा कंपनियां और विदेशी फ़ंड। ये अपनी रिसर्च खुद करते हैं, इसलिए इनकी डिमांड सबसे मज़बूत संकेत है। ये आमतौर पर आखिरी दिन बोली लगाते हैं।",
    "Wealthy investors (NII / HNI)": "अमीर निवेशक (NII / HNI)",
    "People and firms bidding more than ₹2 lakh. Often borrowed money, so their demand swings with the premium.": "₹2 लाख से ज़्यादा की बोली लगाने वाले लोग और फ़र्म। अक्सर उधार का पैसा, इसलिए इनकी डिमांड प्रीमियम के साथ ऊपर-नीचे होती है।",
    "Retail": "रिटेल",
    "Individuals applying for up to ₹2 lakh. That is you. When this group is oversubscribed, shares go by lottery, so this number sets your odds.": "₹2 लाख तक आवेदन करने वाले आम लोग। यानी आप। जब यह ग्रुप ओवरसब्सक्राइब होता है, शेयर लॉटरी से मिलते हैं, इसलिए यही नंबर आपका मौका तय करता है।",
    "Chance of getting shares (allotment)": "शेयर मिलने का मौका (अलॉटमेंट)",
    "If retail demand is 7 times the shares on offer, roughly 1 applicant in 7 gets one lot, picked by a computerised lottery set by SEBI. Everyone else gets their money unblocked.": "अगर रिटेल डिमांड ऑफ़र किए शेयरों की 7 गुना है, तो लगभग 7 में से 1 आवेदक को एक लॉट मिलता है, जो SEBI के तय कंप्यूटर लॉटरी से चुना जाता है। बाकी सबका पैसा अनब्लॉक हो जाता है।",
    "Bidding for more lots does not improve your chance in a popular IPO. Applying from more family demat accounts does.": "लोकप्रिय IPO में ज़्यादा लॉट की बोली से आपका मौका नहीं बढ़ता। परिवार के ज़्यादा demat अकाउंट से आवेदन करने से बढ़ता है।",
    "IPO shares are sold in fixed bundles called lots. Price × lot size is the smallest amount you can apply for. SME IPOs need at least two lots.": "IPO शेयर तय बंडल में बिकते हैं जिन्हें लॉट कहते हैं। प्राइस × लॉट साइज़ सबसे कम रकम है जिसके लिए आप आवेदन कर सकते हैं। SME IPO में कम से कम दो लॉट चाहिए।",
    "Likely gain and its range": "संभावित फ़ायदा और उसकी रेंज",
    "The middle number is the most likely listing-day gain. The bad case is a result only 1 in 10 did worse than; the good case one only 1 in 10 did better than.": "बीच का नंबर लिस्टिंग के दिन का सबसे संभावित फ़ायदा है। बुरी स्थिति वह नतीजा है जिससे 10 में से सिर्फ़ 1 का खराब रहा; अच्छी स्थिति वह जिससे 10 में से सिर्फ़ 1 का बेहतर रहा।",
    "A wide range means more uncertainty, usually in small SME IPOs.": "चौड़ी रेंज मतलब ज़्यादा अनिश्चितता, आमतौर पर छोटे SME IPO में।",
    "The average profit one application brings, after broker charges and tax, counting the chance you get no shares at all.": "ब्रोकर चार्ज और टैक्स के बाद एक आवेदन से औसत मुनाफ़ा, इस मौके को गिनकर कि आपको शेयर बिल्कुल न मिलें।",
    "Example: a 1 in 5 chance of a ₹2,000 profit is worth about ₹400 per application. Any single application gives either ₹2,000 or nothing; over many, it averages out.": "उदाहरण: ₹2,000 मुनाफ़े का 5 में से 1 मौका यानी प्रति आवेदन लगभग ₹400। कोई एक आवेदन या तो ₹2,000 देता है या कुछ नहीं; कई आवेदनों में औसत निकल आता है।",
    "Broker and exchange charges": "ब्रोकर और एक्सचेंज चार्ज",
    "Selling on listing day costs: brokerage, securities transaction tax (STT, 0.1%), exchange and SEBI fees, GST on those, and a depository (DP) charge. Pick your broker in the Planner.": "लिस्टिंग के दिन बेचने का खर्च: ब्रोकरेज, सिक्योरिटीज़ ट्रांज़ैक्शन टैक्स (STT, 0.1%), एक्सचेंज और SEBI फ़ीस, उन पर GST, और डिपॉज़िटरी (DP) चार्ज। प्लानर में अपना ब्रोकर चुनें।",
    "Selling within a year counts as a short-term capital gain: 20% tax plus 4% cess on that tax. Every “in your hand” figure has it deducted.": "एक साल के अंदर बेचना शॉर्ट-टर्म कैपिटल गेन माना जाता है: 20% टैक्स और उस टैक्स पर 4% सेस। हर “आपके हाथ में” आंकड़े से यह घटाया गया है।",
    "Mainboard and SME": "मेनबोर्ड और SME",
    "Mainboard IPOs list on the main NSE and BSE exchanges. SME IPOs are small companies on NSE Emerge or BSE SME: bigger minimum amounts (₹2 lakh or more), thin trading and wilder results both ways.": "मेनबोर्ड IPO मुख्य NSE और BSE एक्सचेंज पर लिस्ट होते हैं। SME IPO छोटी कंपनियां हैं जो NSE Emerge या BSE SME पर आती हैं: बड़ी न्यूनतम रकम (₹2 लाख या ज़्यादा), कम ट्रेडिंग और दोनों तरफ़ बड़े उतार-चढ़ाव।",
    "Gamble warnings": "जुए की चेतावनियां",
    "“Possible gamble” marks a toss-up; “Sure gamble” marks an IPO where the odds are against you. They appear before your money is blocked so you can walk away.": "“शायद जुआ” 50-50 वाले IPO पर लगता है; “पक्का जुआ” उस IPO पर जहां मौके आपके खिलाफ़ हैं। ये आपका पैसा ब्लॉक होने से पहले दिखते हैं ताकि आप पीछे हट सकें।",
    "The model": "मॉडल",
    "The chances come from a statistical model fitted on past Indian listings. Until it has enough history it runs on documented starting weights, and the app says so. The Track record tab shows how its calls turned out.": "मौके पुरानी भारतीय लिस्टिंग पर तैयार एक स्टैटिस्टिकल मॉडल से आते हैं। जब तक काफ़ी इतिहास न हो, यह लिखे हुए शुरुआती वेट पर चलता है, और ऐप यह बताता है। रिकॉर्ड टैब दिखाता है कि इसकी राय कैसी रहीं।",
    "Fresh issue": "फ़्रेश इश्यू",
    "New shares created by the company. The money goes into the business, for growth or paying debt.": "कंपनी के बनाए नए शेयर। पैसा कारोबार में जाता है, बढ़ने या कर्ज़ चुकाने के लिए।",
    "Offer for sale (OFS)": "ऑफ़र फ़ॉर सेल (OFS)",
    "Existing owners selling their shares. The money goes to them, not to the company. An IPO that is almost all OFS means insiders are cashing out.": "मौजूदा मालिक अपने शेयर बेच रहे हैं। पैसा उन्हें जाता है, कंपनी को नहीं। लगभग पूरा OFS वाला IPO मतलब अंदर वाले पैसा निकाल रहे हैं।",
    "Anchor investors": "एंकर निवेशक",
    "Big institutions that buy a part of the IPO a day before it opens. Half of their shares are locked for 30 days after allotment and the rest for 90 days; prices often dip when those lock-ins end.": "बड़े संस्थान जो IPO खुलने से एक दिन पहले उसका हिस्सा खरीदते हैं। उनके आधे शेयर अलॉटमेंट के बाद 30 दिन और बाकी 90 दिन लॉक रहते हैं; लॉक-इन खत्म होने पर प्राइस अक्सर गिरता है।",
    "Grey-market premium": "ग्रे-मार्केट प्रीमियम",
    "No premium quote": "कोई प्रीमियम भाव नहीं",
    "Institutional demand": "संस्थानों की डिमांड",
    "Wealthy-investor demand": "अमीर निवेशकों की डिमांड",
    "Retail demand": "रिटेल डिमांड",
    "No demand figures": "डिमांड के आंकड़े नहीं",
    "SME issue": "SME इश्यू",
    "Issue size": "इश्यू साइज़",
    "Nifty, past month": "Nifty, पिछला महीना",
    "Premium trend": "प्रीमियम का रुझान",
    "For IPOs on your watchlist": "आपकी वॉचलिस्ट के IPO के लिए",
    "Morning reminder for your watchlist": "आपकी वॉचलिस्ट के लिए सुबह का रिमाइंडर",
    "Allotment result day": "अलॉटमेंट रिज़ल्ट का दिन",
    "So you can check if you got shares": "ताकि आप देख सकें कि शेयर मिले या नहीं",
    "The day before and on the day": "एक दिन पहले और उसी दिन",
    "Label changes": "लेबल में बदलाव",
    "When a watched IPO moves, say from Leaning yes to Avoid": "जब वॉचलिस्ट वाला IPO बदले, जैसे शायद हाँ से बचें"
    };

  let inline = {};
  try { inline = JSON.parse(document.getElementById('data').textContent || '{}'); } catch (e) { inline = {}; }
  boot(inline);
})();
