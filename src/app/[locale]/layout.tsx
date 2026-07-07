import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { NextIntlClientProvider, hasLocale } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { Inter, IBM_Plex_Sans_Arabic } from "next/font/google";
import { routing, RTL_LOCALES } from "@/i18n/routing";
import { ThemeProvider } from "@/components/layout/theme-provider";
import { QueryProvider } from "@/components/layout/query-provider";
import "../globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });
const plexArabic = IBM_Plex_Sans_Arabic({
  subsets: ["arabic"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-arabic",
});

export const metadata: Metadata = {
  title: { default: "Syveka AI", template: "%s · Syveka AI" },
  description: "Tekoälyavustaja suomalaisille pk-yrityksille — AI assistant for Finnish SMBs.",
};

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);

  const dir = RTL_LOCALES.has(locale) ? "rtl" : "ltr";

  return (
    <html lang={locale} dir={dir} suppressHydrationWarning>
      <body className={`${inter.variable} ${plexArabic.variable} font-sans`}>
        <ThemeProvider>
          <NextIntlClientProvider>
            <QueryProvider>{children}</QueryProvider>
          </NextIntlClientProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
