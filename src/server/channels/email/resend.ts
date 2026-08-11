import "server-only";

import { sendRawEmail } from "@/server/integrations/resend";
import { EmailChannelError, type EmailChannelAdapter, type SentEmail } from "./types";

function isConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

export const resendEmailChannelAdapter: EmailChannelAdapter = {
  provider: "RESEND",

  isConfigured,

  async send(email): Promise<SentEmail> {
    if (!isConfigured()) {
      throw new EmailChannelError("Resend not configured", "not_configured");
    }
    try {
      const headers = email.inReplyToExternalId
        ? {
            "In-Reply-To": email.inReplyToExternalId,
            References: email.inReplyToExternalId,
          }
        : undefined;
      const { id } = await sendRawEmail({
        to: email.to,
        subject: email.subject,
        text: email.text,
        html: email.html,
        replyTo: email.replyTo,
        headers,
      });
      return { externalId: id };
    } catch (err) {
      throw new EmailChannelError(
        err instanceof Error ? err.message : "Resend send failed",
        "remote_error",
        true,
      );
    }
  },
};
