"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

/** Dark mode (§9): class strategy, system default, persisted by next-themes. */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      {children}
    </NextThemesProvider>
  );
}
