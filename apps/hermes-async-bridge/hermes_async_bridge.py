#!/usr/bin/env python3
"""
Hermes Async Task Bridge — native Streamable HTTP MCP server.

Phase 4 bridge hardening target:
- Run the official Python MCP SDK directly over Streamable HTTP.
- Require SDK bearer-token auth for MCP tool calls.
- Bind to an explicit Tailscale/LAN address, not 0.0.0.0 by default.
- Persist task/event/run/cost observability in SQLite.
- Export Hermes state.db transcripts and attach cost snapshots to results/callbacks.

The active launchd service can symlink ~/.hermes/scripts/hermes_async_bridge.py to
this file and execute it with the Hermes venv Python.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import logging
import os
import re
import signal
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Optional

LOG_LEVEL = os.environ.get("HERMES_ASYNC_BRIDGE_LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    stream=sys.stderr,
)
logger = logging.getLogger("hermes-async-bridge")

DEFAULT_HOME = Path.home() / ".hermes"
HERMES_HOME = Path(os.environ.get("HERMES_HOME", str(DEFAULT_HOME))).expanduser()
HERMES_BIN = os.environ.get("HERMES_ASYNC_BRIDGE_BIN", "hermes")
DB_PATH = Path(os.environ.get("HERMES_ASYNC_BRIDGE_DB", str(HERMES_HOME / "async_bridge.db"))).expanduser()
STATE_DB_PATH = Path(os.environ.get("HERMES_STATE_DB", str(HERMES_HOME / "state.db"))).expanduser()
TRANSCRIPT_DIR = Path(os.environ.get("HERMES_ASYNC_BRIDGE_TRANSCRIPT_DIR", "/tmp/hermes-async-bridge-transcripts")).expanduser()
REPO_ROOT = Path(os.environ.get("HERMES_ASYNC_BRIDGE_REPO", str(Path(__file__).resolve().parents[2]))).expanduser()
MAX_OUTPUT_CHARS = int(os.environ.get("HERMES_ASYNC_BRIDGE_MAX_OUTPUT_CHARS", "50000"))
TASK_TIMEOUT_SEC = int(os.environ.get("HERMES_ASYNC_BRIDGE_TASK_TIMEOUT_SEC", "600"))
MAX_CONCURRENT_TASKS = int(os.environ.get("HERMES_ASYNC_BRIDGE_MAX_CONCURRENT", "3"))
RETENTION_HOURS = int(os.environ.get("HERMES_ASYNC_BRIDGE_RETENTION_HOURS", "168"))
DEFAULT_HOST = os.environ.get("HERMES_ASYNC_BRIDGE_HOST", "127.0.0.1")
DEFAULT_PORT = int(os.environ.get("HERMES_ASYNC_BRIDGE_PORT", "8081"))
PUBLIC_BASE_URL = os.environ.get("HERMES_ASYNC_BRIDGE_PUBLIC_URL", f"http://{DEFAULT_HOST}:{DEFAULT_PORT}")
STREAMABLE_PATH = os.environ.get("HERMES_ASYNC_BRIDGE_PATH", "/mcp")
ISSUER_URL = os.environ.get("HERMES_ASYNC_BRIDGE_ISSUER", "https://hermes.local")
REQUIRED_SCOPES = tuple(s.strip() for s in os.environ.get("HERMES_ASYNC_BRIDGE_SCOPES", "hermes:submit").split(",") if s.strip())
ALLOWED_PROFILES = tuple(s.strip() for s in os.environ.get("HERMES_ASYNC_BRIDGE_PROFILES", "builder").split(",") if s.strip())

TERMINAL_STATUSES = {"completed", "failed", "cancelled"}

_SCHEMA = """
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS tasks (
    task_id       TEXT PRIMARY KEY,
    parent_task_id TEXT,
    session_id    TEXT,
    profile       TEXT,
    status        TEXT NOT NULL DEFAULT 'pending',
    prompt        TEXT NOT NULL,
    result        TEXT,
    error         TEXT,
    caller        TEXT,
    callback_url  TEXT,
    created_at    REAL NOT NULL,
    started_at    REAL,
    completed_at  REAL,
    pid           INTEGER,
    followups     TEXT DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);

CREATE TABLE IF NOT EXISTS mcp_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          REAL NOT NULL,
    task_id     TEXT,
    caller      TEXT,
    event_type  TEXT NOT NULL,
    payload     TEXT
);
CREATE INDEX IF NOT EXISTS idx_mcp_events_task ON mcp_events(task_id, ts);
CREATE INDEX IF NOT EXISTS idx_mcp_events_type ON mcp_events(event_type, ts);

CREATE TABLE IF NOT EXISTS task_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id     TEXT NOT NULL,
    session_id  TEXT,
    loop_index  INTEGER NOT NULL DEFAULT 0,
    command     TEXT NOT NULL,
    pid         INTEGER,
    exit_code   INTEGER,
    started_at  REAL NOT NULL,
    completed_at REAL,
    stdout_chars INTEGER DEFAULT 0,
    stderr_chars INTEGER DEFAULT 0,
    error       TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_runs_task ON task_runs(task_id, loop_index);

