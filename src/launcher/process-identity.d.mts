export interface ProcessIdentity {
  pid: number;
  startTime: string;
}

export function readProcessStartTime(pid: number): Promise<string | undefined>;
export function captureProcessIdentity(pid: number): Promise<ProcessIdentity | undefined>;
export function isProcessIdentityAlive(identity: ProcessIdentity | undefined): Promise<boolean>;
export function signalProcessIdentity(identity: ProcessIdentity | undefined, signal?: NodeJS.Signals): Promise<boolean>;
