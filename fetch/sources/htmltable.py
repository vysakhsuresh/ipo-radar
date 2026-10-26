"""Header-driven HTML table extraction for the scraped report pages.

The sites reorder and rename columns now and then, so nothing here uses a
column index: a caller asks for the column whose *normalised header text*
contains a substring ("issue price", "listing close", "gmp"...) and gets the
cell of that column for each row, or None when the page has no such column.

Assumptions: tables are plain <table> elements (BeautifulSoup + lxml); the
header is the <thead> row, else the first <tr> that has <th> cells, else the
first row; data rows are every later <tr> with at least two cells. A cell
keeps its text (whitespace collapsed), the href of its first link and the
title/alt attributes of its descendants (rating icons carry their value there).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from bs4 import BeautifulSoup, Tag

_WS = re.compile(r"\s+")


@dataclass
class Cell:
    text: str
    href: str | None = None
    link_text: str | None = None
    titles: list[str] = field(default_factory=list)


@dataclass
class Table:
    headers: list[str]            # normalised: lowercase, single spaces, no punctuation noise
    raw_headers: list[str]
    rows: list[list[Cell]]

    def col(self, *patterns: str, exclude: tuple[str, ...] = ()) -> int | None:
        """Index of the first header that contains any of `patterns` (checked in
        order, so put the most specific first) and none of `exclude`."""
        for p in patterns:
            for i, h in enumerate(self.headers):
                if p in h and not any(x in h for x in exclude):
                    return i
        return None

    def has(self, *patterns: str) -> bool:
        return all(any(p in h for h in self.headers) for p in patterns)

    def cell(self, row: list[Cell], idx: int | None) -> Cell | None:
        if idx is None or idx >= len(row):
            return None
        return row[idx]

    def text(self, row: list[Cell], idx: int | None) -> str | None:
        c = self.cell(row, idx)
        return c.text if c is not None and c.text != "" else None


def norm_header(s: str) -> str:
    t = _WS.sub(" ", (s or "").replace("\xa0", " ")).strip().lower()
    t = t.replace("(rs)", "").replace("(rs.)", "").replace("(₹)", "").replace("₹", "").replace("rs.", "")
    t = re.sub(r"[^\w%()./ -]+", " ", t)
    return _WS.sub(" ", t).strip()


def _cell_of(td: Tag) -> Cell:
    text = _WS.sub(" ", td.get_text(" ", strip=True).replace("\xa0", " ")).strip()
    a = td.find("a", href=True)
    titles = [str(t.get("title") or t.get("alt")) for t in td.find_all(True) if t.get("title") or t.get("alt")]
    return Cell(text=text, href=(a["href"] if a else None),
                link_text=(_WS.sub(" ", a.get_text(" ", strip=True)).strip() if a else None), titles=titles)


def parse_tables(html: str) -> list[Table]:
    soup = BeautifulSoup(html or "", "lxml")
    out: list[Table] = []
    for table in soup.find_all("table"):
        trs = [tr for tr in table.find_all("tr") if tr.find_parent("table") is table]
        if not trs:
            continue
        header_tr = None
        thead = table.find("thead")
        if thead is not None:
            header_tr = next((tr for tr in thead.find_all("tr") if tr.find(["th", "td"])), None)
        if header_tr is None:
            header_tr = next((tr for tr in trs if tr.find("th")), trs[0])
        raw = [_WS.sub(" ", c.get_text(" ", strip=True)).strip() for c in header_tr.find_all(["th", "td"], recursive=False)]
        rows: list[list[Cell]] = []
        for tr in trs:
            if tr is header_tr:
                continue
            cells = tr.find_all(["td", "th"], recursive=False)
            if len(cells) < 2:
                continue
            rows.append([_cell_of(c) for c in cells])
        out.append(Table(headers=[norm_header(h) for h in raw], raw_headers=raw, rows=rows))
    return out


def find_table(tables: list[Table], *required: str) -> Table | None:
    """The first table whose headers contain every required substring."""
    for t in tables:
        if t.has(*required) and t.rows:
            return t
    return None


def find_text(html: str, pattern: str) -> str | None:
    """First regex group match in the page's visible text (e.g. 'as on <date>')."""
    soup = BeautifulSoup(html or "", "lxml")
    text = _WS.sub(" ", soup.get_text(" ", strip=True))
    m = re.search(pattern, text, re.IGNORECASE)
    return m.group(1) if m else None
