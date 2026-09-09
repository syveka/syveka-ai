/**
 * Seeds: global prompt library (FI/EN) + demo data for local dev.
 * Global prompts have organizationId = null (§15.7).
 */
import { PrismaClient, Locale } from "@prisma/client";
import { DEFAULT_PIPELINE_STAGES } from "../src/lib/constants";

void DEFAULT_PIPELINE_STAGES; // re-exported for compat

const prisma = new PrismaClient();

const globalPrompts: Array<{
  title: string;
  category: string;
  locale: Locale;
  description: string;
  content: string;
  variables: Array<{ name: string; label: string; type: "text" | "number" | "select" }>;
}> = [
  {
    title: "Vastaus tarjouspyyntöön",
    category: "sales",
    locale: Locale.FI,
    description: "Ammattimainen vastaus asiakkaan tarjouspyyntöön.",
    content:
      "Kirjoita ammattimainen ja ystävällinen vastaus tarjouspyyntöön.\n\nAsiakas: {{customer}}\nPyyntö: {{request}}\nTarjottava ratkaisu ja hinta: {{offer}}\n\nSisällytä: kiitos yhteydenotosta, ratkaisun kuvaus, hinta ja toimitusaika, selkeä seuraava askel.",
    variables: [
      { name: "customer", label: "Asiakkaan nimi", type: "text" },
      { name: "request", label: "Tarjouspyynnön sisältö", type: "text" },
      { name: "offer", label: "Tarjous ja hinta", type: "text" },
    ],
  },
  {
    title: "Maksumuistutus",
    category: "finance",
    locale: Locale.FI,
    description: "Kohtelias maksumuistutus erääntyneestä laskusta.",
    content:
      "Kirjoita kohtelias mutta selkeä maksumuistutus.\n\nAsiakas: {{customer}}\nLaskun numero: {{invoiceNumber}}\nSumma: {{amount}} €\nEräpäivä: {{dueDate}}\n\nSävy: ystävällinen ensimmäinen muistutus.",
    variables: [
      { name: "customer", label: "Asiakas", type: "text" },
      { name: "invoiceNumber", label: "Laskun numero", type: "text" },
      { name: "amount", label: "Summa (€)", type: "number" },
      { name: "dueDate", label: "Eräpäivä", type: "text" },
    ],
  },
  {
    title: "Työpaikkailmoitus",
    category: "hr",
    locale: Locale.FI,
    description: "Houkutteleva työpaikkailmoitus.",
    content:
      "Kirjoita houkutteleva työpaikkailmoitus.\n\nTehtävä: {{role}}\nYritys ja toimiala: {{company}}\nVaatimukset: {{requirements}}\nEdut: {{benefits}}",
    variables: [
      { name: "role", label: "Tehtävänimike", type: "text" },
      { name: "company", label: "Yritys", type: "text" },
      { name: "requirements", label: "Vaatimukset", type: "text" },
      { name: "benefits", label: "Edut", type: "text" },
    ],
  },
  {
    title: "Meeting summary",
    category: "productivity",
    locale: Locale.EN,
    description: "Turn raw meeting notes into a structured summary with action items.",
    content:
      "Summarize the following meeting notes into: key decisions, action items (owner + due date), and open questions.\n\nNotes:\n{{notes}}",
    variables: [{ name: "notes", label: "Meeting notes", type: "text" }],
  },
  {
    title: "Social media post",
    category: "marketing",
    locale: Locale.EN,
    description: "LinkedIn post promoting a product or announcement.",
    content:
      "Write a LinkedIn post in a professional but warm tone.\n\nTopic: {{topic}}\nAudience: {{audience}}\nCall to action: {{cta}}\n\nLength: under 150 words. No hashtags spam — max 3.",
    variables: [
      { name: "topic", label: "Topic", type: "text" },
      { name: "audience", label: "Audience", type: "text" },
      { name: "cta", label: "Call to action", type: "text" },
    ],
  },
];

