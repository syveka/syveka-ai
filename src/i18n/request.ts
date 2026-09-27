import { getRequestConfig } from "next-intl/server";
import { routing, type AppLocale } from "./routing";
import { DEFAULT_TIME_ZONE } from "@/lib/date-time";

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;

  const locale: AppLocale = routing.locales.includes(requested as AppLocale)
    ? (requested as AppLocale)
    : routing.defaultLocale;

  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
    timeZone: DEFAULT_TIME_ZONE,
  };
});
