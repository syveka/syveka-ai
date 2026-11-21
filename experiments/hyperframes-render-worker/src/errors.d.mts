export class WorkerError extends Error {
  code: string;
  fields?: string[];
  constructor(code: string, details?: { fields?: string[] });
}
export function toErrorResult(error: unknown): {
  ok: false;
  error: { code: string; message: string; fields?: string[] };
};
