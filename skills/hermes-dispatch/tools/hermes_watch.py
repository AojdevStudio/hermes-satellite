#!/usr/bin/env python3
"""Hermes dispatch watcher = the INTERRUPTER.
Polls a task in the background (per hermes-polling.md math) and prints a line ONLY on a
state change worth surfacing: done, stuck, not-responding, or a sparse still-alive heartbeat.
Run under Monitor: each printed line becomes a chat notification that interrupts the conversation."""
import json
import os
import sys
import time
import urllib.request


ENV_PATH = os.path.expanduser("~/.hermes/.env")


def env_from_file(key):
    if not os.path.exists(ENV_PATH):
        return ""
    with open(ENV_PATH, encoding="utf-8") as f:
        for line in f:
            if line.startswith(f"{key}="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""


def env_value(key):
    return os.environ.get(key, "").strip().strip('"').strip("'") or env_from_file(key)


def mcp_url():
    url = env_value("HERMES_MCP_URL")
    if url:
        return url
    print("HERMES_MCP_URL missing - set HERMES_MCP_URL in the environment or add it to ~/.hermes/.env", file=sys.stderr)
    sys.exit(1)


def token():
    return env_value("HERMES_MCP_TOKEN")


URL = mcp_url()
TOK = token()
task_id = (sys.argv[1] if len(sys.argv) > 1 else "").strip()
SID = {"v": None}


def rpc(method, params=None, notify=False):
    b = {"jsonrpc": "2.0", "method": method}
    if not notify:
        b["id"] = int(time.time() * 1000) % 100000
    if params is not None:
        b["params"] = params
    h = {"Authorization": f"Bearer {TOK}", "Accept": "application/json, text/event-stream", "Content-Type": "application/json"}
    if SID["v"]:
        h["mcp-session-id"] = SID["v"]
    req = urllib.request.Request(URL, data=json.dumps(b).encode(), headers=h, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            SID["v"] = r.headers.get("mcp-session-id") or SID["v"]
            text = r.read().decode("utf-8", "replace")
    except Exception as e:
        return {"_err": str(e)[:120]}
    pl = None
    for line in text.splitlines():
        if line.startswith("data:"):
            try:
                pl = json.loads(line[5:].strip())
            except Exception:
                pass
    return pl or {}


def tool(name, args):
    r = rpc("tools/call", {"name": name, "arguments": args})
    if "_err" in r:
        return {"parsed": {}, "err": r["_err"], "text": ""}
    res = r.get("result", {})
    txt = "".join(c.get("text", "") for c in res.get("content", []) or [] if c.get("type") == "text")
    payload = res.get("structuredContent") if isinstance(res.get("structuredContent"), dict) else None
    if payload is None and txt:
        try:
            payload = json.loads(txt)
        except Exception:
            payload = None
    if isinstance(payload, dict) and isinstance(payload.get("result"), str):
        try:
            payload = json.loads(payload["result"])
        except Exception:
            pass
    return {"parsed": payload or {}, "err": None, "text": txt}


def emit(m):
    print(m, flush=True)


if not task_id:
    emit("no task_id to watch")
    sys.exit(0)

TERMINAL = {"completed", "complete", "done", "failed", "error", "cancelled", "canceled"}
emit(f"Watching Hermes task {task_id} - I will interrupt on done / stuck / not-responding.")
# MCP requires an initialize handshake before any tool call (this was the bug: the watcher polled without one, so every call was rejected)
rpc("initialize", {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "hermes-watcher", "version": "1"}})
rpc("notifications/initialized", {}, notify=True)
t0 = time.time()
errors = 0
was_down = False
hb = set()
INITIAL, INTERVAL, STUCK = 30, 120, 630  # per hermes-polling.md: 30s initial, 120s interval, 600s cap

time.sleep(INITIAL)
while True:
    st = tool("hermes_status", {"task_id": task_id})
    elapsed = int(time.time() - t0)
    if st["err"] or not st["parsed"]:
        errors += 1
        # only cry wolf on a SUSTAINED outage (~150s), not a single relay blip
        if errors == 5 and not was_down:
            was_down = True
            emit(f"Hermes NOT RESPONDING - bridge unreachable for task {task_id} ({errors} checks, {elapsed}s in). Retrying; I will confirm the moment it recovers.")
        time.sleep(INTERVAL)
        continue
    status = (st["parsed"].get("status") or "").lower()
    if was_down:
        was_down = False
        emit(f"Hermes bridge RECOVERED - back in contact with {task_id} at {elapsed}s (task {status or 'running'}).")
    errors = 0
    if status in TERMINAL:
        res = tool("hermes_result", {"task_id": task_id})
        rp = res["parsed"]
        outcome = (rp.get("result") or rp.get("error") or res["text"] or "")[:400].replace("\n", " ")
        emit(f"Hermes {status.upper()} - task {task_id} after {elapsed}s. Result: {outcome}")
        break
    for mark in (120, 300, 480):
        if elapsed >= mark and mark not in hb:
            hb.add(mark)
            emit(f"Hermes still working on {task_id} - {elapsed}s in, status={status}. Alive, no action needed.")
    if elapsed >= STUCK:
        emit(f"Hermes STUCK - task {task_id} past the 600s cap, likely timed out. Pull the result and check.")
        break
    time.sleep(INTERVAL)
