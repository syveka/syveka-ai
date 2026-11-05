export const MAX_FILE_BYTES: number;
export const MAX_JOB_OUTPUT_BYTES: number;
export class WorkerOutputReader {
  constructor(outputDir: string);
  failure: string | null;
  push(chunk: Buffer): void;
  finish(expectedRenders?: number | null): {
    ok: boolean;
    error?: { code: string };
    results?: Array<{
      ok: boolean;
      file?: string | null;
      hostVerified?: boolean;
      error?: { code: string };
    }>;
  };
}
