"""Data health checks for the scored pipeline.

`check(live, prev, now)` returns the top-level `health` block of scored.json:

  {"ok": bool, "checked_at": ISO, "issues": [{"level": "warn"|"error", "ipo_id": str|null,
   "code": str, "msg": str}], "sources": [{"name", "ok", "last_ok_at", "rows"}]}

and sets `health_flags: [code, ...]` on every IPO. `ok` is false only when an
error-level issue exists. Messages are written for someone who has never heard
of a data pipeline. Nothing here changes a score.
"""
from __future__ import annotations

from datetime import datetime, timezone

STALE_HOURS = 24
SUB_DROP_TOLERANCE = 0.02         # a 2% dip is rounding between sources, not a falling book


def _date(s):
    from datetime import date
    try:
        return date.fromisoformat(str(s)[:10]) if s else None
    except ValueError:
        return None


def _ts(s):
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None


def _num(v):
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def ipo_issues(ipo: dict, prev: dict | None) -> list[dict]:
    out = []
    name = ipo.get("name") or ipo.get("id")
    rid = ipo.get("id")

    def add(level, code, msg):
        out.append({"level": level, "ipo_id": rid, "code": code, "msg": msg})

    price = _num(ipo.get("issue_price"))
    g = ipo.get("gmp") or {}
    rs = _num(g.get("rs"))
    if price and rs is not None and abs(rs) > 3 * price:
        add("error", "gmp_implausible", f"{name}: the grey-market premium (₹{rs:g}) is more than three times the share price (₹{price:g}); it is almost certainly a typo at the source and should be ignored.")
    if g.get("disagree"):
        add("warn", "gmp_sources_disagree", f"{name}: the GMP websites disagree by ₹{_num(g.get('spread_rs')) or 0:g}; the figure shown is the middle of their quotes.")
    od, cd, ld = _date(ipo.get("open_date")), _date(ipo.get("close_date")), _date(ipo.get("listing_date"))
    if od and cd and od > cd:
        add("error", "open_after_close", f"{name}: the opening date ({od}) is after the closing date ({cd}); one of the dates is wrong.")
    if cd and ld and ld < cd:
        add("error", "listing_before_close", f"{name}: the listing date ({ld}) is before bidding closes ({cd}); one of the dates is wrong.")
    lo, hi = _num(ipo.get("price_band_low")), _num(ipo.get("price_band_high"))
    if price and lo and hi and not (lo * 0.995 <= price <= hi * 1.005):
        add("warn", "price_outside_band", f"{name}: the issue price ₹{price:g} is outside the announced band ₹{lo:g}–₹{hi:g}.")
    if ipo.get("board") == "sme" and (_num(ipo.get("min_lots")) or 0) < 2:
        add("error", "sme_min_lots", f"{name}: an SME issue needs at least two lots per application (SEBI rule since 2025), but the data says {ipo.get('min_lots')}.")
    if ipo.get("board_basis") == "inferred":
        add("warn", "board_inferred", f"{name}: no source said whether this is an SME issue; it was classified from its lot size and price.")
    if prev and ipo.get("status") in ("open", "closed"):
        s, ps = ipo.get("subscription") or {}, prev.get("subscription") or {}
        fell = []
        for k in ("qib", "nii", "retail", "total"):
            a, b = _num(s.get(k)), _num(ps.get(k))
            if a is not None and b is not None and b > 0 and a < b * (1 - SUB_DROP_TOLERANCE):
                fell.append(f"{k} {b:g}x → {a:g}x")
        if fell:
            add("warn", "subscription_decreased", f"{name}: subscription figures went down since the last update ({', '.join(fell)}). Bids cannot be un-placed, so one of the two readings is wrong.")
    return out


def source_issues(status: dict, now: datetime) -> tuple[list[dict], list[dict]]:
    issues, rows = [], []
    for name, st in sorted((status or {}).items()):
        last = _ts(st.get("last_ok_at"))
        rows.append({"name": name, "ok": bool(st.get("ok")), "last_ok_at": st.get("last_ok_at"), "rows": int(st.get("rows") or 0)})
        if last is None or (now - last).total_seconds() > STALE_HOURS * 3600:
            when = f"since {st.get('last_ok_at')[:16].replace('T', ' ')} UTC" if last else "ever"
            issues.append({"level": "warn", "ipo_id": None, "code": "source_stale",
                           "msg": f"The {name} source has not answered successfully {when}; its figures may be out of date."})
        elif not st.get("ok") and (st.get("typical_rows") or 0) >= 3 and int(st.get("rows") or 0) == 0:
            issues.append({"level": "warn", "ipo_id": None, "code": "source_empty",
                           "msg": f"The {name} source returned nothing this time although it usually lists about {round(st['typical_rows'])} issues; the site may have changed."})
    return issues, rows


def check(live: dict, prev: dict | None = None, now: datetime | None = None) -> dict:
    now = now or datetime.now(timezone.utc)
    prev_by_id = {}
    for r in (prev or {}).get("ipos", []) or []:
        for k in {r.get("id"), *(r.get("aliases") or [])}:
            if k:
                prev_by_id[k] = r
    issues: list[dict] = []
    for ipo in live.get("ipos", []):
        p = prev_by_id.get(ipo.get("id"))
        if p is None:
            p = next((prev_by_id[a] for a in ipo.get("aliases") or [] if a in prev_by_id), None)
        mine = ipo_issues(ipo, p)
        ipo["health_flags"] = sorted({i["code"] for i in mine})
        issues.extend(mine)
    s_issues, s_rows = source_issues(live.get("source_status") or {}, now)
    issues.extend(s_issues)
    return {"ok": not any(i["level"] == "error" for i in issues),
            "checked_at": now.replace(microsecond=0).isoformat().replace("+00:00", "Z"),
            "issues": issues, "sources": s_rows}