CREATE TABLE IF NOT EXISTS task_costs (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id           TEXT NOT NULL,
    session_id        TEXT NOT NULL,
    loop_index        INTEGER NOT NULL DEFAULT 0,
    provider          TEXT,
    model             TEXT,
    prompt_tokens     INTEGER,
    completion_tokens INTEGER,
    cache_read_tokens INTEGER,
    cache_write_tokens INTEGER,
    reasoning_tokens  INTEGER,
    total_tokens      INTEGER,
    estimated_usd     REAL,
    cost_source       TEXT,
    billing_provider  TEXT,
    billing_mode      TEXT,
    pricing_version   TEXT,
    cost_unreconciled INTEGER NOT NULL DEFAULT 0,
    expensive_tools_used TEXT NOT NULL DEFAULT '[]',
    captured_at       REAL NOT NULL,
    snapshot_json     TEXT NOT NULL,
    UNIQUE(task_id, session_id, loop_index)
);
CREATE INDEX IF NOT EXISTS idx_task_costs_task ON task_costs(task_id, loop_index);
CREATE INDEX IF NOT EXISTS idx_task_costs_session ON task_costs(session_id);
"""


def utc_now_iso() -> str:
    return dt.datetime.now(dt.UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _iter_schema_columns() -> Iterable[tuple[str, list[tuple[str, str]]]]:
    """Yield table names and declared column affinities from _SCHEMA."""
    create_table_re = re.compile(
        r"CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)\s*\((.*?)\);",
        re.IGNORECASE | re.DOTALL,
    )
    column_constraint_keywords = {
        "PRIMARY",
        "NOT",
        "NULL",
        "DEFAULT",
        "COLLATE",
        "REFERENCES",
        "CHECK",
        "UNIQUE",
        "GENERATED",
        "AS",
    }
    table_constraint_keywords = {"CONSTRAINT", "PRIMARY", "FOREIGN", "UNIQUE", "CHECK"}

    for table_name, body in create_table_re.findall(_SCHEMA):
        columns: list[tuple[str, str]] = []
        for raw_line in body.splitlines():
            line = raw_line.strip().rstrip(",")
            if not line or line.startswith("--"):
                continue
            parts = line.split()
            if not parts:
                continue
            first_token = parts[0].strip('"`[]')
            if first_token.split("(", 1)[0].upper() in table_constraint_keywords:
                continue
            column_name = first_token
            type_tokens: list[str] = []
            for token in parts[1:]:
                if token.upper() in column_constraint_keywords:
                    break
                type_tokens.append(token)
            columns.append((column_name, " ".join(type_tokens) or "TEXT"))
        yield table_name, columns


def _reconcile_schema(conn: sqlite3.Connection) -> None:
    """Add columns missing from older async_bridge.db files.

    CREATE TABLE IF NOT EXISTS does not alter existing tables, so deployed
    databases that predate newer nullable columns need an idempotent reconcile.
    """
    for table_name, declared_columns in _iter_schema_columns():
        existing_columns = {
            row["name"] if isinstance(row, sqlite3.Row) else row[1]
            for row in conn.execute(f"PRAGMA table_info({table_name})")
        }
        for column_name, column_type in declared_columns:
            if column_name in existing_columns:
                continue
            conn.execute(f"ALTER TABLE {table_name} ADD COLUMN {column_name} {column_type}")
            existing_columns.add(column_name)
    conn.commit()


def get_db() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH), timeout=30)
    conn.row_factory = sqlite3.Row
    conn.executescript(_SCHEMA)
    _reconcile_schema(conn)
    return conn


def log_event(event_type: str, *, task_id: str | None = None, caller: str | None = None, payload: Any = None) -> None:
    conn = get_db()
    try:
        conn.execute(
            "INSERT INTO mcp_events (ts, task_id, caller, event_type, payload) VALUES (?, ?, ?, ?, ?)",
            (time.time(), task_id, caller, event_type, _json_dumps(payload) if payload is not None else None),
        )
        conn.commit()
    finally:
        conn.close()


@dataclass
class Task:
    task_id: str
    session_id: Optional[str] = None
    status: str = "pending"
    prompt: str = ""
    result: Optional[str] = None
    error: Optional[str] = None
    caller: str = ""
    callback_url: Optional[str] = None
    parent_task_id: Optional[str] = None
    created_at: float = 0.0
    started_at: Optional[float] = None
    completed_at: Optional[float] = None
    pid: Optional[int] = None
    followups: list[dict[str, Any]] = field(default_factory=list)


class TaskManager:
    def __init__(self, max_concurrent: int = MAX_CONCURRENT_TASKS):
        self._semaphore = threading.Semaphore(max_concurrent)
        self._lock = threading.Lock()
        self._running: dict[str, subprocess.Popen[bytes]] = {}

    def submit(self, prompt: str, *, caller: str = "", callback_url: str | None = None, profile: str | None = None) -> str:
        task_id = str(uuid.uuid4())[:12]
        now = time.time()
        conn = get_db()
        try:
            conn.execute(
                """
                INSERT INTO tasks (task_id, status, prompt, caller, callback_url, profile, created_at, followups)
                VALUES (?, 'pending', ?, ?, ?, ?, ?, '[]')
                """,
                (task_id, prompt, caller, callback_url, profile, now),
            )
            conn.commit()
        finally:
            conn.close()
        log_event("submit", task_id=task_id, caller=caller, payload={"prompt_chars": len(prompt), "callback": bool(callback_url), "profile": profile})
        threading.Thread(target=self._run_task, args=(task_id, prompt, None, profile), daemon=True).start()
        return task_id

    def submit_followup(self, task_id: str, prompt: str, *, callback_url: str | None = None) -> str:
        conn = get_db()
        try:
            row = conn.execute(
                "SELECT session_id, caller, callback_url, profile FROM tasks WHERE task_id = ?",
                (task_id,),
            ).fetchone()
        finally:
            conn.close()
        if not row or not row["session_id"]:
            return ""

        session_id = row["session_id"]
        inherited_profile = row["profile"]
        new_task_id = str(uuid.uuid4())[:12]
        inherited_callback = callback_url if callback_url is not None else row["callback_url"]
        now = time.time()
        conn = get_db()
        try:
            conn.execute(
                """
                INSERT INTO tasks (task_id, parent_task_id, session_id, status, prompt, caller, callback_url, profile, created_at, followups)
                VALUES (?, ?, ?, 'pending', ?, 'followup', ?, ?, ?, '[]')
                """,
                (new_task_id, task_id, session_id, prompt, inherited_callback, inherited_profile, now),
            )
            conn.execute(
                "UPDATE tasks SET followups = json_insert(COALESCE(followups, '[]'), '$[#]', json(?)) WHERE task_id = ?",
                (_json_dumps({"task_id": new_task_id, "prompt": prompt}), task_id),
            )
            conn.commit()
        finally:
            conn.close()
        log_event("respond", task_id=new_task_id, caller="followup", payload={"parent_task_id": task_id, "profile": inherited_profile})
        threading.Thread(target=self._run_task, args=(new_task_id, prompt, session_id, inherited_profile), daemon=True).start()
        return new_task_id

    def get_status(self, task_id: str) -> dict[str, Any] | None:
        conn = get_db()
        try:
            row = conn.execute(
                """
                SELECT task_id, parent_task_id, session_id, status, prompt, error, created_at, started_at, completed_at
                FROM tasks WHERE task_id = ?
                """,
                (task_id,),
            ).fetchone()
        finally:
            conn.close()
        if not row:
            return None
        return {
            "task_id": row["task_id"],
            "parent_task_id": row["parent_task_id"],
            "session_id": row["session_id"],
            "status": row["status"],
            "prompt": (row["prompt"] or "")[:200],
            "error": row["error"],
            "created_at": row["created_at"],
            "started_at": row["started_at"],
            "completed_at": row["completed_at"],
        }

    def get_result(self, task_id: str) -> dict[str, Any] | None:
        conn = get_db()
        try:
            row = conn.execute(
                """
                SELECT task_id, parent_task_id, session_id, status, result, error, created_at, completed_at
                FROM tasks WHERE task_id = ?
                """,
                (task_id,),
            ).fetchone()
        finally:
            conn.close()
        if not row:
            return None
        result = row["result"]
        if result and len(result) > MAX_OUTPUT_CHARS:
            result = result[:MAX_OUTPUT_CHARS] + "\n...[truncated]..."
        cost = latest_cost_snapshot(task_id)
        return {
            "task_id": row["task_id"],
            "parent_task_id": row["parent_task_id"],
            "session_id": row["session_id"],
            "status": row["status"],
            "result": result,
            "error": row["error"],
            "created_at": row["created_at"],
            "completed_at": row["completed_at"],
            "cost": cost,
        }

    def cancel(self, task_id: str) -> bool:
        conn = get_db()
        try:
            row = conn.execute("SELECT status, pid FROM tasks WHERE task_id = ?", (task_id,)).fetchone()
            if not row or row["status"] in TERMINAL_STATUSES:
                return False
            pid = row["pid"]
            if pid:
                try:
                    os.kill(pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
            conn.execute("UPDATE tasks SET status='cancelled', completed_at=? WHERE task_id=?", (time.time(), task_id))
            conn.commit()
        finally:
            conn.close()
        log_event("cancel", task_id=task_id)
        return True

    def list_tasks(self, *, status_filter: str | None = None, limit: int = 20) -> list[dict[str, Any]]:
        conn = get_db()
        try:
            if status_filter:
                rows = conn.execute(
                    """
                    SELECT task_id, parent_task_id, session_id, status, prompt, caller, created_at, completed_at
                    FROM tasks WHERE status = ? ORDER BY created_at DESC LIMIT ?
                    """,
                    (status_filter, limit),
                ).fetchall()
            else:
                rows = conn.execute(
                    """
                    SELECT task_id, parent_task_id, session_id, status, prompt, caller, created_at, completed_at
                    FROM tasks ORDER BY created_at DESC LIMIT ?
                    """,
                    (limit,),
                ).fetchall()
        finally:
            conn.close()
        return [
            {
                "task_id": r["task_id"],
                "parent_task_id": r["parent_task_id"],
                "session_id": r["session_id"],
                "status": r["status"],
                "prompt": (r["prompt"] or "")[:100],
                "caller": r["caller"],
                "created_at": r["created_at"],
                "completed_at": r["completed_at"],
            }
            for r in rows
        ]

    def list_sessions(self, limit: int = 10) -> list[dict[str, Any]]:
        conn = get_db()
        try:
            rows = conn.execute(
                """
                SELECT task_id, session_id, status, prompt, created_at, completed_at
                FROM tasks WHERE session_id IS NOT NULL AND session_id != ''
                ORDER BY created_at DESC LIMIT ?
                """,
                (limit,),
            ).fetchall()
        finally:
            conn.close()
        return [
            {
                "task_id": r["task_id"],
                "session_id": r["session_id"],
                "status": r["status"],
                "prompt": (r["prompt"] or "")[:150],
                "created_at": r["created_at"],
                "completed_at": r["completed_at"],
            }
            for r in rows
        ]

    def cleanup_old(self) -> int:
        if RETENTION_HOURS <= 0:
            return 0
        cutoff = time.time() - (RETENTION_HOURS * 3600)
        conn = get_db()
        try:
            cursor = conn.execute(
                "DELETE FROM tasks WHERE created_at < ? AND status IN ('completed', 'failed', 'cancelled')",
                (cutoff,),
            )
            conn.commit()
            deleted = int(cursor.rowcount or 0)
        finally:
            conn.close()
        if deleted:
            log_event("retention_cleanup", payload={"deleted": deleted, "retention_hours": RETENTION_HOURS})
        return deleted

    def _run_task(self, task_id: str, prompt: str, session_id: str | None, profile: str | None = None) -> None:
        self._semaphore.acquire()
        run_id: int | None = None
        started_at = time.time()
        cmd = [HERMES_BIN]
        if profile:
            cmd.extend(["-p", profile])
        cmd.extend(["chat", "-q", prompt, "-Q", "--yolo", "--pass-session-id", "--source", "tool"])
        if session_id:
            cmd.extend(["--resume", session_id])
        try:
            conn = get_db()
            try:
                conn.execute("UPDATE tasks SET status='running', started_at=? WHERE task_id=?", (started_at, task_id))
                cur = conn.execute(
                    "INSERT INTO task_runs (task_id, session_id, loop_index, command, started_at) VALUES (?, ?, ?, ?, ?)",
                    (task_id, session_id, loop_index_for_task(task_id), _json_dumps(cmd_for_log(cmd)), started_at),
                )
                run_id = int(cur.lastrowid or 0)
                conn.commit()
            finally:
                conn.close()

            logger.info("Running task %s", task_id)
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env={**os.environ, "HERMES_HOME": str(HERMES_HOME)},
            )
            with self._lock:
                self._running[task_id] = proc
            conn = get_db()
            try:
                conn.execute("UPDATE tasks SET pid=? WHERE task_id=?", (proc.pid, task_id))
                if run_id is not None:
                    conn.execute("UPDATE task_runs SET pid=? WHERE id=?", (proc.pid, run_id))
                conn.commit()
            finally:
                conn.close()

            try:
                stdout, stderr = proc.communicate(timeout=TASK_TIMEOUT_SEC)
            except subprocess.TimeoutExpired:
                proc.kill()
                stdout, stderr = proc.communicate()
                self._set_failed(task_id, f"Task timed out after {TASK_TIMEOUT_SEC}s", "")
                self._finish_run(run_id, -1, stdout, stderr, f"Task timed out after {TASK_TIMEOUT_SEC}s")
                self._notify_terminal(task_id)
                return
            finally:
                with self._lock:
                    self._running.pop(task_id, None)

            stdout_text = stdout.decode("utf-8", errors="replace").strip()
            stderr_text = stderr.decode("utf-8", errors="replace").strip()
            parsed_session_id = parse_session_id(stderr_text) or parse_session_id(stdout_text) or session_id or ""
            self._finish_run(run_id, proc.returncode, stdout, stderr, None if proc.returncode == 0 else stderr_text)

            if proc.returncode != 0:
                error_msg = stderr_text or f"Hermes exited with code {proc.returncode}"
                self._set_failed(task_id, error_msg, stdout_text, parsed_session_id or None)
                capture_and_store_cost(task_id, parsed_session_id, loop_index_for_task(task_id))
                self._notify_terminal(task_id)
                return

            response_text = parse_response(stdout_text)
            conn = get_db()
            try:
                conn.execute(
                    "UPDATE tasks SET status='completed', result=?, session_id=?, completed_at=? WHERE task_id=?",
                    (response_text, parsed_session_id, time.time(), task_id),
                )
                conn.commit()
            finally:
                conn.close()
            capture_and_store_cost(task_id, parsed_session_id, loop_index_for_task(task_id))
            log_event("completed", task_id=task_id, payload={"session_id": parsed_session_id})
            self._notify_terminal(task_id)
        except Exception as exc:
            logger.exception("Task %s crashed", task_id)
            self._set_failed(task_id, str(exc), "")
            self._finish_run(run_id, None, b"", b"", str(exc))
            self._notify_terminal(task_id)
        finally:
            self._semaphore.release()

    def _set_failed(self, task_id: str, error: str, partial_output: str, session_id: str | None = None) -> None:
        conn = get_db()
        try:
            conn.execute(
                "UPDATE tasks SET status='failed', error=?, result=?, session_id=COALESCE(?, session_id), completed_at=? WHERE task_id=?",
                (error, partial_output, session_id, time.time(), task_id),
            )
            conn.commit()
        finally:
            conn.close()
        log_event("failed", task_id=task_id, payload={"error": error[:500], "session_id": session_id})

    def _finish_run(self, run_id: int | None, exit_code: int | None, stdout: bytes, stderr: bytes, error: str | None) -> None:
        if run_id is None:
            return
        conn = get_db()
        try:
            conn.execute(
                """
                UPDATE task_runs SET exit_code=?, completed_at=?, stdout_chars=?, stderr_chars=?, error=? WHERE id=?
                """,
                (exit_code, time.time(), len(stdout), len(stderr), error, run_id),
            )
            conn.commit()
        finally:
            conn.close()

    def _notify_terminal(self, task_id: str) -> None:
        result = self.get_result(task_id)
        if not result:
            return
        callback_url = callback_url_for_task(task_id)
        if callback_url:
            send_callback(callback_url, callback_payload(result))


def loop_index_for_task(task_id: str) -> int:
    conn = get_db()
    try:
        row = conn.execute("SELECT parent_task_id FROM tasks WHERE task_id=?", (task_id,)).fetchone()
        if not row or not row["parent_task_id"]:
            return 0
        # Followup rows are one loop later than their parent. This is intentionally
        # simple and task-local; clients should treat the latest snapshot as cumulative.
        return 1 + int(conn.execute("SELECT COUNT(*) FROM tasks WHERE parent_task_id=? AND created_at < (SELECT created_at FROM tasks WHERE task_id=?)", (row["parent_task_id"], task_id)).fetchone()[0])
    finally:
        conn.close()


def cmd_for_log(cmd: list[str]) -> list[str]:
    if "-q" in cmd:
        idx = cmd.index("-q")
        if idx + 1 < len(cmd):
            redacted = list(cmd)
            redacted[idx + 1] = f"<prompt chars={len(cmd[idx + 1])}>"
            return redacted
    return cmd


def parse_session_id(text: str) -> str:
    match = re.search(r"session_id:\s*([\w_]+)", text)
    return match.group(1) if match else ""


def parse_response(stdout: str) -> str:
    result_lines: list[str] = []
    skip_leading_blank = True
    for line in stdout.split("\n"):
        if line.startswith("session_id:") or line.startswith("Warning: Unknown toolsets"):
            continue
        if skip_leading_blank and not line.strip():
            continue
        skip_leading_blank = False
        result_lines.append(line)
    return "\n".join(result_lines).strip()


def callback_url_for_task(task_id: str) -> str | None:
    conn = get_db()
    try:
        row = conn.execute("SELECT callback_url FROM tasks WHERE task_id=?", (task_id,)).fetchone()
        return row["callback_url"] if row and row["callback_url"] else None
    finally:
        conn.close()


def latest_cost_snapshot(task_id: str) -> dict[str, Any] | None:
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT snapshot_json FROM task_costs WHERE task_id=? ORDER BY loop_index DESC, captured_at DESC LIMIT 1",
            (task_id,),
        ).fetchone()
    finally:
        conn.close()
    if not row:
        return None
    return json.loads(row["snapshot_json"])


def all_cost_snapshots(task_id: str) -> list[dict[str, Any]]:
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT snapshot_json FROM task_costs WHERE task_id=? ORDER BY loop_index ASC, captured_at ASC",
            (task_id,),
        ).fetchall()
    finally:
        conn.close()
    return [json.loads(r["snapshot_json"]) for r in rows]


def state_session_row(session_id: str) -> sqlite3.Row | None:
    if not session_id or not STATE_DB_PATH.exists():
        return None
    conn = sqlite3.connect(str(STATE_DB_PATH), timeout=10)
    conn.row_factory = sqlite3.Row
    try:
        return conn.execute(
            """
            SELECT id, model, billing_provider, billing_base_url, billing_mode,
                   input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                   reasoning_tokens, tool_call_count, estimated_cost_usd, cost_source,
                   pricing_version
            FROM sessions WHERE id = ?
            """,
            (session_id,),
        ).fetchone()
    finally:
        conn.close()


def expensive_tools_for_session(session_id: str, row: sqlite3.Row | None = None) -> list[str]:
    tools: set[str] = set()
    if row and (row["billing_provider"] == "moa" or row["billing_base_url"] == "moa://local"):
        tools.add("moa")
    if not session_id or not STATE_DB_PATH.exists():
        return sorted(tools)
    conn = sqlite3.connect(str(STATE_DB_PATH), timeout=10)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            """
            SELECT tool_name, tool_calls FROM messages
            WHERE session_id=? AND (tool_name IS NOT NULL OR tool_calls IS NOT NULL)
            """,
            (session_id,),
        ).fetchall()
    finally:
        conn.close()
    for msg in rows:
        if msg["tool_name"] == "delegate_task":
            tools.add("delegate_task")
        calls = msg["tool_calls"]
        if calls:
            try:
                parsed = json.loads(calls)
            except Exception:
                parsed = []
            for call in parsed if isinstance(parsed, list) else []:
                name = None
                if isinstance(call, dict):
                    name = call.get("name") or (call.get("function") or {}).get("name")
                if name == "delegate_task":
                    tools.add("delegate_task")
    return sorted(tools)


def capture_and_store_cost(task_id: str, session_id: str | None, loop_index: int) -> dict[str, Any] | None:
    if not session_id:
        return None
    row = state_session_row(session_id)
    if not row:
        return None
    prompt_tokens = int(row["input_tokens"] or 0)
    completion_tokens = int(row["output_tokens"] or 0)
    cache_read_tokens = int(row["cache_read_tokens"] or 0)
    cache_write_tokens = int(row["cache_write_tokens"] or 0)
    reasoning_tokens = int(row["reasoning_tokens"] or 0)
    total_tokens = prompt_tokens + completion_tokens + cache_read_tokens + cache_write_tokens + reasoning_tokens
    estimated_usd = row["estimated_cost_usd"]
    cost_source = row["cost_source"]
    billing_provider = row["billing_provider"]
    billing_mode = row["billing_mode"]
    cost_unreconciled = bool(
        (billing_provider == "moa" or row["billing_base_url"] == "moa://local")
        and (estimated_usd in (None, 0, 0.0))
        and (cost_source in (None, "none"))
    )
    captured_at = time.time()
    snapshot = {
        "taskId": task_id,
        "hermesSessionId": session_id,
        "loopIndex": loop_index,
        "provider": billing_provider,
        "model": row["model"],
        "promptTokens": prompt_tokens,
        "completionTokens": completion_tokens,
        "totalTokens": total_tokens,
        "estimatedUsd": None if cost_unreconciled else estimated_usd,
        "expensiveToolsUsed": expensive_tools_for_session(session_id, row),
        "costSource": cost_source,
        "billingProvider": billing_provider,
        "billingMode": billing_mode,
        "pricingVersion": row["pricing_version"],
        "costUnreconciled": cost_unreconciled,
        "source": "state.db",
        "capturedAt": utc_now_iso(),
    }
    conn = get_db()
    try:
        conn.execute(
            """
            INSERT OR REPLACE INTO task_costs
            (task_id, session_id, loop_index, provider, model, prompt_tokens, completion_tokens,
             cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens, estimated_usd,
             cost_source, billing_provider, billing_mode, pricing_version, cost_unreconciled,
             expensive_tools_used, captured_at, snapshot_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                task_id,
                session_id,
                loop_index,
                billing_provider,
                row["model"],
                prompt_tokens,
                completion_tokens,
                cache_read_tokens,
                cache_write_tokens,
                reasoning_tokens,
                total_tokens,
                estimated_usd,
                cost_source,
                billing_provider,
                billing_mode,
                row["pricing_version"],
                1 if cost_unreconciled else 0,
                _json_dumps(snapshot["expensiveToolsUsed"]),
                captured_at,
                _json_dumps(snapshot),
            ),
        )
        conn.commit()
    finally:
        conn.close()
    log_event("cost_captured", task_id=task_id, payload=snapshot)
    return snapshot


