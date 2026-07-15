import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const MAX_RESERVATION_BYTES = 4 * 1024;

function hasExpectedIdentity(value, expected) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && value.sessionId === expected.sessionId
    && value.runId === expected.runId
    && value.resultId === expected.resultId;
}

function sameReservationIdentity(value, expected) {
  return hasExpectedIdentity(value, expected) && Object.keys(value).length === 3;
}

function reservationError() {
  return new Error("Result reservation is missing, malformed, or owned by a different run");
}

/**
 * Verify the reservation that the adapter created before the runner started.
 * This deliberately has no creation path: a runner is never allowed to claim
 * a result identity after launch.
 *
 * @param {string} reservationPath
 * @param {{ sessionId: string, runId: string, resultId: string }} expected
 */
export async function verifyResultReservation(reservationPath, expected) {
  let content;
  try {
    const info = await fs.lstat(reservationPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_RESERVATION_BYTES) throw reservationError();
    content = await fs.readFile(reservationPath, "utf8");
  } catch (error) {
    if (error?.message === reservationError().message) throw error;
    throw reservationError();
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw reservationError();
  }
  if (!sameReservationIdentity(parsed, expected)) throw reservationError();
  return parsed;
}

/** @param {string} resultPath @param {{ sessionId: string, runId: string, resultId: string }} expected */
async function readPublishedWinner(resultPath, expected) {
  let parsed;
  try {
    const info = await fs.lstat(resultPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("not a regular file");
    parsed = JSON.parse(await fs.readFile(resultPath, "utf8"));
  } catch {
    throw new Error("Existing terminal result is invalid and cannot be replaced");
  }
  if (!hasExpectedIdentity(parsed, expected)) {
    throw new Error("Existing terminal result belongs to a different result identity");
  }
  return parsed;
}

/**
 * Remove a reservation only if it remains owned by this result identity.
 * A mismatched or malformed reservation is deliberately retained for its
 * owner rather than being treated as cleanup debris.
 */
async function removeMatchingReservation(reservationPath, expected) {
  try {
    await verifyResultReservation(reservationPath, expected);
  } catch {
    return;
  }
  await fs.unlink(reservationPath).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}

/**
 * Atomically install one immutable terminal result. A hard link is the
 * no-replace gate: only its winner can publish; all later valid publishers
 * return the already-published winner unchanged.
 *
 * @param {string} resultPath
 * @param {string} reservationPath
 * @param {{ sessionId: string, runId: string, resultId: string }} expected
 * @param {Record<string, unknown>} value
 */
export async function publishTerminalResult(resultPath, reservationPath, expected, value) {
  try {
    await verifyResultReservation(reservationPath, expected);
  } catch (reservationError) {
    // A prior valid terminal publisher removes its reservation as cleanup.
    // That winner is still authoritative; never recreate a reservation here.
    try {
      return { published: false, value: await readPublishedWinner(resultPath, expected) };
    } catch {
      throw reservationError;
    }
  }
  await fs.mkdir(path.dirname(resultPath), { recursive: true });

  const terminalValue = { ...value, sessionId: expected.sessionId, runId: expected.runId, resultId: expected.resultId };
  const temporaryPath = path.join(
    path.dirname(resultPath),
    `.${path.basename(resultPath)}.tmp-${process.pid}-${randomBytes(12).toString("hex")}`,
  );
  let temporaryCreated = false;
  try {
    const temporary = await fs.open(temporaryPath, "wx", 0o600);
    temporaryCreated = true;
    try {
      await temporary.writeFile(JSON.stringify(terminalValue), "utf8");
      await temporary.sync();
    } finally {
      await temporary.close();
    }

    // Check ownership again immediately before the no-replace gate so a
    // replaced reservation cannot authorize a stale terminal publisher.
    try {
      await verifyResultReservation(reservationPath, expected);
    } catch (reservationError) {
      try {
        return { published: false, value: await readPublishedWinner(resultPath, expected) };
      } catch {
        throw reservationError;
      }
    }

    try {
      await fs.link(temporaryPath, resultPath);
      const published = await readPublishedWinner(resultPath, expected);
      await removeMatchingReservation(reservationPath, expected);
      return { published: true, value: published };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const published = await readPublishedWinner(resultPath, expected);
      await removeMatchingReservation(reservationPath, expected);
      return { published: false, value: published };
    }
  } finally {
    if (temporaryCreated) await fs.unlink(temporaryPath).catch(() => undefined);
  }
}
