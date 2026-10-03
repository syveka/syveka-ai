import type { Breadcrumb, ErrorEvent } from "@sentry/nextjs";
import { routeTemplate } from "@/lib/observability/routes";

/**
 * Builds the error event that may leave the process (browser or server),
 * from an allowlist. Applied in `beforeSend` / `beforeBreadcrumb`, after
 * every SDK integration has added its data.
 *
 * Error text can carry conversation content, CRM records, names (in any
 * script) or credentials, and no pattern list recognizes all of that. So
 * untrusted text is never forwarded:
 * - exception messages become a fixed description chosen from a known list
 *   (the original text is only matched, never copied);
 * - paths become a known app route template, or are omitted;
 * - URLs keep their origin only if it is a trusted origin (the app's own,
 *   from configuration), plus the template for app routes; any other
 *   origin (third parties, customer subdomains) and its path are omitted;
 * - stack frames keep only their code location and position: function and
 *   module names aren't sent, since nothing establishes they are code;
 * - everything not on an allowlist (user, extras, headers, cookies, bodies,
 *   variables, source lines, unknown contexts and tags) is dropped.
 * Nothing identifies the organization or user.
 */

const WITHHELD = "Error message withheld";

/** Known error shapes -> fixed descriptions. Order matters: first match wins. */
const SAFE_DESCRIPTIONS: Array<[RegExp, string | ((m: RegExpExecArray) => string)]> = [
  [/Minified React error #(\d{1,4})\b/, (m) => `React error #${m[1]}`],
  [
    /^Cannot read propert(y|ies) of (undefined|null)/,
    "Cannot read a property of undefined or null",
  ],
  [/^Cannot set propert(y|ies) of (undefined|null)/, "Cannot set a property of undefined or null"],
  [/ is not a function\b/, "A value is not a function"],
  [/ is not defined$/, "A variable is not defined"],
  [/ is not iterable\b/, "A value is not iterable"],
  [/Maximum call stack size exceeded/, "Maximum call stack size exceeded"],
  [/ChunkLoadError|Loading (CSS )?chunk [\w-]+ failed/, "Code chunk failed to load"],
  [/Hydration failed|hydration mismatch|didn't match the client/i, "Hydration mismatch"],
  [
    /\b(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT)\b/,
    (m) => `Network error ${m[1]}`,
  ],
  [
    /^(Failed to fetch|fetch failed|NetworkError when attempting to fetch resource|Load failed|Network request failed)/,
    "Network request failed",
  ],
  [/\bprisma\b/i, "Database operation failed"],
  [
    /Unexpected end of JSON input|is not valid JSON|JSON\.parse|in JSON at position/,
    "Invalid JSON",
  ],
  [/AbortError|aborted/i, "Operation aborted"],
  [/timed out|timeout/i, "Operation timed out"],
];

/** A fixed description for an untrusted message; the message itself is never returned. */
export function safeErrorDescription(message: unknown): string {
  if (typeof message !== "string" || message === "") return WITHHELD;
  const firstLine = message.split(/\r?\n/, 1)[0]!.slice(0, 2000);
  for (const [pattern, description] of SAFE_DESCRIPTIONS) {
    const match = pattern.exec(firstLine);
    if (match) return typeof description === "string" ? description : description(match);
  }
  return WITHHELD;
}

const ERROR_TYPE = /^[A-Za-z_$][\w$]{0,63}$/;
const HTTP_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const WORD = /^[\w .-]{1,40}$/;
/** Code locations (bundles, server chunks, packages), never page URLs. */
const CODE_FILE =
  /^(node:|internal\/|webpack|app:\/\/\/)|\/_next\/|\/\.next\/|\/node_modules\/|\.(m?js|cjs|tsx?|jsx)$/;

/**
 * Origins that may be reported: exactly the app's configured origin. No
 * wildcards. Read on each call so it follows the runtime configuration.
 */
function trustedOrigins(): ReadonlySet<string> {
  try {
    const app = new URL(process.env.NEXT_PUBLIC_APP_URL ?? "");
    return app.protocol === "http:" || app.protocol === "https:"
      ? new Set([app.origin])
      : new Set();
  } catch {
    return new Set();
  }
}

const safeMethod = (method: unknown) =>
  typeof method === "string" && HTTP_METHODS.has(method.toUpperCase())
    ? method.toUpperCase()
    : undefined;
const safeWord = (value: unknown) =>
  typeof value === "string" && WORD.test(value) ? value : undefined;

/**
 * An http(s) URL on a trusted origin as origin plus route template (when
 * it's an app route), a relative path as its template; anything else,
 * including any other origin, is omitted.
 */
export function safeUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  if (raw.startsWith("/")) return routeTemplate(raw);
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (!trustedOrigins().has(url.origin)) return undefined;
    // An origin alone has path "/": not the app's root page (also keeps this idempotent).
    if (url.pathname === "/") return url.origin;
    return url.origin + (routeTemplate(url.pathname) ?? "");
  } catch {
    return undefined;
  }
}

