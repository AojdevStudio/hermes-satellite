#!/usr/bin/env bun
/**
 * hst — hermes-satellite bridge observability CLI (v2).
 *
 * Single file, zero npm deps: bun:sqlite for the DB, hand-rolled
 * ccusage-style renderer (box tables, ANSI-aware widths, responsive
 * columns). Read-only over the async bridge's SQLite state.
 *
 * Install: symlink into a PATH dir as `hst` and/or `hermes-satellite`.
 */

import { Database } from "bun:sqlite";

// ── environment ────────────────────────────────────────────────────────────
const HOME = process.env.HOME ?? "";
const HERMES_HOME = process.env.HERMES_HOME ?? `${HOME}/.hermes`;
const DB_PATH = process.env.HERMES_ASYNC_BRIDGE_DB ?? `${HERMES_HOME}/async_bridge.db`;
const LOG_DIR = process.env.HERMES_ASYNC_BRIDGE_LOG_DIR ?? `${HOME}/Library/Logs`;
const TRANSCRIPT_DIR =
  process.env.HERMES_ASYNC_BRIDGE_TRANSCRIPT_DIR ?? "/tmp/hermes-async-bridge-transcripts";
const PORT = process.env.HERMES_ASYNC_BRIDGE_PORT ?? "8081";

// ── style ──────────────────────────────────────────────────────────────────
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const red = c("31"), grn = c("32"), ylw = c("33"), cyn = c("36"), mag = c("35");
const bold = c("1"), dim = c("2"), inv = c("7;31");

const GLYPH: Record<string, string> = {
  running: ylw("●"), pending: cyn("◌"), completed: grn("✓"),
  failed: red("✗"), cancelled: mag("⊘"),
};
const paintStatus = (s: string) => `${GLYPH[s] ?? " "} ${statusColor(s)}`;
function statusColor(s: string): string {
  if (s === "running") return ylw(s);
  if (s === "pending") return cyn(s);
  if (s === "completed") return grn(s);
  if (s === "failed") return red(s);
  if (s === "cancelled") return mag(s);
  return s;
}

// ── formatting ─────────────────────────────────────────────────────────────
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const width = (s: string) => {
  // ansi-stripped display width; CJK/emoji counted as 2
  let w = 0;
  for (const ch of s.replace(ANSI_RE, "")) {
    const cp = ch.codePointAt(0)!;
    w += cp >= 0x1100 && (cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0x1f300 && cp <= 0x1faff)) ? 2 : 1;
  }
  return w;
};
const pad = (s: string, n: number, right = false) => {
  const gap = Math.max(0, n - width(s));
  return right ? " ".repeat(gap) + s : s + " ".repeat(gap);
};
const trunc = (s: string, n: number) => {
  if (width(s) <= n) return s;
  let out = "";
  for (const ch of s.replace(ANSI_RE, "")) {
    if (width(out + ch) > n - 1) break;
    out += ch;
  }
  return out + dim("…");
};
const num = (v: number | null | undefined) => (v == null ? "-" : v.toLocaleString("en-US"));
const usd = (v: number | null | undefined) =>
  v == null || v === 0 ? dim("unknown") : `$${v.toFixed(4)}`;
const cost = (r: { estimated_usd?: number | null; billing_mode?: string | null }) =>
  r.billing_mode === "subscription_included" && !r.estimated_usd
    ? grn("$0") + dim(" (subscription)")
    : usd(r.estimated_usd);
const relTime = (epoch: number | null) => {
  if (!epoch) return "-";
  const s = Math.max(0, Date.now() / 1000 - epoch);
  if (s < 60) return `${s | 0}s ago`;
  if (s < 3600) return `${(s / 60) | 0}m ago`;
  if (s < 86400) return `${(s / 3600) | 0}h ${((s % 3600) / 60) | 0}m ago`;
  return `${(s / 86400) | 0}d ago`;
};
const localTime = (epoch: number | null) =>
  epoch ? new Date(epoch * 1000).toLocaleString("en-US", { hour12: false }) : "-";
