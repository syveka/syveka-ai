export const ASPECT_DIMENSIONS: Record<string, { width: number; height: number }>;
export const TEMPLATE_IDS: string[];
export const MAX_RENDERS_PER_JOB: number;
export function contrastRatio(first: string, second: string): number;
export function parseJob(
  input: unknown,
): { ok: true; job: { jobId: string; renders: unknown[] } } | { ok: false; fields: string[] };
