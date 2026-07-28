export interface ProcessIdentity {
  pid: number;
  startTime: string;
}

export type TerminateProcessOutcome = "exited" | "forced" | "stale" | "timeout";

export interface TerminateProcessOptions {
  graceMs?: number;
  pollMs?: number;
  forceWaitMs?: number;
  signal?: NodeJS.Signals;
  forceSignal?: NodeJS.Signals;
}

export function readProcessStartTime(pid: number): Promise<string | undefined>;
export function captureProcessIdentity(pid: number): Promise<ProcessIdentity | undefined>;
export function isProcessIdentityAlive(identity: ProcessIdentity | undefined): Promise<boolean>;
export function signalProcessIdentity(identity: ProcessIdentity | undefined, signal?: NodeJS.Signals): Promise<boolean>;
export function terminateProcessIdentity(identity: ProcessIdentity, options?: TerminateProcessOptions): Promise<TerminateProcessOutcome>;
