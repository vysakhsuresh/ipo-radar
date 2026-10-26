"""Unit tests never touch the network: the headless-render fallback is stubbed
out here, otherwise a runner with Chromium installed would fetch live pages
whenever a fixture lacks a table."""
import pytest

from fetch import render


@pytest.fixture(autouse=True)
def no_headless_render(monkeypatch):
    monkeypatch.setattr(render, "render_html", lambda *a, **k: None)
    monkeypatch.setattr(render, "available", lambda: False)
