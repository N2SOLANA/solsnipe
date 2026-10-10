// Recorder lifecycle stubs (M2 implements the real recorder).
// Detached-process management with PID files under ./logs/.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const CMD = process.argv[2];
const PID_FILE = new URL("../logs/recorder.pid", import.meta.url);
const LOG_FILE = new URL("../logs/recorder.log", import.meta.url);

if (CMD === "start") {
  if (existsSync(PID_FILE)) {
    console.error("recorder already running (logs/recorder.pid exists)");
    process.exit(1);
  }
  console.error("recorder not yet implemented (M2) — refusing to fake it");
  process.exit(1);
} else if (CMD === "stop") {
  if (!existsSync(PID_FILE)) {
    console.log("recorder not running (no pid file)");
    process.exit(0);
  }
  const pid = Number(readFileSync(PID_FILE, "utf8"));
  try {
    process.kill(pid);
  } catch {
    // already dead
  }
  rmSync(PID_FILE);
  console.log("recorder stopped");
} else {
  console.error("usage: recorder-start|stop");
  process.exit(1);
}
