/**
 * Writes a benchmark job with synthetic copy for a fictional business.
 * Usage: node scripts/sample-job.mjs <jobId> <subset> > job.json
 * `subset` is a template id (that template in FI/EN/AR at every aspect ratio, 9 renders) or
 * `smoke` (one Arabic render).
 */
const COPY = {
  en: {
    brand: "Northwind Dental",
    headline: "A healthy smile starts with one visit",
    description:
      "Modern care for the whole family, close to home. New patients welcome this month.",
    callToAction: "Book your visit",
  },
  fi: {
    brand: "Pohjantuulen Hammaslääkärit",
    headline: "Hammaslääkäriasemamme ajanvarauspalvelu on nyt käytettävissä ympäri vuorokauden",
    description:
      "Nykyaikaista hoitoa koko perheelle lähellä kotia. Otamme vastaan uusia potilaita tässä kuussa.",
    callToAction: "Varaa aika nyt",
  },
  ar: {
    brand: "عيادة الرياح الشمالية",
    headline: "ابتسامة صحية تبدأ بزيارة واحدة",
    description: "رعاية حديثة لجميع أفراد الأسرة بالقرب من منزلك. نرحب بالمرضى الجدد هذا الشهر.",
    callToAction: "احجز زيارتك",
  },
};
const COLORS = {
  background: "#0b1f33",
  text: "#ffffff",
  accent: "#ffd166",
  accentText: "#10202f",
};
const TEMPLATES = ["product-ad", "local-service", "social-announcement"];
const ASPECTS = ["9:16", "1:1", "16:9"];

const spec = (template, language, aspectRatio, media) => ({
  template,
  language,
  aspectRatio,
  ...COPY[language],
  colors: COLORS,
  logo: "logo.png",
  ...(media ? { media } : {}),
});

const [jobId = "sample", subset = "smoke"] = process.argv.slice(2);
const image = { kind: "image", file: "photo.jpg" };
const renders = TEMPLATES.includes(subset)
  ? Object.keys(COPY).flatMap((language) =>
      ASPECTS.map((aspect) => spec(subset, language, aspect, image)),
    )
  : [spec("product-ad", "ar", "9:16", image)];
process.stdout.write(JSON.stringify({ jobId, renders }, null, 2));