def export_transcript(session_id: str, *, include_body: bool = True) -> dict[str, Any]:
    if not session_id:
        raise ValueError("session_id is required")
    TRANSCRIPT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = TRANSCRIPT_DIR / f"hermes-{session_id}.jsonl"
    cmd = [HERMES_BIN, "sessions", "export", str(out_path), "--session-id", session_id]
    proc = subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=60,
        env={**os.environ, "HERMES_HOME": str(HERMES_HOME)},
    )
    if proc.returncode != 0:
        logger.warning("hermes sessions export failed; falling back to state.db: %s", proc.stderr.strip())
        write_state_db_transcript(session_id, out_path)
    if not out_path.exists():
        raise RuntimeError(f"transcript export did not produce {out_path}")
    payload = {"session_id": session_id, "path": str(out_path), "evidence_tier": "T2"}
    if include_body:
        payload["jsonl"] = out_path.read_text(encoding="utf-8", errors="replace")
    return payload


def write_state_db_transcript(session_id: str, out_path: Path) -> None:
    row = state_session_row(session_id)
    if not row:
        raise RuntimeError(f"session not found in {STATE_DB_PATH}: {session_id}")
    conn = sqlite3.connect(str(STATE_DB_PATH), timeout=10)
    conn.row_factory = sqlite3.Row
    try:
        messages = conn.execute(
            """
            SELECT role, content, tool_call_id, tool_calls, tool_name, timestamp
            FROM messages WHERE session_id=? ORDER BY timestamp, id
            """,
            (session_id,),
        ).fetchall()
    finally:
        conn.close()
    export = {
        "id": session_id,
        "session_id": session_id,
        "model": row["model"],
        "billing_provider": row["billing_provider"],
        "billing_base_url": row["billing_base_url"],
        "messages": [
            {
                "role": m["role"],
                "content": m["content"],
                "tool_call_id": m["tool_call_id"],
                "tool_calls": json.loads(m["tool_calls"]) if m["tool_calls"] else None,
                "name": m["tool_name"],
                "timestamp": m["timestamp"],
            }
            for m in messages
        ],
    }
    out_path.write_text(_json_dumps(export) + "\n", encoding="utf-8")


