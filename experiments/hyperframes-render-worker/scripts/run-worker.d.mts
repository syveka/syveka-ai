export const IMAGE: string;
export const JOB_DEADLINE_MS: number;
export function assertSafeMountPath(path: string, home?: string): void;
export function buildDockerArgs(options: {
  inputDir: string;
  name?: string;
  cpus?: string;
  memory?: string;
}): string[];
