import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

/**
 * Static security headers (§13.2). Content-Security-Policy is set in
 * `src/middleware.ts` instead, since it carries a per-request nonce.
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    // mic: voice test-call widget
    key: "Permissions-Policy",
    value: "camera=(), geolocation=(), microphone=(self)",
  },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
];

/**
 * The document parsers run in a worker thread that requires them by path at
 * runtime (src/server/security/parser-security.ts), so the build's file
 * tracing can't see them: their files and every production dependency are
 * listed here for the routes that parse documents. pdf-parse loads its pinned
 * pdf.js build by a computed path; only that version is included.
 * tests/unit/document-parser-build.test.ts checks the built traces against
 * package-lock.json.
 */
const DOCUMENT_PARSER_FILES = [
  "./node_modules/pdf-parse/package.json",
  "./node_modules/pdf-parse/lib/pdf-parse.js",
  "./node_modules/pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js",
  "./node_modules/pdf-parse/lib/pdf.js/v1.10.100/build/pdf.worker.js",
  "./node_modules/node-ensure/**/*",
  "./node_modules/mammoth/**/*",
  "./node_modules/@xmldom/xmldom/**/*",
  "./node_modules/base64-js/**/*",
  "./node_modules/bluebird/**/*",
  "./node_modules/core-util-is/**/*",
  "./node_modules/dingbat-to-unicode/**/*",
  "./node_modules/duck/**/*",
  "./node_modules/immediate/**/*",
  "./node_modules/inherits/**/*",
  "./node_modules/isarray/**/*",
  "./node_modules/jszip/**/*",
  "./node_modules/lie/**/*",
  "./node_modules/lop/**/*",
  "./node_modules/option/**/*",
  "./node_modules/pako/**/*",
  "./node_modules/path-is-absolute/**/*",
  "./node_modules/process-nextick-args/**/*",
  "./node_modules/readable-stream/**/*",
  "./node_modules/safe-buffer/**/*",
  "./node_modules/setimmediate/**/*",
  "./node_modules/sprintf-js/**/*",
  "./node_modules/string_decoder/**/*",
  "./node_modules/underscore/**/*",
  "./node_modules/util-deprecate/**/*",
  "./node_modules/xmlbuilder/**/*",
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  serverExternalPackages: ["@prisma/client", "pino"],
  outputFileTracingIncludes: {
    "/api/v1/jobs/embed-document": DOCUMENT_PARSER_FILES,
    "/api/v1/business-dna/extract": DOCUMENT_PARSER_FILES,
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "*.supabase.co",
        pathname: "/storage/v1/object/public/**",
      },
      { protocol: "https", hostname: "lh3.googleusercontent.com" },
    ],
  },
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default withNextIntl(nextConfig);