/** Global Creator Studio templates (Phase 8) — organizationId null, same convention as globalPrompts. */
const globalCreatorTemplates: Array<{
  name: string;
  slug: string;
  category: string;
  generationType: "IMAGE" | "IMAGE_TO_VIDEO" | "CAPTION" | "VOICE" | "CAMPAIGN_ASSET";
  aspectRatio: string;
  promptTemplate: string;
}> = [
  {
    name: "Luxury portrait",
    slug: "luxury-portrait",
    category: "Business",
    generationType: "IMAGE",
    aspectRatio: "4:5",
    promptTemplate:
      "A polished, high-end editorial portrait of {{character}}, soft studio lighting, luxury aesthetic, shallow depth of field.",
  },
  {
    name: "Business professional",
    slug: "business-professional",
    category: "Business",
    generationType: "IMAGE",
    aspectRatio: "4:5",
    promptTemplate:
      "A confident professional headshot of {{character}} in business attire, clean neutral background, natural light.",
  },
  {
    name: "Restaurant promotion",
    slug: "restaurant-promotion",
    category: "Restaurant",
    generationType: "IMAGE",
    aspectRatio: "1:1",
    promptTemplate:
      "{{character}} presenting {{dish}} at a warm, inviting restaurant table, appetizing food styling, natural light.",
  },
  {
    name: "Product showcase",
    slug: "product-showcase",
    category: "Product",
    generationType: "IMAGE",
    aspectRatio: "1:1",
    promptTemplate:
      "{{character}} showcasing {{product}} against a clean minimal background, product-photography lighting.",
  },
  {
    name: "Travel creator",
    slug: "travel-creator",
    category: "Travel",
    generationType: "IMAGE",
    aspectRatio: "9:16",
    promptTemplate:
      "{{character}} exploring {{destination}}, candid travel-influencer style, golden-hour light, vertical framing.",
  },
  {
    name: "Fashion creator",
    slug: "fashion-creator",
    category: "Fashion",
    generationType: "IMAGE",
    aspectRatio: "4:5",
    promptTemplate:
      "{{character}} wearing {{outfit}}, editorial fashion photography, dynamic pose, urban backdrop.",
  },
  {
    name: "UGC testimonial",
    slug: "ugc-testimonial",
    category: "UGC",
    generationType: "IMAGE_TO_VIDEO",
    aspectRatio: "9:16",
    promptTemplate:
      "{{character}} speaking directly to camera about {{product}}, authentic handheld UGC style, casual setting.",
  },
  {
    name: "TikTok hook",
    slug: "tiktok-hook",
    category: "TikTok",
    generationType: "IMAGE_TO_VIDEO",
    aspectRatio: "9:16",
    promptTemplate:
      "{{character}} delivering a punchy opening hook about {{topic}} directly to camera, high-energy TikTok style.",
  },
  {
    name: "Instagram Reel promo",
    slug: "instagram-reel-promo",
    category: "Reels",
    generationType: "IMAGE_TO_VIDEO",
    aspectRatio: "9:16",
    promptTemplate:
      "{{character}} promoting {{offer}} in a fast-paced Instagram Reel style with quick motion.",
  },
  {
    name: "YouTube Short intro",
    slug: "youtube-short-intro",
    category: "Shorts",
    generationType: "IMAGE_TO_VIDEO",
    aspectRatio: "9:16",
    promptTemplate:
      "{{character}} introducing a YouTube Short about {{topic}}, energetic intro framing, direct eye contact.",
  },
];

async function main() {
  for (const p of globalPrompts) {
    const existing = await prisma.prompt.findFirst({
      where: { organizationId: null, title: p.title, locale: p.locale },
    });
    if (!existing) {
      await prisma.prompt.create({
        data: { ...p, organizationId: null, variables: p.variables },
      });
    }
  }
  console.log(`Seeded ${globalPrompts.length} global prompts.`);

  for (const t of globalCreatorTemplates) {
    const existing = await prisma.creatorTemplate.findFirst({
      where: { organizationId: null, slug: t.slug },
    });
    if (!existing) {
      await prisma.creatorTemplate.create({ data: { ...t, organizationId: null } });
    }
  }
  console.log(`Seeded ${globalCreatorTemplates.length} global Creator Studio templates.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
