import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COMPOSITION_SECONDS } from "./constants.mjs";
import { ASPECT_DIMENSIONS } from "./schema.mjs";

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FONTS = [
  ["noto-sans", "noto-sans-latin-400-normal.woff2"],
  ["noto-sans", "noto-sans-latin-800-normal.woff2"],
  ["noto-sans-arabic", "noto-sans-arabic-arabic-400-normal.woff2"],
  ["noto-sans-arabic", "noto-sans-arabic-arabic-800-normal.woff2"],
];

/**
 * JSON inside an HTML `<script>`: escaping these characters keeps any submitted text from
 * closing the tag or opening a comment, whatever the text contains.
 * @param {unknown} value
 */
export function serializeForHtmlScript(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * Fixed markup with fixed file names: no value from the job is ever part of this string.
 * @param {"image" | "video" | undefined} kind
 */
function mediaMarkup(kind) {
  if (kind === "image") return '<img id="media" class="media" src="assets/media.png" alt="" />';
  if (kind === "video") {
    return (
      `<video id="media" class="media clip" src="assets/media.mp4" muted playsinline ` +
      `data-start="0" data-duration="${COMPOSITION_SECONDS}" data-track-index="0"></video>`
    );
  }
  return "";
}

/**
 * Fills a template with job data. Only the size, the media slot and a JSON data block are
 * substituted. The template reads the JSON with JSON.parse and writes it with textContent, so
 * submitted text is never parsed as HTML or run as code.
 *
 * @param {{ spec: any, projectDir: string, hasLogo: boolean, appRoot?: string }} args
 */
export function writeProject({ spec, projectDir, hasLogo, appRoot = APP_ROOT }) {
  const { width, height } = ASPECT_DIMENSIONS[spec.aspectRatio];
  const assets = join(projectDir, "assets");
  mkdirSync(assets, { recursive: true });
  for (const [family, file] of FONTS) {
    cpSync(join(appRoot, "node_modules", "@fontsource", family, "files", file), join(assets, file));
  }
  cpSync(join(appRoot, "templates", "shared"), assets, { recursive: true });

  const data = {
    brand: spec.brand,
    headline: spec.headline,
    description: spec.description ?? "",
    callToAction: spec.callToAction,
    colors: spec.colors,
    hasLogo,
    hasMedia: Boolean(spec.media),
    mediaKind: spec.media?.kind ?? null,
    duration: COMPOSITION_SECONDS,
  };
  const template = readFileSync(join(appRoot, "templates", spec.template, "index.html"), "utf8");
  // Replacer functions, because `$` sequences in a replacement string are special.
  const html = template
    .replace(/__WIDTH__/g, () => String(width))
    .replace(/__HEIGHT__/g, () => String(height))
    .replace(/__DURATION__/g, () => String(COMPOSITION_SECONDS))
    .replace(/__LANG__/g, () => spec.language)
    .replace(/__DIR__/g, () => (spec.language === "ar" ? "rtl" : "ltr"))
    .replace(/__ASPECT__/g, () => spec.aspectRatio.replace(":", "x"))
    .replace("<!--MEDIA_SLOT-->", () => mediaMarkup(spec.media?.kind))
    .replace("__JOB_DATA__", () => serializeForHtmlScript(data));
  writeFileSync(join(projectDir, "index.html"), html);
}
