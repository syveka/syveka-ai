export function childEnvironment(home: string): Record<string, string>;
export function killLeftoverProcesses(): void;
export function runHyperframes(
  command: "check" | "render",
  args: unknown[],
  options: { home: string; timeoutMs: number },
): Promise<{ code: number | null; stdout: string }>;
