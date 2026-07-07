import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Fixture = {
  dir: string;
  dbPath: string;
};

const fixtures: Fixture[] = [];

function createFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "hst-test-"));
  const dbPath = join(dir, "async_bridge.db");
  const db = new Database(dbPath);
  const now = Date.now() / 1000;

  db.exec(`
    CREATE TABLE tasks (
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

    CREATE TABLE task_costs (
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
  `);

  const insertTask = db.query(`
    INSERT INTO tasks
    (task_id, session_id, profile, status, prompt, caller, created_at, started_at, completed_at, followups)
    VALUES (?1, ?2, 'builder', 'completed', ?3, 'fixture', ?4, ?4, ?4, '[]')
  `);
  insertTask.run("task-subscription-clean", "session-subscription-clean", "clean subscription cost", now - 30);
  insertTask.run("task-moa-unreconciled", "session-moa-unreconciled", "moa unreconciled cost", now - 20);
  insertTask.run("task-real-cost", "session-real-cost", "real metered cost", now - 10);

  const insertCost = db.query(`
    INSERT INTO task_costs
    (task_id, session_id, loop_index, provider, model, prompt_tokens, completion_tokens,
     cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens, estimated_usd,
     cost_source, billing_provider, billing_mode, pricing_version, cost_unreconciled,
     expensive_tools_used, captured_at, snapshot_json)
    VALUES (?1, ?2, 0, ?3, ?4, 10, 5, 0, 0, 0, 15, ?5, ?6, ?7, ?8, 'fixture', ?9, '[]', ?10, '{}')
  `);
  insertCost.run(
    "task-subscription-clean",
    "session-subscription-clean",
    "subscription",
    "subscription-model",
    0,
    "subscription",
    "subscription",
    "subscription_included",
    0,
    now,
  );
  insertCost.run(
    "task-moa-unreconciled",
    "session-moa-unreconciled",
    "moa",
    "moa-model",
    0,
    "none",
    "moa",
    "subscription_included",
    1,
    now,
  );
  insertCost.run(
    "task-real-cost",
    "session-real-cost",
    "metered",
    "metered-model",
    0.0123,
    "pricing-table",
    "api",
    "metered",
    0,
    now,
  );

  db.close();
  fixtures.push({ dir, dbPath });
  return { dir, dbPath };
}

function runHst(args: string[], dbPath: string): string {
  const result = Bun.spawnSync(["bun", "scripts/hst.ts", ...args], {
    env: {
      ...process.env,
      HERMES_ASYNC_BRIDGE_DB: dbPath,
      NO_COLOR: "1",
      HST_NO_GIST: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  expect(result.exitCode, stderr).toBe(0);
  return stdout;
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("costs renders subscription, unreconciled, and real cost rows distinctly", () => {
  const fixture = createFixture();
  const stdout = runHst(["costs"], fixture.dbPath);
  const lines = stdout.split(/\r?\n/);
  const rowFor = (taskId: string) => {
    const prefix = taskId.slice(0, 8);
    const row = lines.find((line) => line.includes(prefix));
    expect(row, `row for ${taskId}`).toBeDefined();
    return row!;
  };

  const moaRow = rowFor("task-moa-unreconciled");
  expect(moaRow).toContain("unreconciled");
  expect(moaRow).not.toContain("$0 (subscription)");
  expect(rowFor("task-subscription-clean")).toContain("$0 (subscription)");
  expect(rowFor("task-real-cost")).toContain("$0.0123");
});

test("tasks --json emits parseable rows with task ids", () => {
  const fixture = createFixture();
  const stdout = runHst(["tasks", "--json"], fixture.dbPath);
  const rows = JSON.parse(stdout);
  const ids = rows.map((row: { task_id: string }) => row.task_id);

  expect(ids).toContain("task-subscription-clean");
  expect(ids).toContain("task-moa-unreconciled");
  expect(ids).toContain("task-real-cost");
});
