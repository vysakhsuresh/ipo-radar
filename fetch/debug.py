"""Print what the Chittorgarh pages actually look like to the runner, so a parser
that finds no rows can be fixed from the Actions log.

  python -m fetch.debug
"""
from __future__ import annotations

import re

from bs4 import BeautifulSoup

from fetch.common import Http, Provenance
from fetch import render

URLS = [
    "https://www.chittorgarh.com/report/ipo-in-india-list-main-board-sme/82/mainboard/",
    "https://www.chittorgarh.com/report/ipo-in-india-list-main-board-sme/82/sme/",
    "https://www.chittorgarh.com/report/ipo-subscription-status-live-bidding-data-bse-nse/21/",
    "https://www.chittorgarh.com/report/ipo-perf-tracker/236/mainboard/",
    "https://www.chittorgarh.com/report/ipo-perf-tracker/236/mainboard/2025/",
    "https://www.chittorgarh.com/report/ipo-perf-tracker/236/mainboard/?year=2025",
    "https://www.chittorgarh.com/report/ipo-gmp-grey-market-premium/97/",
]


def main() -> int:
    http = Http(Provenance(), cache=False)
    for url in URLS:
        r = http.get(url)
        if r is None:
            print(f"== {url}\n   no response")
            continue
        html = r.text
        soup = BeautifulSoup(html, "lxml")
        title = (soup.title.get_text(strip=True) if soup.title else "")[:100]
        tables = soup.find_all("table")
        print(f"== {url}\n   status {r.status_code}, {len(html)} chars, title: {title!r}, tables: {len(tables)}")
        if re.search(r"just a moment|attention required|access denied", title, re.I):
            print("   looks like a bot-check / JS wall")
        hints = [m.group(0)[:160] for m in re.finditer(r"[^\n;{}]{0,60}(?:XMLHttpRequest|fetch\(|\$\.ajax|\$\.get|\.load\(|/api/|\.json|DataTable|report_data|ajax)[^\n;{}]{0,80}", html)][:8]
        print(f"   script hints: {hints}")
        if render.available():
            rendered = render.render_html(url)
            rt = len(BeautifulSoup(rendered, "lxml").find_all("table")) if rendered else None
            print(f"   rendered in headless browser: tables={rt}")
        links = [(a.get_text(" ", strip=True)[:40], a["href"]) for a in soup.find_all("a", href=True)
                 if re.search(r"grey|gmp|perf|tracker|subscription|year", (a.get_text(" ", strip=True) or "") + a["href"], re.I)]
        seen = set(); uniq = [l for l in links if not (l[1] in seen or seen.add(l[1]))]
        print(f"   related links ({len(uniq)}): {uniq[:14]}")
        for t in tables[:4]:
            heads = [th.get_text(" ", strip=True)[:28] for th in t.find_all("th")][:14]
            first = t.find("tr")
            cells = [td.get_text(" ", strip=True)[:20] for td in (first.find_all("td") if first else [])][:10]
            print(f"   table id={t.get('id')} class={t.get('class')} rows={len(t.find_all('tr'))} th={heads} first-row={cells}")
        scripts = [sc.get("src") for sc in soup.find_all("script", src=True)]
        xhr = [m for m in re.findall(r"[\"'](/[^\"']*(?:report|api|ajax|json)[^\"']*)[\"']", html)][:8]
        print(f"   scripts: {len(scripts)}; candidate data urls: {xhr}")
        print("   body snippet:", re.sub(r"\s+", " ", soup.get_text(" ", strip=True))[:300])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
