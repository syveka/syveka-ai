import "server-only";

import { Resend } from "resend";
import type { ReactElement } from "react";
import { env } from "@/env";

const resend = new Resend(env.RESEND_API_KEY);

/** All outbound email goes through here (localized templates in /emails). */
export async function sendEmail(params: {
  to: string | string[];
  subject: string;
  react: ReactElement;
  replyTo?: string;
}): Promise<{ id: string }> {
  const { data, error } = await resend.emails.send({
    from: env.EMAIL_FROM,
    to: params.to,
    subject: params.subject,
    react: params.react,
    replyTo: params.replyTo,
  });
  if (error || !data) throw new Error(`Resend error: ${error?.message ?? "unknown"}`);
  return { id: data.id };
}
