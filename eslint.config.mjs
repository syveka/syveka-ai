import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

export default [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
      // RTL safety (§20): physical-direction utilities are banned in feature code.
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "JSXAttribute[name.name='className'] Literal[value=/\\b(ml-|mr-|pl-|pr-|text-left|text-right|left-\\d|right-\\d)/]",
          message:
            "Use logical utilities (ms-/me-/ps-/pe-/text-start/text-end/start-/end-) for RTL support.",
        },
      ],
    },
  },
  {
    // Tenant-isolation guard (§4.3): raw prisma access only inside src/server/db.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/server/db/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/server/db/prisma",
              message: "Import tenantDb()/repositories from @/server/db instead of the raw client.",
            },
          ],
        },
      ],
    },
  },
];