const dur = (a: number | null, b: number | null) =>
  a && b ? (b - a < 60 ? `${(b - a) | 0}s` : `${((b - a) / 60) | 0}m ${((b - a) % 60) | 0}s`) : "-";

// ── renderer ───────────────────────────────────────────────────────────────
type Col = { h: string; right?: boolean; flex?: boolean };

function table(cols: Col[], rows: string[][]) {
  const term = process.stdout.columns || 120;
  const w = cols.map((col, i) =>
    Math.max(width(col.h), ...rows.map((r) => width(r[i] ?? ""))),
  );
  // shrink the flex column (if any) to fit the terminal
  const flexIdx = cols.findIndex((col) => col.flex);
  const chrome = 3 * cols.length + 1; // │ x │ y │
  const total = w.reduce((a, b) => a + b, 0) + chrome;
  if (flexIdx >= 0 && total > term) {
    w[flexIdx] = Math.max(16, w[flexIdx] - (total - term));
  }
  const line = (l: string, m: string, r: string) =>
    dim(l + w.map((n) => "─".repeat(n + 2)).join(m) + r);
  const row = (cells: string[]) =>
    dim("│") +
    cells
      .map((cell, i) => {
        const v = cols[i].flex ? trunc(cell ?? "", w[i]) : cell ?? "";
        return ` ${pad(v, w[i], cols[i].right)} `;
      })
      .join(dim("│")) +
    dim("│");
  const out = [line("┌", "┬", "┐"), row(cols.map((col) => bold(col.h)))];
  out.push(line("├", "┼", "┤"));
  for (const r of rows) out.push(row(r));
  out.push(line("└", "┴", "┘"));
  console.log(out.join("\n"));
}

function banner(sub: string) {
  console.log(`${inv(" HERMES SATELLITE ")} ${dim("·")} ${bold(sub)} ${dim(`· ${DB_PATH.replace(HOME, "~")}`)}\n`);
}
function section(t: string) {
  console.log(`${bold(red("▍"))}${bold(t)}`);
}
function kv(k: string, v: string) {
  console.log(`  ${dim(pad(k, 12))} ${v}`);
}

// ── db ─────────────────────────────────────────────────────────────────────
function db(): Database {
  try {
    const d = new Database(DB_PATH, { readwrite: true });
    d.exec("PRAGMA query_only = ON;");
    d.query("SELECT 1").get();
    return d;
  } catch {
    console.error(red(`hst: cannot open bridge db: ${DB_PATH}`));
    process.exit(1);
  }
}
type Task = {
  task_id: string; parent_task_id: string | null; session_id: string | null;
  status: string; prompt: string; result: string | null; error: string | null;
  caller: string | null; profile: string | null; created_at: number;
  started_at: number | null; completed_at: number | null; followups: string;
};

function resolveTask(d: Database, prefix: string): Task {
  const rows = d.query<Task, [string]>(`SELECT * FROM tasks WHERE task_id LIKE ?1 || '%'`).all(prefix);
  if (rows.length === 1) return rows[0];
  console.error(red(`hst: task prefix '${prefix}' matches ${rows.length} tasks`));
  for (const r of rows.slice(0, 8)) console.error(`  ${r.task_id}`);
  process.exit(1);
}

const wantJson = process.argv.includes("--json");
const argv = process.argv.slice(2).filter((a) => a !== "--json");
const cmd = argv[0] ?? "";
const flag = (name: string, dflt: string) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

