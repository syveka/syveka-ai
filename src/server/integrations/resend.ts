import "server-only";

import { Resend } from "resend";
import type { ReactElement } from "react";
import { getResendEnv } from "@/env";

let resend: Resend | null = null;

function getResend(): Resend {
  resend ??= new Resend(getResendEnv().RESEND_API_KEY);
  return resend;
}

/** All outbound email goes through here (localized templates in /emails). */
export async function sendEmail(params: {
  to: string | string[];
  subject: string;
  react: ReactElement;
  replyTo?: string;
}): Promise<{ id: string }> {
  const { EMAIL_FROM } = getResendEnv();
  const { data, error } = await getResend().emails.send({
    from: EMAIL_FROM,
    to: params.to,
    subject: params.subject,
    react: params.react,
    replyTo: params.replyTo,
  });
  if (error || !data) throw new Error(`Resend error: ${error?.message ?? "unknown"}`);
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
