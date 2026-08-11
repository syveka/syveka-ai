"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

/**
 * Dark mode (§9): class strategy, system default, persisted by next-themes.
 * `nonce` lets next-themes' inline FOUC-prevention script pass the
 * per-request CSP nonce set by src/middleware.ts.
 */
export function ThemeProvider({ children, nonce }: { children: React.ReactNode; nonce?: string }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      nonce={nonce}
    >
      {children}
    </NextThemesProvider>
  );
}
