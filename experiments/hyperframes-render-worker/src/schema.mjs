import { z } from "zod";

export const ASPECT_DIMENSIONS = {
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
  "16:9": { width: 1920, height: 1080 },
};
export const TEMPLATE_IDS = ["product-ad", "local-service", "social-announcement"];
export const MAX_RENDERS_PER_JOB = 12;

/**
 * Plain file names only. A path, a URL or a hidden file can't match, so nothing from the job
 * can name a location outside the read-only input directory.
 */
const mediaFileName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.(png|jpe?g|webp|mp4)$/);

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/** Control, bidi-override and line-separator characters could reorder or hide on-screen text. */
const UNSAFE_TEXT = /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069]/u;

/** @param {number} max */
const displayText = (max) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !UNSAFE_TEXT.test(value), "unsafe characters");

/** @param {string} hex */
function relativeLuminance(hex) {
  const channels = [1, 3, 5].map((start) => {
    const value = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/**
 * WCAG 2 contrast ratio between two `#rrggbb` colors.
 * @param {string} first
 * @param {string} second
 */
export function contrastRatio(first, second) {
  const [low, high] = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => a - b);
  return (high + 0.05) / (low + 0.05);
}

const WCAG_AA_NORMAL_TEXT = 4.5;

export const renderSpecSchema = z
  .strictObject({
    template: z.enum(TEMPLATE_IDS),
    language: z.enum(["fi", "en", "ar"]),
    aspectRatio: z.enum(Object.keys(ASPECT_DIMENSIONS)),
    brand: displayText(40),
    headline: displayText(90),
    description: displayText(220).optional(),
    callToAction: displayText(40),
    colors: z.strictObject({
      background: hexColor,
      text: hexColor,
      accent: hexColor,
      accentText: hexColor,
    }),
    logo: mediaFileName.optional(),
    media: z.strictObject({ kind: z.enum(["image", "video"]), file: mediaFileName }).optional(),
  })
  .superRefine((spec, ctx) => {
    const { background, text, accent, accentText } = spec.colors;
    if (contrastRatio(background, text) < WCAG_AA_NORMAL_TEXT) {
      ctx.addIssue({ code: "custom", path: ["colors", "text"], message: "low contrast" });
    }
    if (contrastRatio(accent, accentText) < WCAG_AA_NORMAL_TEXT) {
      ctx.addIssue({ code: "custom", path: ["colors", "accentText"], message: "low contrast" });
    }
    if (spec.logo && !/\.(png|webp)$/.test(spec.logo)) {
      ctx.addIssue({ code: "custom", path: ["logo"], message: "logo must be png or webp" });
    }
    if (spec.media) {
      const isVideoFile = spec.media.file.endsWith(".mp4");
      if (isVideoFile !== (spec.media.kind === "video")) {
        ctx.addIssue({ code: "custom", path: ["media", "file"], message: "kind mismatch" });
      }
    }
  });

export const jobSchema = z.strictObject({
  jobId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/),
  renders: z.array(renderSpecSchema).min(1).max(MAX_RENDERS_PER_JOB),
});

/**
 * Field paths only: an error message must never echo back what was submitted.
 * @param {unknown} input
 */
export function parseJob(input) {
  const parsed = jobSchema.safeParse(input);
  if (parsed.success) return { ok: true, job: parsed.data };
  return {
    ok: false,
    fields: [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))],
  };
}
