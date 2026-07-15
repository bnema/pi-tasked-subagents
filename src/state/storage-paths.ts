import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { sha256Hex } from "./canonical-json.js";

const APP_DIRECTORY = "pi-tasked-subagents";
const SAFE_PATH_ID = /^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const RESULT_ID = /^(?:[a-f0-9]{32}|[a-f0-9]{64})$/;
const DIGEST_ID = /^[a-f0-9]{64}$/;

export interface StoragePathsOptions {
  /** An application-root override, used by tests and embedders. */
  dataRoot?: string;
}

export interface SessionStoragePaths {
  root: string;
  objectsDir: string;
  sessionsDir: string;
  sessionDir: string;
  refsPath: string;
  assignmentsDir: string;
  runsDir: string;
  resultsDir: string;
  quarantineDir: string;
}

function unsafeId(label: string): never {
  throw new Error(`Unsafe ${label}`);
}

function assertId(value: string, expression: RegExp, label: string): void {
  if (!expression.test(value)) unsafeId(label);
}

function assertContained(root: string, candidate: string): void {
  const difference = relative(root, candidate);
  if (difference === "" || difference === ".." || difference.startsWith(`..${sep}`) || difference.startsWith("/")) {
    throw new Error("Resolved storage path escapes its configured root");
  }
}

/** Refuse existing symlink components so a lexical-safe path cannot escape at I/O time. */
function assertNoSymlinkComponents(root: string, candidate: string): void {
  let current = root;
  const components = relative(root, candidate).split(sep).filter(Boolean);
  for (const component of ["", ...components]) {
    if (component) current = join(current, component);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error("Storage path contains a symlink");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function containedPath(root: string, ...components: string[]): string {
  const candidate = resolve(root, ...components);
  assertContained(root, candidate);
  assertNoSymlinkComponents(root, candidate);
  return candidate;
}

/** Resolve the private application-data root without creating it. */
export function resolveStorageRoot(options: StoragePathsOptions = {}): string {
  if (options.dataRoot !== undefined) return resolve(options.dataRoot);
  const xdgDataHome = process.env.XDG_DATA_HOME;
  const userDataRoot = xdgDataHome && isAbsolute(xdgDataHome)
    ? xdgDataHome
    : join(process.env.HOME || homedir(), ".local", "share");
  return resolve(userDataRoot, APP_DIRECTORY);
}

/** Return only contained paths for a validated Pi session ID. */
export function sessionStoragePaths(root: string, sessionId: string): SessionStoragePaths {
  assertId(sessionId, SAFE_PATH_ID, "session ID");
  const resolvedRoot = resolve(root);
  const sessionsDir = containedPath(resolvedRoot, "sessions");
  const sessionDir = containedPath(resolvedRoot, "sessions", sessionId);
  return {
    root: resolvedRoot,
    objectsDir: containedPath(resolvedRoot, "objects"),
    sessionsDir,
    sessionDir,
    refsPath: containedPath(resolvedRoot, "sessions", sessionId, "refs.json"),
    assignmentsDir: containedPath(resolvedRoot, "assignments", sessionId),
    runsDir: containedPath(resolvedRoot, "runs", sessionId),
    resultsDir: containedPath(resolvedRoot, "results", sessionId),
    quarantineDir: containedPath(resolvedRoot, "quarantine"),
  };
}

export function resultFilePath(paths: SessionStoragePaths, resultId: string): string {
  assertId(resultId, RESULT_ID, "result ID");
  return containedPath(paths.root, "results", sessionIdFromPaths(paths), `${resultId}.json`);
}

export function resultReservationPath(paths: SessionStoragePaths, resultId: string): string {
  return `${resultFilePath(paths, resultId)}.reservation`;
}

/** Assignment IDs are deliberately hashed before becoming path components. */
export function assignmentArchiveDir(paths: SessionStoragePaths, assignmentId: string): string {
  if (!assignmentId) unsafeId("assignment ID");
  return containedPath(paths.root, "assignments", sessionIdFromPaths(paths), sha256Hex(assignmentId));
}

export function assignmentArchiveLinkPath(paths: SessionStoragePaths, assignmentId: string, archiveId: string): string {
  assertId(archiveId, DIGEST_ID, "archive ID");
  return containedPath(paths.root, "assignments", sessionIdFromPaths(paths), sha256Hex(assignmentId), `${archiveId}.json`);
}

function sessionIdFromPaths(paths: SessionStoragePaths): string {
  const sessionId = relative(paths.sessionsDir, paths.sessionDir);
  assertId(sessionId, SAFE_PATH_ID, "session ID");
  return sessionId;
}
