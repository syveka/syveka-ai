/**
 * How long a Knowledge document's processing may take before it counts as
 * abandoned. Pure, so the embed job and the document list share the numbers.
 *
 * The embed job (`/api/v1/jobs/embed-document`, maxDuration 300 s) is
 * delivered by QStash with 3 retries; Upstash's backoff spaces them about
 * 12 s, 2.5 min and 30 min apart. A run killed by the platform (timeout,
 * out of memory) never reaches its catch block, so it leaves the document
 * PROCESSING; a delivery that never got that far leaves it PENDING.
 */

/**
 * A PROCESSING claim older than this belongs to a run that is no longer
 * running: the platform stops every run at 300 s. A later delivery may take
 * the document over. Kept above maxDuration with a margin for clock skew.
 */
export const DOCUMENT_PROCESSING_RECLAIM_MS = 7 * 60_000;

/**
 * A document still PENDING or PROCESSING this long after its last update
 * has outlived every scheduled retry (~35 min plus the runs themselves), so
 * nothing will finish it. The owner is told to add it again.
 */
export const DOCUMENT_STALLED_AFTER_MS = 2 * 60 * 60_000;

/** Whether the document is stuck: queued or processing, with nothing left to finish it. */
export function isDocumentStalled(
  document: { status: string; updatedAt: Date },
  now: Date = new Date(),
): boolean {
  return (
    (document.status === "PENDING" || document.status === "PROCESSING") &&
    now.getTime() - document.updatedAt.getTime() > DOCUMENT_STALLED_AFTER_MS
  );
}
