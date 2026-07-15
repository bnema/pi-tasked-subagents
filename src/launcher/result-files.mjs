import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import path from "node:path";

import { openPinnedDirectory, safeBasename } from "../state/pinned-directory.mjs";

const MAX_RESERVATION_BYTES = 4 * 1024;
// Kept byte-for-byte aligned with state/storage-paths.ts's canonical SAFE_PATH_ID:
// this runner dependency must remain directly executable by Node (not a TS loader).
const CANONICAL_SESSION_ID = /^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const CANONICAL_RESULT_ID = /^(?:[a-f0-9]{32}|[a-f0-9]{64})$/;

function isCanonicalSessionId(value) {
  return typeof value === "string" && CANONICAL_SESSION_ID.test(value);
}

function isCanonicalResultId(value) {
  return typeof value === "string" && CANONICAL_RESULT_ID.test(value);
}

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

function resultNames(expected) {
  if (!expected || !isCanonicalSessionId(expected.sessionId) || !isCanonicalResultId(expected.resultId) ||
    typeof expected.runId !== "string" || !expected.runId.trim()) {
    throw new Error("Unsafe durable result identity");
  }
  return {
    result: safeBasename(`${expected.resultId}.json`),
    reservation: safeBasename(`${expected.resultId}.json.reservation`),
  };
}

/** Validate both supplied spellings against the durable root layout. */
function resultLocation(resultPath, reservationPath, expected, root) {
  const names = resultNames(expected);
  const directory = path.dirname(resultPath);
  const inferredRoot = root ?? path.dirname(path.dirname(directory));
  const expectedDirectory = path.join(inferredRoot, "results", expected.sessionId);
  if (path.resolve(directory) !== path.resolve(expectedDirectory) || path.basename(resultPath) !== names.result ||
    path.resolve(reservationPath) !== path.resolve(path.join(expectedDirectory, names.reservation))) {
    throw new Error("Result path does not match its durable identity");
  }
  return { root: path.resolve(inferredRoot), directory: path.resolve(expectedDirectory), ...names };
}

