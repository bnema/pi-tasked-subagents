export function renderTaskGraphTemplate(template: string, results: Record<string, unknown>): string;
export function evaluateTaskGraphCondition(expression: unknown, results: Record<string, unknown>): boolean;
export function parseStructuredStepOutput(output: unknown, outputMode?: string): unknown;
export function getReadyTaskGraphStepIds(steps: Array<{ id?: string; status?: string; dependsOn?: string[] }>, maxConcurrency: number): string[];
export function renderTerminationSignal(existingStatus?: Record<string, unknown>, existingResult?: Record<string, unknown>, timestamp?: number): { status: Record<string, unknown>; result: Record<string, unknown> };
