import { APP_LOCALES } from "@/i18n/locales";
import { ROUTE_TEMPLATES } from "@/lib/observability/route-templates";

/**
 * Maps a concrete path ("/en/inbox/<id>", "/inbox/<id>") to the app route
 * template it belongs to ("/[locale]/inbox/[threadId]"). Anything that isn't
 * a known route yields undefined, so a raw path segment is never reported.
 */

interface CompiledRoute {
  template: string;
  /** Segments after an optional leading [locale]. */
  segments: string[];
  localized: boolean;
  staticCount: number;
}

const LOCALES: ReadonlySet<string> = new Set(APP_LOCALES);
const TEMPLATES: ReadonlySet<string> = new Set(ROUTE_TEMPLATES);
const isDynamic = (segment: string) => segment.startsWith("[") && segment.endsWith("]");

const COMPILED: CompiledRoute[] = ROUTE_TEMPLATES.map((template) => {
  const all = template.split("/").filter(Boolean);
  const localized = all[0] === "[locale]";
  const segments = localized ? all.slice(1) : all;
  return {
    template,
    segments,
    localized,
    staticCount: segments.filter((s) => !isDynamic(s)).length,
  };
});

function matches(pattern: string[], parts: string[]): boolean {
  if (pattern.length === 0) return parts.length === 0;
  const [head, ...rest] = pattern;
  if (head!.startsWith("[[...")) return true;
  if (head!.startsWith("[...")) return parts.length > 0;
  if (parts.length === 0) return false;
  if (isDynamic(head!) ? parts[0] === "" : parts[0] !== head) return false;
  return matches(rest, parts.slice(1));
}

/**
 * A Next.js route path (as in onRequestError's context, possibly with route
 * groups or a trailing /page or /route) reduced to a known template.
 */
function knownTemplate(path: string): string | undefined {
  const reduced = path
    .replace(/^\/app(?=\/)/, "")
    .replace(/\/(page|route)$/, "")
    .split("/")
    .filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith("@"))
    .join("/");
  const candidate = reduced === "" ? "/" : reduced;
  return TEMPLATES.has(candidate) ? candidate : undefined;
}

export function routeTemplate(rawPath: string | undefined): string | undefined {
  if (typeof rawPath !== "string") return undefined;
  const path = rawPath.split(/[?#]/, 1)[0] ?? "";
  if (!path.startsWith("/")) return undefined;
  const known = knownTemplate(path);
  if (known) return known;

  const parts = path.split("/").slice(1);
  if (parts[parts.length - 1] === "") parts.pop();
  // localePrefix "as-needed": the default locale has no prefix.
  const unprefixed = parts.length > 0 && LOCALES.has(parts[0]!) ? parts.slice(1) : parts;

  let best: CompiledRoute | undefined;
  for (const route of COMPILED) {
    const ok = route.localized
      ? matches(route.segments, unprefixed)
      : matches(route.segments, parts);
    if (ok && (!best || route.staticCount > best.staticCount)) best = route;
  }
  return best?.template;
}