async function readJsonRegular(directory, name, maxBytes = Number.MAX_SAFE_INTEGER) {
  let handle;
  try {
    handle = await directory.openFile(name, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("not a regular bounded file");
    const content = await handle.readFile("utf8");
    const after = await handle.stat();
    if (!after.isFile() || after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size) throw new Error("file identity changed");
    return JSON.parse(content);
  } finally {
    await handle?.close();
  }
}

async function verifyPinnedReservation(directory, name, expected) {
  try {
    const parsed = await readJsonRegular(directory, name, MAX_RESERVATION_BYTES);
    if (!sameReservationIdentity(parsed, expected)) throw reservationError();
    return parsed;
  } catch (error) {
    if (error?.message === reservationError().message) throw error;
    throw reservationError();
  }
}

/**
 * Verify the adapter-owned reservation through a pinned directory capability.
 * No fallback path can create or read a reservation outside durable storage.
 */
export async function verifyResultReservation(reservationPath, expected, options = {}) {
  const resultPath = options.resultPath ?? reservationPath.replace(/\.reservation$/u, "");
  const location = resultLocation(resultPath, reservationPath, expected, options.root);
  const directory = await openPinnedDirectory(location.root, location.directory, options);
  try {
    return await verifyPinnedReservation(directory, location.reservation, expected);
  } finally {
    await directory.close();
  }
}

async function readPublishedWinner(directory, resultName, expected) {
  let parsed;
  try {
    parsed = await readJsonRegular(directory, resultName);
  } catch {
    throw new Error("Existing terminal result is invalid and cannot be replaced");
  }
  if (!hasExpectedIdentity(parsed, expected)) {
    throw new Error("Existing terminal result belongs to a different result identity");
  }
  return parsed;
}

async function removeMatchingReservation(directory, reservationName, expected) {
  try {
    await verifyPinnedReservation(directory, reservationName, expected);
  } catch {
    return false;
  }
  try {
    await directory.unlink(reservationName);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  await directory.sync();
  return true;
}

/** Create one reservation through the same pinned durable-storage boundary. */
export async function reserveResultReservation(root, resultsDir, expected, options = {}) {
  const resultPath = path.join(resultsDir, `${expected.resultId}.json`);
  const reservationPath = `${resultPath}.reservation`;
  const location = resultLocation(resultPath, reservationPath, expected, root);
  if (path.resolve(resultsDir) !== location.directory) throw new Error("Result directory does not match durable identity");
  const directory = await openPinnedDirectory(location.root, location.directory, options);
  let handle;
  let retained = false;
  try {
    await options.beforeMutation?.("reserve-result");
    handle = await directory.openFile(location.reservation, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(JSON.stringify(expected), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await directory.sync();
    // A reservation never grants an identity that already has a terminal file.
    try {
      const existing = await directory.openFile(location.result, constants.O_RDONLY | constants.O_NOFOLLOW);
      await existing.close();
      await directory.unlink(location.reservation);
      await directory.sync();
      const collision = new Error("Result identity is already published");
      collision.code = "EEXIST";
      throw collision;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await directory.assert();
    if (options.retainDirectory) {
      retained = true;
      return {
        resultPath,
        resultReservationPath: reservationPath,
        close: () => directory.close(),
        release: async () => {
          try {
            await removeMatchingReservation(directory, location.reservation, expected);
          } finally {
            await directory.close();
          }
        },
      };
    }
    return { resultPath, resultReservationPath: reservationPath };
  } finally {
    await handle?.close();
    if (!retained) await directory.close();
  }
}

/** Remove only a reservation still owned by this durable identity. */
export async function releaseResultReservation(root, resultsDir, expected, options = {}) {
  const resultPath = path.join(resultsDir, `${expected.resultId}.json`);
  const reservationPath = `${resultPath}.reservation`;
  const location = resultLocation(resultPath, reservationPath, expected, root);
  const directory = await openPinnedDirectory(location.root, location.directory, options);
  try {
    await removeMatchingReservation(directory, location.reservation, expected);
  } finally {
    await directory.close();
  }
}

/**
 * Atomically install one immutable terminal result. A hard link is the
 * no-replace winner gate and every mutation remains relative to a pinned fd.
 */
export async function publishTerminalResult(resultPath, reservationPath, expected, value, options = {}) {
  const location = resultLocation(resultPath, reservationPath, expected, options.root);
  const directory = await openPinnedDirectory(location.root, location.directory, options);
  try {
    try {
      await verifyPinnedReservation(directory, location.reservation, expected);
    } catch (error) {
      try {
        return { published: false, value: await readPublishedWinner(directory, location.result, expected) };
      } catch {
        throw error;
      }
    }

    const terminalValue = { ...value, sessionId: expected.sessionId, runId: expected.runId, resultId: expected.resultId };
    const temporaryName = safeBasename(`.${location.result}.tmp-${process.pid}-${randomBytes(12).toString("hex")}`);
    let temporaryCreated = false;
    try {
      const temporary = await directory.openFile(temporaryName, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      temporaryCreated = true;
      try {
        await temporary.writeFile(JSON.stringify(terminalValue), "utf8");
        await temporary.sync();
      } finally {
        await temporary.close();
      }
      await verifyPinnedReservation(directory, location.reservation, expected);
      await options.beforeMutation?.("publish-terminal-result");
      try {
        await directory.link(temporaryName, directory, location.result);
        const published = await readPublishedWinner(directory, location.result, expected);
        await removeMatchingReservation(directory, location.reservation, expected);
        await directory.sync();
        return { published: true, value: published };
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const published = await readPublishedWinner(directory, location.result, expected);
        await removeMatchingReservation(directory, location.reservation, expected);
        return { published: false, value: published };
      }
    } finally {
      if (temporaryCreated) await directory.unlink(temporaryName).catch(() => undefined);
    }
  } finally {
    await directory.close();
  }
}
