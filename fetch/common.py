"""Shared HTTP plumbing for the fetchers: a browser-like session, retries,
a per-run cache (so a crash halfway through does not re-hit every site), and a
provenance log that ends up in data/ipos.json so every number is traceable.

Design rules:
  * never raise out of a source; return None/[] and log the failure so one
    broken site does not stop the whole refresh
  * be polite: one request at a time per host, a short pause between requests,
    an honest User-Agent, and an on-disk cache
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import time
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Any

import requests

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE_DIR = os.path.join(ROOT, ".cache")
POLITE_DELAY_S = float(os.environ.get("IPO_FETCH_DELAY", "1.5"))


@dataclass
class SourceLog:
    url: str
    fetched_at: str = ""
    ok: bool = False
    status: int | None = None
    rows: int = 0
    note: str = ""


@dataclass
class Provenance:
    entries: list[SourceLog] = field(default_factory=list)

    def add(self, url: str, ok: bool, status: int | None = None, rows: int = 0, note: str = ""):
        self.entries.append(SourceLog(url=url, fetched_at=now_iso(), ok=ok, status=status, rows=rows, note=note))

    def to_json(self) -> list[dict[str, Any]]:
        return [asdict(e) for e in self.entries]


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def today() -> str:
    return datetime.now(timezone.utc).date().isoformat()


class Http:
    """A requests session with retries, cache and provenance."""

    def __init__(self, prov: Provenance, cache: bool = True, delay: float = POLITE_DELAY_S):
        self.s = requests.Session()
        self.s.headers.update({
            "User-Agent": UA,
            "Accept-Language": "en-US,en;q=0.9",
            "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        })
        self.prov = prov
        self.cache = cache
        self.delay = delay
        self._last: dict[str, float] = {}
        if cache:
            os.makedirs(CACHE_DIR, exist_ok=True)

    def _cache_path(self, url: str) -> str:
        return os.path.join(CACHE_DIR, hashlib.sha1(url.encode()).hexdigest()[:20] + ".bin")

    def get(self, url: str, headers: dict | None = None, retries: int = 3, timeout: int = 25,
            allow_cache: bool = True) -> requests.Response | None:
        path = self._cache_path(url)
        if self.cache and allow_cache and os.path.exists(path) and time.time() - os.path.getmtime(path) < 6 * 3600:
            with open(path, "rb") as f:
                body = f.read()
            r = requests.Response()
            r.status_code = 200
            r._content = body
            r.url = url
            r.encoding = "utf-8"
            self.prov.add(url, True, 200, note="cache")
            return r
        host = url.split("/")[2]
        wait = self.delay - (time.time() - self._last.get(host, 0))
        if wait > 0:
            time.sleep(wait)
        last_err = ""
        for attempt in range(retries):
            try:
                r = self.s.get(url, headers=headers or {}, timeout=timeout)
                self._last[host] = time.time()
                if r.status_code == 200 and r.content:
                    if self.cache and allow_cache:
                        with open(path, "wb") as f:
                            f.write(r.content)
                    self.prov.add(url, True, r.status_code)
                    return r
                last_err = f"http {r.status_code}"
                if r.status_code in (401, 403, 404):
                    break
            except requests.RequestException as e:  # noqa: PERF203
                last_err = type(e).__name__
            time.sleep(2 ** attempt)
        self.prov.add(url, False, None, note=last_err)
        return None

    def get_json(self, url: str, **kw) -> Any | None:
        r = self.get(url, **kw)
        if r is None:
            return None
        try:
            return r.json()
        except ValueError:
            self.prov.add(url, False, r.status_code, note="not json")
            return None

    def get_html(self, url: str, **kw) -> str | None:
        r = self.get(url, **kw)
        return r.text if r is not None else None


# ------------------------------------------------------------- small utils ---

def num(s: Any) -> float | None:
    """Parse '₹1,234.50', '12.3x', '45.2%', '-', 'NA' → float or None."""
    if s is None:
        return None
    if isinstance(s, (int, float)):
        return float(s)
    t = str(s).strip().replace(",", "").replace("₹", "").replace("Rs.", "").replace("Rs", "")
    t = t.replace("x", "").replace("X", "").replace("%", "").replace("times", "").strip()
    if t in ("", "-", "--", "NA", "N/A", "na", "n/a", "—", "nil", "Nil"):
        return None
    try:
        return float(t)
    except ValueError:
        # "1.2 Cr" / "350 L" style
        parts = t.split()
        if len(parts) == 2:
            try:
                v = float(parts[0])
            except ValueError:
                return None
            unit = parts[1].lower()
            if unit.startswith("cr"):
                return v
            if unit.startswith("l"):
                return v / 100.0
        return None


_PAREN_RE = re.compile(r"\(([^)]*)\)")
_PAREN_DROP_RE = re.compile(r"\b(ipo|fpo|sme|parent|mainboard)\b", re.IGNORECASE)
_ID_SUFFIXES = ("-limited", "-ltd", "-ipo", "-fpo", "-pvt", "-private", "-sme", "-and")


def slugify(name: str, year: str | int | None = None) -> str:
    """'Bombay Coated & Special Steels', 'Bombay Coated and Special Steels Limited' and
    'Bombay Coated and Special Steels Ltd. (Bombay Coated and Special Steels IPO)' all key
    to 'bombay-coated-and-special-steels'. A parenthetical that names the issue again
    ('(Foo IPO)', '(Snapdeal parent)') is dropped; one that is part of the name ('(India)') stays."""
    t = str(name or "")
    t = _PAREN_RE.sub(lambda m: "" if _PAREN_DROP_RE.search(m.group(1)) else " " + m.group(1) + " ", t)
    t = t.replace("&", " and ")
    base = "".join(c.lower() if c.isalnum() else "-" for c in t).strip("-")
    while "--" in base:
        base = base.replace("--", "-")
    changed = True
    while changed:
        changed = False
        for suffix in _ID_SUFFIXES:
            if base.endswith(suffix) and len(base) > len(suffix):
                base = base[: -len(suffix)]
                changed = True
    return f"{base}-{year}" if year else base


def dump_json(path: str, obj: Any) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
        f.write("\n")


def load_json(path: str, default: Any = None) -> Any:
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8") as f:
        return json.load(f)
