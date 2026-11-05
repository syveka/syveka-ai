/** Failures the caller may see. Only these stable codes and messages leave the worker. */
const MESSAGES = {
  invalid_job: "The job does not match the render schema.",
  invalid_media: "A media file failed validation.",
  media_not_found: "A referenced media file does not exist in the input directory.",
  render_failed: "The renderer could not produce a video.",
  quality_check_failed: "The composition failed the quality check.",
  output_invalid: "The rendered file failed output verification.",
  render_timeout: "The render exceeded its time limit.",
  internal_error: "The worker failed unexpectedly.",
};

export class WorkerError extends Error {
  /**
   * @param {keyof typeof MESSAGES} code
   * @param {{ fields?: string[] }} [details] Field paths only, never submitted values.
   */
  constructor(code, details = {}) {
    super(MESSAGES[code]);
    this.name = "WorkerError";
    this.code = code;
    this.fields = details.fields;
  }
}

/** @param {unknown} error */
export function toErrorResult(error) {
  const known = error instanceof WorkerError ? error : new WorkerError("internal_error");
  return {
    ok: false,
    error: {
      code: known.code,
      message: known.message,
      ...(known.fields ? { fields: known.fields } : {}),
    },
  };
}
