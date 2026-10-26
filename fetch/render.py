"""Render a page in headless Chromium and return the HTML after its tables appear.

Some sites (Chittorgarh's report pages) ship an empty shell and fill the tables
with JavaScript, so `requests` never sees them. This helper is used only as a
fallback when the static HTML has no <table>; it needs the optional `playwright`
package plus a Chromium build (the refresh workflow installs both). Without them
it returns None and the caller carries on with what it has.
"""
from __future__ import annotations

import os

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
WAIT_FOR = "table"
TIMEOUT_MS = int(os.environ.get("IPO_RENDER_TIMEOUT_MS", "25000"))


def available() -> bool:
    try:
        import playwright.sync_api  # noqa: F401
    except Exception:  # noqa: BLE001
        return False
    return True


def render_html(url: str, wait_for: str = WAIT_FOR, timeout_ms: int = TIMEOUT_MS) -> str | None:
    """HTML of `url` once `wait_for` is present (or after the timeout), else None."""
    if not available():
        return None
    from playwright.sync_api import sync_playwright
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            try:
                ctx = browser.new_context(user_agent=UA, viewport={"width": 1366, "height": 900}, locale="en-IN")
                page = ctx.new_page()
                page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
                try:
                    page.wait_for_selector(wait_for, timeout=timeout_ms)
                except Exception:  # noqa: BLE001 - no table appeared; return what rendered anyway
                    pass
                page.wait_for_timeout(800)
                return page.content()
            finally:
                browser.close()
    except Exception:  # noqa: BLE001
        return None