/** A stack-frame file: code locations without query or fragment; page URLs as templates. */
function safeFrameFile(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const withoutQuery = raw.split(/[?#]/, 1)[0]!;
  if (CODE_FILE.test(withoutQuery)) {
    try {
      const url = new URL(withoutQuery);
      if (url.protocol === "http:" || url.protocol === "https:") {
        if (!url.pathname.startsWith("/_next/")) return undefined;
        // A build asset path is code; the origin only when trusted.
        return (trustedOrigins().has(url.origin) ? url.origin : "") + url.pathname;
      }
    } catch {
      // A filesystem path or module specifier.
    }
    return withoutQuery;
  }
  return safeUrl(raw);
}

/** "POST /[locale]/inbox/[threadId]" or a bare path -> method + template, else undefined. */
function safeTransaction(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const [first, ...rest] = raw.split(" ");
  const method = safeMethod(first);
  const template = routeTemplate(method ? rest.join(" ") : raw);
  if (!template) return method;
  return method ? `${method} ${template}` : template;
}

const KEPT_BREADCRUMBS = new Set(["navigation", "fetch", "xhr", "http"]);

export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  const category = breadcrumb.category ?? "";
  if (!KEPT_BREADCRUMBS.has(category)) return null;
  const data = breadcrumb.data ?? {};
  const kept: Record<string, unknown> =
    category === "navigation"
      ? { from: routeTemplateOfUrl(data.from), to: routeTemplateOfUrl(data.to) }
      : {
          method: safeMethod(data.method),
          url: safeUrl(data.url),
          status_code: typeof data.status_code === "number" ? data.status_code : undefined,
        };
  return {
    type: safeWord(breadcrumb.type),
    category,
    level: breadcrumb.level,
    timestamp: breadcrumb.timestamp,
    data: Object.fromEntries(Object.entries(kept).filter(([, v]) => v !== undefined)),
  };
}

function routeTemplateOfUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  if (raw.startsWith("/")) return routeTemplate(raw);
  try {
    return routeTemplate(new URL(raw).pathname);
  } catch {
    return undefined;
  }
}

/** Per context, the fields that are kept (runtime and environment facts only). */
const CONTEXT_FIELDS: Record<string, readonly string[]> = {
  runtime: ["name", "version"],
  os: ["name", "version"],
  browser: ["name", "version"],
  device: ["arch", "family", "processor_count", "memory_size"],
};

function safeContexts(contexts: ErrorEvent["contexts"]): ErrorEvent["contexts"] {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, fields] of Object.entries(CONTEXT_FIELDS)) {
    const context = contexts?.[name] as Record<string, unknown> | undefined;
    if (!context) continue;
    const kept = Object.fromEntries(
      fields
        .map((field) => [field, context[field]] as const)
        .filter(
          ([, value]) =>
            typeof value === "number" || (typeof value === "string" && WORD.test(value)),
        ),
    );
    if (Object.keys(kept).length) out[name] = kept;
  }
  const nextjs = contexts?.nextjs as Record<string, unknown> | undefined;
  if (nextjs) {
    out.nextjs = Object.fromEntries(
      Object.entries({
        request_path:
          typeof nextjs.request_path === "string" ? routeTemplate(nextjs.request_path) : undefined,
        router_path:
          typeof nextjs.router_path === "string" ? routeTemplate(nextjs.router_path) : undefined,
        router_kind: safeWord(nextjs.router_kind),
        route_type: safeWord(nextjs.route_type),
      }).filter(([, v]) => v !== undefined),
    );
  }
  return out as ErrorEvent["contexts"];
}

/** SDK-set tags that are kept, with short, word-like values only. */
const KEPT_TAGS = new Set(["runtime", "turbopack"]);

function safeTags(tags: ErrorEvent["tags"]): ErrorEvent["tags"] {
  return Object.fromEntries(
    Object.entries(tags ?? {}).filter(
      ([key, value]) =>
        KEPT_TAGS.has(key) &&
        (typeof value === "boolean" || (typeof value === "string" && WORD.test(value))),
    ),
  );
}

export function scrubEvent(event: ErrorEvent): ErrorEvent {
  const request = event.request;
  return {
    type: undefined,
    event_id: event.event_id,
    timestamp: event.timestamp,
    level: event.level,
    platform: event.platform,
    environment: event.environment,
    release: event.release,
    dist: event.dist,
    sdk: event.sdk,
    debug_meta: event.debug_meta,
    contexts: safeContexts(event.contexts),
    tags: safeTags(event.tags),
    transaction: safeTransaction(event.transaction),
    message: event.message === undefined ? undefined : safeErrorDescription(event.message),
    request: request
      ? { method: safeMethod(request.method), url: safeUrl(request.url) }
      : undefined,
    exception: event.exception
      ? {
          values: event.exception.values?.map((exception) => ({
            type: exception.type && ERROR_TYPE.test(exception.type) ? exception.type : "Error",
            value: safeErrorDescription(exception.value),
            mechanism: exception.mechanism
              ? {
                  type: safeWord(exception.mechanism.type) ?? "generic",
                  handled: exception.mechanism.handled,
                }
              : undefined,
            stacktrace: exception.stacktrace
              ? {
                  frames: exception.stacktrace.frames?.map((frame) => ({
                    filename: safeFrameFile(frame.filename),
                    abs_path: safeFrameFile(frame.abs_path),
                    lineno: frame.lineno,
                    colno: frame.colno,
                    in_app: frame.in_app,
                  })),
                }
              : undefined,
          })),
        }
      : undefined,
    breadcrumbs: event.breadcrumbs
      ?.map(scrubBreadcrumb)
      .filter((breadcrumb): breadcrumb is Breadcrumb => breadcrumb !== null),
  };
}
