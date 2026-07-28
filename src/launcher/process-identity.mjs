import fs from "node:fs/promises";

// Node 22-25 exposes no stable in-process pidfd_open/pidfd_send_signal API.
// This package deliberately has no native addon, shell, or Python fallback, so
// procfs start-time comparison remains the strongest supported termination guard.

const DEFAULT_GRACE_MS = 5_000;
const DEFAULT_POLL_MS = 50;
const DEFAULT_FORCE_WAIT_MS = 5_000;

function validPid(pid) {
  return Number.isSafeInteger(pid) && pid > 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Read Linux /proc/<pid>/stat field 22 without trusting PID reuse-prone kill(0). */
export async function readProcessStartTime(pid) {
  if (!validPid(pid)) return undefined;
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    // comm (field 2) may contain spaces or parentheses, so parse after its last ).
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) return undefined;
    const fields = stat.slice(closeParen + 1).trim().split(/\s+/u);
    const startTime = fields[19]; // field 22; fields here start at field 3.
    return /^\d+$/u.test(startTime) ? startTime : undefined;
  } catch {
    return undefined;
  }
}

export async function captureProcessIdentity(pid) {
  const startTime = await readProcessStartTime(pid);
  return startTime === undefined ? undefined : { pid, startTime };
}

export async function isProcessIdentityAlive(identity) {
  return Boolean(identity
    && validPid(identity.pid)
    && typeof identity.startTime === "string"
    && identity.startTime.length > 0
    && await readProcessStartTime(identity.pid) === identity.startTime);
}

/** Signal only after a fresh start-time comparison immediately before kill. */
export async function signalProcessIdentity(identity, signal = "SIGTERM") {
  if (!await isProcessIdentityAlive(identity)) return false;
  try {
    process.kill(identity.pid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * Terminate one verified identity: SIGTERM, optional grace, then SIGKILL.
 * Re-checks /proc/<pid>/stat before every signal and while waiting.
 */
export async function terminateProcessIdentity(identity, options = {}) {
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const forceWaitMs = options.forceWaitMs ?? DEFAULT_FORCE_WAIT_MS;
  const signal = options.signal ?? "SIGTERM";
  const forceSignal = options.forceSignal ?? "SIGKILL";

  if (!await isProcessIdentityAlive(identity)) return "stale";
  if (!await signalProcessIdentity(identity, signal)) return "stale";

  const graceDeadline = Date.now() + graceMs;
  while (Date.now() < graceDeadline) {
    if (!await isProcessIdentityAlive(identity)) return "exited";
    await sleep(pollMs);
  }

  if (!await isProcessIdentityAlive(identity)) return "exited";
  if (!await signalProcessIdentity(identity, forceSignal)) return "stale";

  const forceDeadline = Date.now() + forceWaitMs;
  while (Date.now() < forceDeadline) {
    if (!await isProcessIdentityAlive(identity)) return "forced";
    await sleep(pollMs);
  }

  return await isProcessIdentityAlive(identity) ? "timeout" : "forced";
}
