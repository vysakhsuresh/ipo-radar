#!/usr/bin/env python3
"""Build the single-file page.

  python tools/build_site.py --out dist

Writes:
  dist/index.html     full HTML document for GitHub Pages
  dist/artifact.html  the same page as a fragment (no doctype/html/head/body),
                      which is what the claude.ai Artifact publisher expects
  dist/data/*.json    copies of the data for anyone who wants the raw numbers

The page carries its data inline so it works from a file:// URL, from Pages
and as an artifact with no network access.
"""
import argparse
import json
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read(p):
    with open(p, encoding="utf-8") as f:
        return f.read()


def load(p, default):
    if not os.path.exists(p):
        return default
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(ROOT, "dist"))
    ap.add_argument("--scored", default=os.path.join(ROOT, "data", "scored.json"))
    ap.add_argument("--params", default=os.path.join(ROOT, "model", "params.json"))
    ap.add_argument("--history", default=os.path.join(ROOT, "data", "history.json"))
    a = ap.parse_args(argv)

    live = load(a.scored, None) or load(os.path.join(ROOT, "data", "ipos.json"), {"ipos": [], "market": {}, "sources": []})
    params = load(a.params, None)
    hist = load(a.history, {"rows": []})
    hist_rows = hist["rows"] if isinstance(hist, dict) else hist
    # the chart needs only a few fields per past listing
    sys.path.insert(0, ROOT)
    from model.features import gmp_pct_of
    slim = []
    for r in hist_rows:
        lst = r.get("listing") or {}
        if lst.get("gain_pct") is None:
            continue
        slim.append({"name": r.get("name"), "board": r.get("board"), "listing_date": r.get("listing_date"),
                     "gmp_pct": (round(gmp_pct_of(r), 2) if gmp_pct_of(r) is not None else None),
                     "gain_pct": round(float(lst["gain_pct"]), 2)})
    payload = json.dumps({"live": live, "params": params, "history": slim}, ensure_ascii=False, separators=(",", ":"))
    payload = payload.replace("</", "<\\/")

    page = read(os.path.join(ROOT, "site", "index.html"))
    page = page.replace('<script id="data" type="application/json">{}</script>',
                        '<script id="data" type="application/json">' + payload + '</script>')
    page = page.replace('<script src="score.js"></script>', '<script>\n' + read(os.path.join(ROOT, "site", "score.js")) + '\n</script>')
    page = page.replace('<script src="app.js"></script>', '<script>\n' + read(os.path.join(ROOT, "site", "app.js")) + '\n</script>')

    os.makedirs(os.path.join(a.out, "data"), exist_ok=True)
    with open(os.path.join(a.out, "artifact.html"), "w", encoding="utf-8") as f:
        f.write(page)
    full = ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
            '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
            '<meta name="description" content="Indian IPOs with the chance of a listing-day gain, allotment odds and what one application is worth after costs.">\n'
            '</head>\n<body>\n' + page + '\n</body>\n</html>\n')
    with open(os.path.join(a.out, "index.html"), "w", encoding="utf-8") as f:
        f.write(full)
    for src in (a.scored, a.params, a.history, os.path.join(ROOT, "data", "ipos.json")):
        if os.path.exists(src):
            shutil.copy(src, os.path.join(a.out, "data", os.path.basename(src)))
    print(f"built {a.out}/index.html ({len(full)//1024} KB), {len(live.get('ipos', []))} IPOs, {len(slim)} history rows")


if __name__ == "__main__":
    main()
