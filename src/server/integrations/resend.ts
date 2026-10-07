import "server-only";

import { Resend } from "resend";
import type { ReactElement } from "react";
import { getResendEnv } from "@/env";

let resend: Resend | null = null;

function getResend(): Resend {
  resend ??= new Resend(getResendEnv().RESEND_API_KEY);
  return resend;
}

/**
 * A send the provider rejected. `code` is Resend's error name (for example
 * "validation_error" or "invalid_from_address"): safe to log, unlike the
 * message, which can quote addresses.
 */
export class EmailSendError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`Resend error: ${message}`);
    this.name = "EmailSendError";
  }
}

/** All outbound email goes through here (localized templates in /emails). */
export async function sendEmail(params: {
  to: string | string[];
  subject: string;
  react: ReactElement;
  replyTo?: string;
  /**
   * Forwarded as Resend's own `Idempotency-Key` header: a retry that reuses
   * the same key is deduplicated by Resend itself, not just by our own
   * records, closing the crash window between the send succeeding and our
   * own persistence of that fact (see claimStep()/completeStep() in
   * src/app/api/v1/jobs/run-workflow/route.ts).
   */
  idempotencyKey?: string;
}): Promise<{ id: string }> {
  const { EMAIL_FROM } = getResendEnv();
  const { data, error } = await getResend().emails.send(
    {
      from: EMAIL_FROM,
      to: params.to,
      subject: params.subject,
      react: params.react,
      replyTo: params.replyTo,
    },
    params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : undefined,
  );
  if (error || !data) {
    throw new EmailSendError(error?.name ?? "unknown", error?.message ?? "unknown");
  }
  return { id: data.id };
}

/**
 * Raw (non-template) send for dynamic bodies — the Inbox email channel's
 * outbound replies, which have no react-email template since the content is
 * AI-drafted or human-authored per thread.
 */
export async function sendRawEmail(params: {
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  headers?: Record<string, string>;
}): Promise<{ id: string }> {
  const { EMAIL_FROM } = getResendEnv();
  const { data, error } = await getResend().emails.send({
    from: EMAIL_FROM,
    to: params.to,
    subject: params.subject,
    text: params.text,
    html: params.html,
    replyTo: params.replyTo,
    headers: params.headers,
  });
  if (error || !data) throw new Error(`Resend error: ${error?.message ?? "unknown"}`);
  return { id: data.id };
}
