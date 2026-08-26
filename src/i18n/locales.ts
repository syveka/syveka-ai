export const APP_LOCALES = ["fi", "en", "ar"] as const;
export const DEFAULT_LOCALE = "fi" as const;
export type AppLocale = (typeof APP_LOCALES)[number];