def decompose_with_repo(transcript_jsonl: str, original_prompt: str) -> dict[str, Any]:
    verifier_dir = REPO_ROOT / "apps" / "verifier"
    dist_decompose_cli = verifier_dir / "dist" / "hermes" / "decompose-cli.js"
    if not dist_decompose_cli.exists():
        build = subprocess.run(["pnpm", "run", "typecheck"], cwd=str(verifier_dir), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=120)
        if build.returncode != 0:
            raise RuntimeError(f"pnpm run typecheck failed: {build.stderr or build.stdout}")
        compile_proc = subprocess.run(["pnpm", "exec", "tsc", "-p", "tsconfig.json"], cwd=str(verifier_dir), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=120)
        if compile_proc.returncode != 0:
            raise RuntimeError(f"tsc failed: {compile_proc.stderr or compile_proc.stdout}")
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as handle:
        json.dump({"transcriptJsonl": transcript_jsonl, "originalPrompt": original_prompt}, handle)
        input_path = handle.name
    try:
        proc = subprocess.run(["node", str(dist_decompose_cli), input_path], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=60)
    finally:
        try:
            os.unlink(input_path)
        except OSError:
            pass
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr or proc.stdout)
    return json.loads(proc.stdout)


def callback_payload(result: dict[str, Any]) -> dict[str, Any]:
    transcript_path: str | None = None
    evidence_tier = "T1" if result.get("session_id") else "T0"
    if result.get("session_id"):
        try:
            transcript = export_transcript(str(result["session_id"]), include_body=False)
            transcript_path = transcript.get("path")
            evidence_tier = transcript.get("evidence_tier", "T2")
        except Exception as exc:
            logger.warning("callback transcript export failed: %s", exc)
    return {
        "type": "event",
        "name": "stop",
        "taskId": result["task_id"],
        "hermesSessionId": result.get("session_id"),
        "status": result.get("status"),
        "timestamp": int(time.time() * 1000),
        "resultSummary": (result.get("result") or "")[:1000],
        "transcriptPath": transcript_path,
        "evidenceTierAvailable": evidence_tier,
        "cost": result.get("cost"),
    }


