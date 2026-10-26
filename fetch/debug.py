"""Print what the Chittorgarh pages actually look like to the runner, so a parser
that finds no rows can be fixed from the Actions log.

  python -m fetch.debug
"""
from __future__ import annotations

import re

from bs4 import BeautifulSoup

from fetch.common import Http, Provenance

URLS = [
    "https://www.chittorgarh.com/report/mainboard-ipo-list-in-india-bse-nse/19/",
    "https://www.chittorgarh.com/report/sme-ipo-list-in-india-bse-sme-nse-emerge/84/",
    "https://www.chittorgarh.com/report/ipo_gmp_grey_market_premium/85/",
    "https://www.chittorgarh.com/report/ipo-performance-tracker-listing-gain-on-ipo/21/?year=2026",
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
        if re.search(r"just a moment|cloudflare|captcha|access denied|enable javascript", html, re.I):
            print("   looks like a bot-check / JS wall")
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
