import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** EUR formatter — money is always integer cents (§5.1). */
export function formatCents(cents: number, locale: string, currency = "EUR"): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(cents / 100);
}

export function formatDate(date: Date | string, locale: string, opts?: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat(locale, opts ?? { dateStyle: "medium" }).format(new Date(date));
}

/** Stable slug for organizations. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 48);
}
