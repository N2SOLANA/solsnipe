// Recorder lifecycle: start (detached) / stop / status.
// PID safety (audit C2/M1): atomic O_EXCL pidfile with nonce, strict parse,
// liveness+identity check before any signal, unlink only the PID we own.
// All paths repo-root-anchored (import.meta), never cwd-relative.
import { spawn, execSync } from "node:child_process";
import {
  existsSync, readFileSync, rmSync, writeFileSync, openSync, closeSync,
  lstatSync, mkdirSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const PID_FILE = resolve(ROOT, "logs/recorder.pid");
const LOG_FILE = resolve(ROOT, "logs/recorder.log");
const ENTRY = resolve(ROOT, "dist/recorder/main.js");

function assertNotSymlink(path) {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      console.error(`refusing: ${path} is a symlink`);
      process.exit(1);
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

function readPidFile() {
  let raw;
  try {
    raw = readFileSync(PID_FILE, "utf8").trim();
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  const match = raw.match(/^(\d+)\n([0-9a-f]{16})\n(\d+)$/);
  if (!match) {
    console.error(`pid file malformed (expected pid\\nnonce\\nstartedAt)`);
    process.exit(1);
  }
  const pid = Number(match[1]);
  if (!Number.isInteger(pid) || pid <= 1 || pid >= 2 ** 31) {
    console.error(`pid file has invalid pid: ${match[1]}`);
    process.exit(1);
  }
  return { pid, nonce: match[2], startedAt: Number(match[3]) };
}

function isOurRecorder(pid, nonce) {
  // Liveness first: ESRCH = stale. Then identity: cmdline must reference
  // the recorder entry. EPERM = exists but un-signalable → treat as running.
  try {
    process.kill(pid, 0);
  } catch (err) {
    return err.code === "EPERM" ? "unknown-alive" : "dead";
  }
  if (process.platform !== "linux" && process.platform !== "darwin") return "unknown-alive";
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
    if (cmdline.includes("recorder/main")) return "alive";
    // macOS has no /proc: fall back to ps.
    if (process.platform === "darwin") throw { code: "NOPROC" };
    return "other";
  } catch {
    if (process.platform === "darwin") {
      try {
        const out = execSync(`ps -o command= -p ${pid}`, { encoding: "utf8", timeout: 5000 });
        if (out.includes("recorder/main")) return "alive";
        return "other";
      } catch {
        return "unknown-alive";
      }
    }
    return "unknown-alive";
  }
}

const CMD = process.argv[2];

if (CMD === "start") {
  mkdirSync(dirname(PID_FILE), { recursive: true });
  assertNotSymlink(PID_FILE);
  assertNotSymlink(LOG_FILE);
  const existing = readPidFile();
  if (existing !== null) {
    const state = isOurRecorder(existing.pid, existing.nonce);
    if (state === "alive" || state === "unknown-alive") {
      console.error(`recorder already running (pid ${existing.pid}) — refusing to start a second`);
      process.exit(1);
    }
    console.error(`stale pid file (pid ${existing.pid} ${state}) — removing and starting`);
    rmSync(PID_FILE);
  }
  if (!existsSync(ENTRY)) {
    console.error(`recorder not built (${ENTRY} missing) — run npm run build first`);
    process.exit(1);
  }
  const nonce = (Math.random().toString(16) + Date.now().toString(16)).replace(/[^0-9a-f]/g, "").slice(0, 16).padEnd(16, "0");
  // Atomic claim: O_EXCL fails if a rival start won the race.
  let fd;
  try {
    fd = openSync(PID_FILE, "wx", 0o600);
  } catch (err) {
    console.error(`pid file race lost (${PID_FILE} appeared) — refusing second recorder`);
    process.exit(1);
  }
  const logFd = openSync(LOG_FILE, "a", 0o600);
  // Minimal explicit env: the recorder reads SOLSNIPE_* overrides + PATH.
  // (Full process.env spread is banned by lint — no secret exfil surface.)
  const childEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("SOLSNIPE_") && v !== undefined) childEnv[k] = v;
  }
  const child = spawn(process.execPath, [ENTRY], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    shell: false,
    cwd: ROOT,
    env: childEnv,
  });
  closeSync(logFd);
  const startedAt = Date.now();
  writeFileSync(fd, `${child.pid}\n${nonce}\n${startedAt}\n`);
  closeSync(fd);
  child.unref();
  console.log(`recorder started (pid ${child.pid}, log ${LOG_FILE})`);
} else if (CMD === "stop") {
  const existing = readPidFile();
  if (existing === null) {
    console.log("recorder not running (no pid file)");
    process.exit(0);
  }
  const state = isOurRecorder(existing.pid, existing.nonce);
  if (state === "dead" || state === "other") {
    console.error(`pid ${existing.pid} is ${state} — removing stale pid file, no signal sent`);
    const current = readPidFile();
    if (current !== null && current.pid === existing.pid && current.nonce === existing.nonce) {
      rmSync(PID_FILE);
    }
    process.exit(state === "other" ? 1 : 0);
  }
  // "alive" or "unknown-alive": signal, then unlink only what we own.
  process.kill(existing.pid, "SIGTERM");
  console.log(`SIGTERM sent to recorder (pid ${existing.pid})`);
  const deadline = Date.now() + 15_000;
  const poll = setInterval(() => {
    let gone = false;
    try {
      process.kill(existing.pid, 0);
    } catch {
      gone = true;
    }
    if (gone || Date.now() > deadline) {
      clearInterval(poll);
      const current = readPidFile();
      if (current !== null && current.pid === existing.pid && current.nonce === existing.nonce) {
        rmSync(PID_FILE);
      }
      console.log(gone ? "recorder stopped" : "recorder did not exit in 15s (pid file kept for inspection)");
      process.exit(0);
    }
  }, 500);
} else if (CMD === "status") {
  const existing = readPidFile();
  if (existing === null) {
    console.log(JSON.stringify({ running: false }));
    process.exit(0);
  }
  const state = isOurRecorder(existing.pid, existing.nonce);
  console.log(JSON.stringify({ running: state === "alive" || state === "unknown-alive", pid: existing.pid, state, startedAt: existing.startedAt, log: LOG_FILE }));
} else {
  console.error("usage: recorder-lifecycle.mjs start|stop|status");
  process.exit(1);
}
