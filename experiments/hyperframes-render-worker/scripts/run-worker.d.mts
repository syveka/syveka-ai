import type { spawn } from "node:child_process";

export const IMAGE: string;
export const CONTAINER_LABEL: string;
export const JOB_DEADLINE_MS: number;
export function resolveMountPath(
  path: string,
  options?: { jobsRoot?: string; home?: string },
): string;
export function buildDockerArgs(options: {
  inputDir: string;
  jobsRoot?: string;
  name?: string;
  cpus?: string;
  memory?: string;
}): string[];
export function runWorker(options: {
  job: Buffer;
  inputDir: string;
  outputDir: string;
  jobsRoot?: string;
  memory?: string;
  deadlineMs?: number;
  forceStopMs?: number;
  spawnProcess?: typeof spawn;
}): Promise<{ ok: boolean; error?: { code: string }; results?: unknown[] }>;
