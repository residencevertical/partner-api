#!/usr/bin/env python3
"""Render GUIDE.md to docs/ResidenceVertical-Partner-Integration-Guide.pdf.

    python3 docs/build-pdf.py

Needs `python3 -m pip install markdown` (the only dependency) and a local Google Chrome — the PDF
is printed by headless Chrome from a styled HTML rendering of the guide, with a cover page. Run it
after every change to GUIDE.md so the PDF and the Markdown never drift.
"""
import html
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import date
from pathlib import Path

import markdown

ROOT = Path(__file__).resolve().parent.parent
GUIDE = ROOT / "GUIDE.md"
OUTPUT = ROOT / "docs" / "ResidenceVertical-Partner-Integration-Guide.pdf"
TITLE = "ResidenceVertical — Partner Integration Guide"

CHROME_CANDIDATES = [
    os.environ.get("CHROME"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    shutil.which("google-chrome"),
    shutil.which("chromium"),
    shutil.which("chrome"),
]

CSS = """
@page { size: A4; margin: 18mm 16mm 20mm 16mm; }
body { font: 10.5pt/1.5 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #16202b; }
.cover { height: 250mm; display: flex; flex-direction: column; justify-content: center; page-break-after: always; }
.cover .kicker { color: #1f5fbf; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; font-size: 10pt; }
.cover h1 { font-size: 30pt; margin: 8px 0 4px; }
.cover .sub { font-size: 15pt; color: #5f7183; margin: 0 0 24px; }
.cover .line { font-size: 12pt; margin: 2px 0; }
.cover .version { margin-top: 36px; color: #5f7183; }
h1 { font-size: 20pt; margin: 0 0 12px; page-break-before: always; }
h1:first-of-type { page-break-before: auto; }
h2 { font-size: 15pt; margin: 22px 0 8px; border-bottom: 1px solid #dde4ec; padding-bottom: 3px; page-break-after: avoid; }
h3 { font-size: 12pt; margin: 16px 0 6px; page-break-after: avoid; }
h4 { font-size: 10.5pt; margin: 12px 0 4px; page-break-after: avoid; }
p, li { orphans: 3; widows: 3; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 9pt; background: #f1f4f8; padding: 0 3px; border-radius: 3px; }
pre { background: #f6f8fb; border: 1px solid #dde4ec; border-radius: 6px; padding: 8px 10px; white-space: pre-wrap; overflow-wrap: anywhere; page-break-inside: avoid; }
pre code { background: none; padding: 0; font-size: 8.6pt; }
table { border-collapse: collapse; width: 100%; margin: 8px 0 12px; font-size: 9.2pt; page-break-inside: auto; }
th, td { border: 1px solid #dde4ec; padding: 4px 6px; vertical-align: top; text-align: left; }
th { background: #f1f4f8; }
tr { page-break-inside: avoid; }
blockquote { margin: 10px 0; padding: 6px 12px; border-left: 3px solid #1f5fbf; background: #f6f8fb; color: #2b3a4b; }
a { color: #1f5fbf; text-decoration: none; }
hr { border: 0; border-top: 1px solid #dde4ec; margin: 18px 0; }
"""


def fenced_in_blockquotes(text: str) -> str:
    """Turn ``` fences inside `> ` blockquotes into indented code, which python-markdown renders."""
    out, in_fence = [], False
    for line in text.splitlines():
        if line.startswith(">"):
            body = line[1:].lstrip(" ") if line[1:].startswith(" ") else line[1:]
            if body.startswith("```"):
                in_fence = not in_fence
                out.append(">")
                continue
            if in_fence:
                out.append("> " + "    " + body)
                continue
        out.append(line)
    return "\n".join(out) + "\n"


def cover(version: str, when: str) -> str:
    return f"""<section class="cover">
  <div class="kicker">ResidenceVertical</div>
  <h1>Partner Integration Guide</h1>
  <p class="sub">ResidenceVertical — Property Report API</p>
  <p class="line">One program: referral — link-only, or API-backed checkout links</p>
  <p class="line">Commission on every generated report, paid weekly by SEPA</p>
  <p class="version">Version {html.escape(version.lstrip("v"))} &nbsp;·&nbsp; {html.escape(when)}</p>
</section>
"""


def main() -> int:
    chrome = next((c for c in CHROME_CANDIDATES if c and Path(c).exists()), None)
    if not chrome:
        print("Google Chrome not found — set CHROME=/path/to/chrome", file=sys.stderr)
        return 1

    source = GUIDE.read_text(encoding="utf-8")
    version_match = re.search(r"^\| (v\d+\.\d+) \| (\d{4})-(\d{2})-\d{2} \|", source, re.M)
    version = version_match.group(1) if version_match else "v?"
    when = date(int(version_match.group(2)), int(version_match.group(3)), 1).strftime("%B %Y") if version_match else ""

    body = markdown.markdown(fenced_in_blockquotes(source), extensions=["tables", "fenced_code"])
    page = (f"<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>{html.escape(TITLE)}</title>"
            f"<style>{CSS}</style></head><body>{cover(version, when)}{body}</body></html>")

    with tempfile.TemporaryDirectory() as tmp:
        html_path = Path(tmp) / "guide.html"
        html_path.write_text(page, encoding="utf-8")
        subprocess.run([
            chrome, "--headless=new", "--disable-gpu", "--no-pdf-header-footer",
            f"--print-to-pdf={OUTPUT}", html_path.as_uri(),
        ], check=True, capture_output=True)
    print(f"wrote {OUTPUT.relative_to(ROOT)} ({OUTPUT.stat().st_size // 1024} KB, {version}, {when})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
