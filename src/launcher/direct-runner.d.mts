export function renderTaskGraphTemplate(template: string, results: Record<string, unknown>): string;
export function evaluateTaskGraphCondition(expression: unknown, results: Record<string, unknown>): boolean;
export function parseStructuredStepOutput(output: unknown, outputMode?: string): unknown;
export function getReadyTaskGraphStepIds(steps: Array<{ id?: string; status?: string; dependsOn?: string[] }>, maxConcurrency: number): string[];
export function applyPublishedTerminalResult(status: Record<string, unknown>, result: Record<string, unknown>, fallbackTimestamp?: number): Record<string, unknown>;
export function waitForChildExit(childProcess: { once(event: "error", listener: (error: Error) => void): unknown; once(event: "close", listener: (code: number | null) => void): unknown }): Promise<number>;
export function isTerminalTurnEnd(event: unknown): boolean;
export function recoverTerminalChildExit(
  childExit: Promise<number>,
  identity: { pid: number; startTime: string } | undefined,
  options?: {
    graceMs?: number;
    terminationOptions?: Record<string, unknown>;
    terminate?: (identity: { pid: number; startTime: string }, options?: Record<string, unknown>) => Promise<string>;
  },
): Promise<boolean>;
export function terminateTrackedSteps(
  steps?: Array<{ pid?: number; pidStartTime?: string }>,
  options?: Record<string, unknown>,
): Promise<Array<{ outcome: string }>>;
export function renderTerminationSignal(existingStatus?: Record<string, unknown>, existingResult?: Record<string, unknown>, timestamp?: number): { status: Record<string, unknown>; result: Record<string, unknown> };
export function armRunnerTermination(): void;
export function resetRunnerTerminationForTests(): void;
export function isRunnerTerminating(): boolean;
export function settleOwnedProcessTermination(options?: Record<string, unknown>): Promise<{ quiet: boolean }>;
export function buildTerminalPublicationPayload(results: Array<Record<string, unknown>>, timestamp?: number): Record<string, unknown>;
export function buildPiArgs(child: Record<string, unknown>, promptOverride?: string): string[];
export function canonicalizeChildResult(child: Record<string, unknown>, merged: Record<string, unknown>): Record<string, unknown>;
export function runTaskGraph(config: Record<string, unknown>, status: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
