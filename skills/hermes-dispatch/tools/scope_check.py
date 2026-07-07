#!/usr/bin/env python3
"""Zero-token scope check before hermes_submit."""
import os
import sqlite3
import sys
from urllib.parse import quote

def read_prompt(argv):
    if len(argv) > 1:
        with open(argv[1], encoding="utf-8") as f:
            return f.read()
    if sys.stdin.isatty():
        print("usage: scope_check.py [prompt-file] < prompt", file=sys.stderr)
        sys.exit(2)
    return sys.stdin.read()


def analyze(prompt):
    lines = prompt.splitlines()
    length = len(prompt)
    bullets = sum(1 for line in lines if line.startswith("- "))
    headings = sum(1 for line in lines if line.startswith("## "))
    delegation = any(line.strip().lower() == "## delegation plan" for line in lines)
    score, flags = 0, []

    if length >= 4000:
        score += 2
        flags.append(f"+2 length: {length} chars (>=4000 chars had 25% timeout rate; avg runtime 431s of the 600s cap)")
    elif length >= 2000:
        score += 1
        flags.append(f"+1 length: {length} chars (2000-4000 chars had 28% timeout rate; avg runtime 394s of the 600s cap)")
    if bullets >= 6:
        score += 1
        flags.append(f"+1 bullets: {bullets} '- ' lines (failed prompts averaged 8; completed averaged 3)")
    if headings >= 3:
        score += 1
        flags.append(f"+1 headings: {headings} '## ' lines (failed averaged 3; completed averaged 1)")
    if delegation:
        score -= 1
        flags.append("-1 delegation: ## Delegation plan present (parallel children are how large scope fits under the cap)")
    return {"length": length, "score": score, "flags": flags}


def verdict(score):
    if score <= 0:
        return "OK", 0
    if score == 1:
        return "CAUTION, tighten scope", 0
    return "SPLIT, restructure as a Delegation plan or smaller tasks", 1


def bridge_context(length):
    try:
        path = os.environ.get("HERMES_ASYNC_BRIDGE_DB") or os.path.expanduser("~/.hermes/async_bridge.db")
        if not os.path.exists(path) or not os.access(path, os.R_OK):
            return None
        uri = "file:" + quote(os.path.abspath(path)) + "?mode=ro"
        con = sqlite3.connect(uri, uri=True, timeout=0.2)
        con.row_factory = sqlite3.Row
        low, high = int(length * 0.75), int(length * 1.25)
        result = con.execute(
            """
            SELECT COUNT(*) n,
                   SUM(CASE WHEN status='failed' AND COALESCE(error,'') LIKE '%timed out%' THEN 1 ELSE 0 END) t
            FROM tasks
            WHERE LENGTH(COALESCE(prompt,'')) BETWEEN ? AND ?
            """,
            (low, high),
        ).fetchone()
        n = int(result["n"] or 0)
        if n:
            rate = (float(result["t"] or 0) * 100.0) / n
            return f"tasks within ±25% of this length: {n}, timeout rate {rate:.1f}%"
    except Exception:
        return None
    return None


def render(prompt, include_db=True):
    data = analyze(prompt)
    lines = list(data["flags"])
    label, code = verdict(data["score"])
    if not lines:
        lines.append(f"0 length: {data['length']} chars (<2000 chars had 2.6% timeout rate; avg runtime 160s)")
    lines.append(f"VERDICT: {label} (score {data['score']})")
    context = bridge_context(data["length"]) if include_db else None
    if context:
        lines.append(context)
    return "\n".join(lines), code


def selftest():
    short = "Review one file.\n## Acceptance\n- Report exact output.\n"
    big = "x" * 5000 + "\n## One\n## Two\n## Three\n## Four\n" + "- item\n" * 10
    assert verdict(analyze(short)["score"])[0] == "OK"
    assert verdict(analyze(big)["score"])[0].startswith("SPLIT")
    print("selftest passed")


if __name__ == "__main__":
    if len(sys.argv) == 2 and sys.argv[1] == "--selftest":
        selftest()
        sys.exit(0)
    output, exit_code = render(read_prompt(sys.argv))
    print(output)
    sys.exit(exit_code)
