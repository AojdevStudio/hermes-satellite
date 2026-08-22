/**
 * Socket-path resolution for the Pi Verifier Agent.
 *
 * Layout:
 *   actual socket : /tmp/pi-verifier/<sessionId>.sock
 *   breadcrumb    : <cwd>/.pi/state/verifier-<sessionId>.sock.ref   (plain text → socket path)
 *
 * Why `/tmp/pi-verifier/`:
 *   macOS limits `sun_path` (the Unix-domain-socket file path inside
 *   `struct sockaddr_un`) to 104 bytes. A path under the project root
 *   (e.g. `/Users/foo/Documents/projects/the-verifier-agent/.pi/state/verifier-<sid>.sock`)
 *   blows past 104 bytes for almost every realistic project location.
 *   `/tmp/pi-verifier/<sid>.sock` is short and predictable.
 *
 * The breadcrumb file in the project lets `ls .pi/state/` describe what
 * verifier sessions are running, and lets the verifier child resolve the
 * socket path by `--builder-session <sessionId>` alone.
 *
 * Permissions:
 *   `/tmp/pi-verifier` is created with mode 0700 — only the owning UID
 *   can connect to sockets inside it. That is our authentication.
 *
 * Cleanup:
 *   `cleanup()` swallows `ENOENT` so it's safe to call from
 *   `session_shutdown` regardless of whether the socket was ever bound
 *   or the breadcrumb ever written.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

const SOCKET_DIR = "/tmp/pi-verifier";
const SOCKET_DIR_MODE = 0o700;

/**
 * Headroom under macOS's 104-byte `sun_path` limit. We pick 100 to leave
 * a few bytes for safety (`sun_len`, terminator, future suffix).
 */
const SOCKET_PATH_MAX = 100;

export interface ResolvedSocketPaths {
  socketPath: string;
  refPath: string;
}

/**
 * Pure resolver — returns the canonical paths without touching disk.
 *
 * Throws if `socketPath` would exceed the macOS `sun_path` budget.
 * That's a programming error (caller passed an unexpectedly long
 * sessionId); the upstream callers should keep sessionIds short.
 */
export function resolveSocketPath(sessionId: string, cwd: string): ResolvedSocketPaths {
  if (!sessionId || /[/\0\s]/.test(sessionId)) {
    throw new Error(
      `resolveSocketPath: sessionId must be non-empty and contain no path separators, ` +
        `null bytes, or whitespace. Got: ${JSON.stringify(sessionId)}.`,
    );
  }
  const socketPath = path.join(SOCKET_DIR, `${sessionId}.sock`);
  if (socketPath.length > SOCKET_PATH_MAX) {
    throw new Error(
      `Resolved socket path is ${socketPath.length} bytes, which exceeds the safe ` +
        `${SOCKET_PATH_MAX}-byte budget under macOS's 104-byte sun_path limit. ` +
        `sessionId="${sessionId}" yielded path="${socketPath}". Use a shorter sessionId.`,
    );
  }
  const refPath = path.join(cwd, ".pi", "state", `verifier-${sessionId}.sock.ref`);
  return { socketPath, refPath };
}

/**
 * Ensure `/tmp/pi-verifier` exists and is mode 0700.
 *
 * Idempotent — safe to call on every session_start. The chmod is
 * unconditional so a stale dir created with looser perms by an older
 * version is tightened on the next run.
 */
export async function ensureSocketDir(): Promise<void> {
  await fs.mkdir(SOCKET_DIR, { recursive: true });
  await fs.chmod(SOCKET_DIR, SOCKET_DIR_MODE);
}

/**
 * Write the breadcrumb file pointing at the actual socket.
 *
 * Creates the `.pi/state/` parent dir if needed (so callers don't need
 * a separate ensureProjectState step). Content is the plain socket path
 * with a trailing newline so `cat` output is human-friendly.
 */
export async function writeSocketRef(socketPath: string, refPath: string): Promise<void> {
  await fs.mkdir(path.dirname(refPath), { recursive: true });
  await fs.writeFile(refPath, `${socketPath}\n`, { encoding: "utf8", mode: 0o644 });
}

/**
 * Read the breadcrumb file and return the resolved socket path.
 *
 * Trims trailing whitespace (the newline we wrote, plus any operator
 * edits). Throws with a clear ENOENT message so the verifier child can
 * surface "no breadcrumb at <path> — is the builder running?" cleanly.
 */
export async function readSocketRef(refPath: string): Promise<string> {
  let raw: string;
  try {
    raw = await fs.readFile(refPath, "utf8");
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      throw new Error(
        `No verifier socket breadcrumb at "${refPath}". The builder is either not ` +
          `running or hasn't bound its socket yet.`,
      );
    }
    throw cause;
  }
  const socketPath = raw.trim();
  if (!socketPath) {
    throw new Error(`Verifier socket breadcrumb at "${refPath}" is empty.`);
  }
  return socketPath;
}

/**
 * Best-effort cleanup of both the socket and the breadcrumb.
 *
 * Swallows ENOENT. Other errors are re-thrown so genuine permission /
 * I/O problems still surface during session_shutdown.
 */
export async function cleanup(socketPath: string, refPath: string): Promise<void> {
  await Promise.all([safeUnlink(socketPath), safeUnlink(refPath)]);
}

async function safeUnlink(p: string): Promise<void> {
  try {
    await fs.unlink(p);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return;
    throw cause;
  }
}
