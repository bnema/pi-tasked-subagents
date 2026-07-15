import fs from "node:fs/promises";

// Node 22-25 exposes no stable in-process pidfd_open/pidfd_send_signal API.
// This package deliberately has no native addon, shell, or Python fallback, so
// procfs start-time comparison remains the strongest supported termination guard.

function validPid(pid) {
  return Number.isSafeInteger(pid) && pid > 0;
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
