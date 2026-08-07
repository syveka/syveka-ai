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