// ── commands ───────────────────────────────────────────────────────────────
function cmdTasks() {
  const d = db();
  const n = Number(flag("-n", "15"));
  const status = flag("-s", "");
  const rows = d
    .query<Task, []>(
      `SELECT * FROM tasks ${status ? `WHERE status='${status.replace(/'/g, "")}'` : ""}
       ORDER BY created_at DESC LIMIT ${n}`,
    )
    .all();
  if (wantJson) return console.log(JSON.stringify(rows, null, 1));
  banner("tasks");
  if (!rows.length) return console.log(dim("  no tasks"));
  table(
    [
      { h: "id" }, { h: "status" }, { h: "profile" }, { h: "caller" },
      { h: "age", right: true }, { h: "took", right: true }, { h: "prompt", flex: true },
    ],
    rows.map((t) => [
      cyn(t.task_id.slice(0, 8)),
      paintStatus(t.status),
      t.profile ?? dim("default"),
      t.caller || dim("-"),
      relTime(t.created_at),
      dur(t.started_at, t.completed_at),
      t.prompt.replace(/\s+/g, " "),
    ]),
  );
  const counts = d.query<{ status: string; n: number }, []>(
    `SELECT status, COUNT(*) n FROM tasks GROUP BY status`).all();
  console.log(
    "\n  " + counts.map((r) => `${paintStatus(r.status)} ${bold(String(r.n))}`).join(dim("  ·  ")),
  );
}

function cmdTask() {
  const d = db();
  const t = resolveTask(d, argv[1] ?? die("usage: hst task <id-prefix>"));
  if (wantJson) return console.log(JSON.stringify(t, null, 1));
  banner(`task ${t.task_id}`);
  section("summary");
  kv("status", paintStatus(t.status));
  kv("profile", t.profile ?? dim("default"));
  kv("caller", t.caller || dim("-"));
  kv("session", t.session_id ?? dim("- (never started)"));
  if (t.parent_task_id) kv("parent", cyn(t.parent_task_id));
  kv("created", `${localTime(t.created_at)} ${dim(`(${relTime(t.created_at)})`)}`);
  kv("duration", dur(t.started_at, t.completed_at));
  console.log();
  section("prompt");
  console.log(t.prompt.split("\n").map((l) => `  ${l}`).join("\n") + "\n");

  const runs = d.query<any, [string]>(
    `SELECT loop_index, pid, exit_code, started_at, completed_at
     FROM task_runs WHERE task_id=?1 ORDER BY loop_index`).all(t.task_id);
  if (runs.length) {
    section("runs");
    table(
      [{ h: "#", right: true }, { h: "pid", right: true }, { h: "exit", right: true }, { h: "took", right: true }],
      runs.map((r) => [
        String(r.loop_index), String(r.pid ?? "-"),
        r.exit_code === 0 ? grn("0") : r.exit_code == null ? dim("-") : red(String(r.exit_code)),
        dur(r.started_at, r.completed_at),
      ]),
    );
  }
  const costs = d.query<any, [string]>(
    `SELECT * FROM task_costs WHERE task_id=?1`).all(t.task_id);
  if (costs.length) {
    section("cost");
    for (const cRow of costs)
      kv(`loop ${cRow.loop_index}`,
        `${cost(cRow)} ${dim(`· in ${num(cRow.prompt_tokens)} · out ${num(cRow.completion_tokens)} · ${cRow.model ?? ""}`)}`);
    console.log();
  }
  const events = d.query<any, [string]>(
    `SELECT ts, event_type FROM mcp_events WHERE task_id=?1 ORDER BY ts`).all(t.task_id);
  if (events.length) {
    section("timeline");
    for (const e of events) kv(relTime(e.ts), e.event_type);
    console.log();
  }
  section(t.error ? "error" : "result");
  const body = t.result ?? t.error ?? dim("(none)");
  console.log(body.split("\n").map((l) => `  ${l}`).join("\n"));
  const fu = JSON.parse(t.followups || "[]");
  if (fu.length) {
    console.log();
    section("followups");
    for (const f of fu) kv(cyn(String(f.task_id).slice(0, 8)), trunc(String(f.prompt).replace(/\s+/g, " "), 70));
  }
}

function cmdEvents() {
  const d = db();
  const n = Number(flag("-n", "25"));
  const prefix = argv.filter((a, i) => i > 0 && !a.startsWith("-") && argv[i - 1] !== "-n")[0];
  const rows = d.query<any, []>(
    `SELECT ts, event_type, task_id, caller FROM mcp_events
     ${prefix ? `WHERE task_id LIKE '${prefix.replace(/'/g, "")}%'` : ""}
     ORDER BY ts DESC LIMIT ${n}`).all();
  if (wantJson) return console.log(JSON.stringify(rows, null, 1));
  banner("events");
  table(
    [{ h: "when", right: true }, { h: "event" }, { h: "task" }, { h: "caller", flex: true }],
    rows.map((e) => [
      relTime(e.ts),
      e.event_type === "submit" ? cyn(e.event_type)
        : ["completed", "result"].includes(e.event_type) ? grn(e.event_type)
        : ["failed", "cancelled", "error"].includes(e.event_type) ? red(e.event_type)
        : e.event_type,
      e.task_id ? cyn(String(e.task_id).slice(0, 8)) : dim("-"),
      e.caller || dim("-"),
    ]),
  );
}

function cmdCosts() {
  const d = db();
  const n = Number(flag("-n", "15"));
  let rows: any[] = [];
  try {
    rows = d.query<any, []>(
      `SELECT c.*, t.caller FROM task_costs c LEFT JOIN tasks t ON t.task_id=c.task_id
       ORDER BY c.id DESC LIMIT ${n}`).all();
  } catch { /* table may not exist on older bridges */ }
  if (wantJson) return console.log(JSON.stringify(rows, null, 1));
  banner("costs");
  if (!rows.length) return console.log(dim("  no cost snapshots recorded"));
  table(
    [{ h: "task" }, { h: "caller", flex: true }, { h: "model" }, { h: "in", right: true }, { h: "out", right: true }, { h: "est cost", right: true }],
    rows.map((r) => [
      cyn(String(r.task_id).slice(0, 8)), r.caller || dim("-"), r.model ?? dim("-"),
      num(r.prompt_tokens), num(r.completion_tokens), cost(r),
    ]),
  );
  console.log(`\n  ${dim("$0 outside a subscription is")} ${bold("unknown")}${dim(", never free.")}`);
}

async function cmdWatch() {
  const d = db();
  const prefix = argv[1];
  const t = prefix ? resolveTask(d, prefix) : null;
  banner(t ? `watch ${t.task_id}` : "watch (all bridge events)");
  let last = (d.query<any, []>(`SELECT COALESCE(MAX(id),0) m FROM mcp_events`).get()?.m ?? 0) as number;
  console.log(dim("  polling every 5s — Ctrl-C to stop\n"));
  // ponytail: 5s poll by rowid; the bridge has no pubsub to subscribe to.
  while (true) {
    const rows = d.query<any, [number]>(
      `SELECT id, ts, event_type, task_id FROM mcp_events WHERE id > ?1
       ${t ? `AND task_id='${t.task_id}'` : ""} ORDER BY id`).all(last);
    for (const e of rows) {
      console.log(`  ${dim(localTime(e.ts))}  ${pad(e.event_type, 10)}  ${cyn(String(e.task_id ?? "-").slice(0, 8))}`);
      last = e.id;
    }
    if (t) {
      const st = d.query<any, [string]>(`SELECT status, result, error FROM tasks WHERE task_id=?1`).get(t.task_id);
      if (["completed", "failed", "cancelled"].includes(st?.status)) {
        console.log();
        section(`terminal: ${statusColor(st.status)}`);
        console.log(((st.result ?? st.error ?? "").slice(0, 2000)).split("\n").map((l: string) => `  ${l}`).join("\n"));
        return;
      }
    }
    await Bun.sleep(5000);
  }
}

async function cmdTranscript() {
  const d = db();
  const t = resolveTask(d, argv[1] ?? die("usage: hst transcript <id-prefix>"));
  if (!t.session_id) die(`task ${t.task_id} has no session_id (never started?)`);
  await Bun.$`mkdir -p ${TRANSCRIPT_DIR}`.quiet();
  const out = `${TRANSCRIPT_DIR}/hst-${t.task_id}.jsonl`;
  const args = t.profile ? ["-p", t.profile] : [];
  await Bun.$`hermes ${args} sessions export ${out} --session-id ${t.session_id}`.quiet();
  console.log(out);
}

async function cmdLogs() {
  const files = [`${LOG_DIR}/hermes-async-bridge.log`, `${LOG_DIR}/hermes-async-bridge.err.log`];
  if (argv.includes("-f")) {
    Bun.spawn(["tail", "-f", ...files], { stdout: "inherit", stderr: "inherit" });
    await new Promise(() => {});
  } else {
    await Bun.$`tail -n 40 ${files[0]} ${files[1]}`.nothrow();
  }
}

async function cmdHealth() {
  banner("health");
  const svc = await Bun.$`launchctl list`.text().catch(() => "");
  const line = svc.split("\n").find((l) => l.includes("hermes-async-bridge"));
  section("service");
  kv("launchd", line ? grn(line.trim()) : red("not loaded"));
  const lsof = await Bun.$`lsof -nP -iTCP:${PORT} -sTCP:LISTEN`.text().catch(() => "");
  const bound = lsof.trim().split("\n").slice(-1)[0] ?? "";
  kv("port", bound ? grn(bound.replace(/\s+/g, " ")) : red(`nothing on :${PORT}`));
  kv("db", DB_PATH.replace(HOME, "~"));
  console.log();
  const d = db();
  const counts = d.query<any, []>(`SELECT status, COUNT(*) n FROM tasks GROUP BY status ORDER BY n DESC`).all();
  const e24 = d.query<any, []>(`SELECT COUNT(*) n FROM mcp_events WHERE ts > unixepoch()-86400`).get();
  section("activity");
  for (const r of counts) kv(r.status, `${paintStatus(r.status).split(" ")[0]} ${bold(String(r.n))}`);
  kv("events 24h", bold(String(e24?.n ?? 0)));
}

function die(msg: string): never {
  console.error(red(`hst: ${msg}`));
  process.exit(1);
}

function usage() {
  console.log(`
