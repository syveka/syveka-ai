export const MAX_FILE_BYTES: number;
export const MAX_JOB_OUTPUT_BYTES: number;
export function expectedOutputNames(job: unknown): string[] | null;
export class WorkerOutputReader {
  constructor(outputDir: string, expectedNames?: string[] | null);
  failure: string | null;
  push(chunk: Buffer): void;
  abort(): void;
  finish(): {
    ok: boolean;
    error?: { code: string };
    results?: Array<{
      index: number;
      ok: boolean;
      file?: string;
      hostVerified?: boolean;
      sizeBytes?: number;
      error?: { code: string };
    }>;
  };
}
