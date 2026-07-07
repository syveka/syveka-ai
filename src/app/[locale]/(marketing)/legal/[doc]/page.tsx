import { notFound } from "next/navigation";

/**
 * GDPR-required documents (§13.3). Placeholder copy — final texts come from
 * counsel before launch; the routes, layout and links are production-ready.
 */
const DOCS: Record<string, { title: string; body: string }> = {
  privacy: {
    title: "Privacy Policy · Tietosuojaseloste",
    body: "Syveka AI processes personal data as described in this policy in accordance with the GDPR. Data is stored in the EU (Frankfurt). Subprocessors: Supabase, Vercel, Stripe, Anthropic, OpenAI, Vapi, Resend, Upstash. Contact: privacy@syveka.ai.",
  },
  terms: {
    title: "Terms of Service · Käyttöehdot",
    body: "These terms govern the use of the Syveka AI platform. Subscriptions renew automatically and can be cancelled at any time effective at the end of the billing period.",
  },
  dpa: {
    title: "Data Processing Agreement",
    body: "This DPA applies where Syveka Oy processes personal data on behalf of the customer as a processor under Art. 28 GDPR. The current subprocessor list and technical and organisational measures are described herein.",
  },
};

export function generateStaticParams() {
  return Object.keys(DOCS).map((doc) => ({ doc }));
}

export default async function LegalPage({ params }: { params: Promise<{ doc: string }> }) {
  const { doc } = await params;
  const content = DOCS[doc];
  if (!content) notFound();

  return (
    <article className="container max-w-2xl py-16">
      <h1 className="text-3xl font-bold">{content.title}</h1>
      <p className="mt-6 leading-7 text-muted-foreground">{content.body}</p>
      <p className="mt-8 text-sm text-muted-foreground">Last updated: 2026-07-06</p>
    </article>
  );
}