${inv(" HERMES SATELLITE ")} ${dim("·")} ${bold("hst")} ${dim("— bridge observability")}

${bold("Usage:")} hst <command> [args] [--json]

  ${bold("tasks")} ${dim("[-n N] [-s STATUS]")}    recent tasks + status tally
  ${bold("task")} ${dim("<id-prefix>")}            one task in full: summary, runs, cost, timeline, result
  ${bold("watch")} ${dim("[id-prefix]")}           stream events; with an id, exits on terminal status
  ${bold("events")} ${dim("[-n N] [id-prefix]")}   bridge MCP event log
  ${bold("costs")} ${dim("[-n N]")}                cost snapshots per task
  ${bold("transcript")} ${dim("<id-prefix>")}      export session transcript (JSONL), print path
  ${bold("logs")} ${dim("[-f]")}                   bridge process logs
  ${bold("health")}                     service, port, activity

${dim("Read-only. DB: $HERMES_ASYNC_BRIDGE_DB or ~/.hermes/async_bridge.db.")}
${dim("--json on tasks/task/events/costs for scripting. NO_COLOR disables color.")}
`);
}

switch (cmd) {
  case "tasks": cmdTasks(); break;
  case "task": cmdTask(); break;
  case "events": cmdEvents(); break;
  case "costs": cmdCosts(); break;
  case "watch": await cmdWatch(); break;
  case "transcript": await cmdTranscript(); break;
  case "logs": await cmdLogs(); break;
  case "health": await cmdHealth(); break;
  case "": case "-h": case "--help": usage(); break;
  default: die(`unknown command: ${cmd} (try --help)`);
}