def send_callback(url: str, payload: dict[str, Any]) -> None:
    body = _json_dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=body, method="POST", headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            log_event("callback_sent", task_id=payload.get("taskId"), payload={"url": url, "status": response.status})
    except (urllib.error.URLError, TimeoutError) as exc:
        log_event("callback_failed", task_id=payload.get("taskId"), payload={"url": url, "error": str(exc)})
        logger.warning("callback failed for %s: %s", url, exc)


class StaticBearerVerifier:
    def __init__(self, token: str, *, client_id: str = "hermes-bridge"):
        self.token = token
        self.client_id = client_id

    async def verify_token(self, token: str):  # return AccessToken | None; typed lazily to keep py_compile dependency-free
        if token != self.token:
            return None
        from mcp.server.auth.provider import AccessToken  # type: ignore[import-not-found]

        return AccessToken(token=token, client_id=self.client_id, scopes=list(REQUIRED_SCOPES))


def create_mcp_server(*, host: str, port: int, token: str | None, allow_unauthenticated: bool = False):
    try:
        from mcp.server.auth.settings import AuthSettings  # type: ignore[import-not-found]
        from mcp.server.fastmcp import FastMCP  # type: ignore[import-not-found]
    except ImportError as exc:
        logger.error("MCP SDK not available. Install/pin mcp>=1.26,<2 in the Hermes venv: %s", exc)
        raise

    kwargs: dict[str, Any] = {
        "name": "hermes-async",
        "instructions": (
            "Hermes Agent async task bridge. Submit tasks to Hermes Agent on the Mac mini, "
            "poll status, fetch transcript evidence, and read cost snapshots. MCP tool calls "
            "require bearer auth when running over HTTP."
        ),
        "host": host,
        "port": port,
        "streamable_http_path": STREAMABLE_PATH,
    }
    if token:
        kwargs.update(
            token_verifier=StaticBearerVerifier(token),
            auth=AuthSettings(
                issuer_url=ISSUER_URL,
                resource_server_url=PUBLIC_BASE_URL,
                required_scopes=list(REQUIRED_SCOPES),
            ),
        )
    elif not allow_unauthenticated:
        raise RuntimeError("HERMES_ASYNC_BRIDGE_TOKEN is required for native HTTP MCP auth")

    mcp = FastMCP(**kwargs)
    task_mgr = TaskManager()

    @mcp.tool()
    def hermes_submit(prompt: str, caller: str = "", callback_url: str = "", profile: str = "") -> str:
        if not prompt or not prompt.strip():
            return _json_dumps({"error": "prompt is required"})
        prompt = prompt.strip()
        if len(prompt) > 20000:
            return _json_dumps({"error": "prompt too long (max 20000 chars)"})
        profile = profile.strip()
        if profile and profile not in ALLOWED_PROFILES:
            return _json_dumps({"error": f"unknown profile: {profile}. Allowed: {', '.join(ALLOWED_PROFILES)} (empty = default)"})
        task_id = task_mgr.submit(prompt, caller=caller, callback_url=callback_url or None, profile=profile or None)
        return _json_dumps({"task_id": task_id, "status": "pending", "message": "Task submitted. Poll hermes_status.", "profile": profile or "default"})

    @mcp.tool()
    def hermes_status(task_id: str) -> str:
        log_event("status", task_id=task_id)
        status = task_mgr.get_status(task_id)
        return _json_dumps(status or {"error": f"Task not found: {task_id}"})

    @mcp.tool()
    def hermes_result(task_id: str) -> str:
        log_event("result", task_id=task_id)
        result = task_mgr.get_result(task_id)
        if not result:
            return _json_dumps({"error": f"Task not found: {task_id}"})
        if result["status"] not in TERMINAL_STATUSES:
            return _json_dumps({"task_id": task_id, "status": result["status"], "message": "Task is still running."})
        return _json_dumps(result)

    @mcp.tool()
    def hermes_respond(task_id: str, prompt: str, callback_url: str = "") -> str:
        if not task_id or not prompt or not prompt.strip():
            return _json_dumps({"error": "task_id and prompt are required"})
        new_task_id = task_mgr.submit_followup(task_id, prompt.strip(), callback_url=callback_url or None)
        if not new_task_id:
            return _json_dumps({"error": f"Could not follow up. Task {task_id} not found or has no session_id."})
        return _json_dumps({"task_id": new_task_id, "parent_task_id": task_id, "status": "pending"})

    @mcp.tool()
    def hermes_cancel(task_id: str) -> str:
        cancelled = task_mgr.cancel(task_id)
        return _json_dumps({"task_id": task_id, "status": "cancelled"} if cancelled else {"error": f"Could not cancel task {task_id}"})

    @mcp.tool()
    def hermes_list(status: str = "", limit: int = 20) -> str:
        limit = max(1, min(int(limit), 100))
        tasks = task_mgr.list_tasks(status_filter=status or None, limit=limit)
        return _json_dumps({"tasks": tasks, "count": len(tasks)})

    @mcp.tool()
    def hermes_sessions(limit: int = 10) -> str:
        limit = max(1, min(int(limit), 50))
        sessions = task_mgr.list_sessions(limit=limit)
        return _json_dumps({"sessions": sessions, "count": len(sessions)})

    @mcp.tool()
    def hermes_transcript(session_id: str, include_body: bool = True) -> str:
        log_event("transcript", payload={"session_id": session_id, "include_body": include_body})
        try:
            return _json_dumps(export_transcript(session_id, include_body=include_body))
        except Exception as exc:
            return _json_dumps({"error": str(exc), "session_id": session_id, "evidence_tier": "T1"})

    @mcp.tool()
    def hermes_decompose(session_id: str = "", transcript_jsonl: str = "", original_prompt: str = "") -> str:
        try:
            if not transcript_jsonl:
                if not session_id:
                    return _json_dumps({"error": "session_id or transcript_jsonl is required"})
                transcript_jsonl = export_transcript(session_id, include_body=True)["jsonl"]
            return _json_dumps(decompose_with_repo(transcript_jsonl, original_prompt))
        except Exception as exc:
            return _json_dumps({"error": str(exc)})

    @mcp.tool()
    def hermes_task_cost(task_id: str, history: bool = False) -> str:
        snapshots = all_cost_snapshots(task_id)
        if history:
            return _json_dumps({"task_id": task_id, "costs": snapshots})
        return _json_dumps({"task_id": task_id, "cost": snapshots[-1] if snapshots else None})

    @mcp.custom_route("/healthz", methods=["GET"], include_in_schema=False)
    async def healthz(request):  # noqa: ANN001 - Starlette request type is optional at runtime
        from starlette.responses import PlainTextResponse  # type: ignore[import-not-found]

        return PlainTextResponse("ok\n")

    task_mgr.cleanup_old()
    return mcp


def parse_args(argv: Iterable[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Hermes native HTTP MCP async bridge")
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--transport", choices=("streamable-http", "stdio"), default=os.environ.get("HERMES_ASYNC_BRIDGE_TRANSPORT", "streamable-http"))
    parser.add_argument("--allow-unauthenticated", action="store_true", help="Only for local stdio/test use; never use for network HTTP")
    return parser.parse_args(list(argv))


def main(argv: Iterable[str] = sys.argv[1:]) -> int:
    args = parse_args(argv)
    token = os.environ.get("HERMES_ASYNC_BRIDGE_TOKEN")
    if args.transport == "streamable-http" and args.host in ("0.0.0.0", "::"):
        raise RuntimeError("Refusing blind bind by default. Set a Tailscale/LAN host, not 0.0.0.0.")
    logger.info("Hermes Async Task Bridge starting: transport=%s host=%s port=%s path=%s db=%s state_db=%s", args.transport, args.host, args.port, STREAMABLE_PATH, DB_PATH, STATE_DB_PATH)
    mcp = create_mcp_server(host=args.host, port=args.port, token=token, allow_unauthenticated=args.allow_unauthenticated or args.transport == "stdio")
    mcp.run(transport=args.transport)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
