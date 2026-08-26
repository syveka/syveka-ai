export const dynamic = "force-dynamic";

import React from "react";
import { redirect } from "next/navigation";
import { localizedPath, normalizeLocale } from "@/lib/auth-redirect";
import { getSessionUser, getTenantContextOrNull } from "@/server/auth/session";
import { OnboardingForm } from "./onboarding-form";

export default async function OnboardingPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: rawLocale } = await params;
  const locale = normalizeLocale(rawLocale);
  const user = await getSessionUser();
  if (!user) redirect(localizedPath(locale, "/login"));

  const ctx = await getTenantContextOrNull();
  if (ctx) redirect(localizedPath(locale, "/dashboard"));

  return (
    <div className="mx-auto flex min-h-[70vh] w-full max-w-lg flex-col justify-center">
      <OnboardingForm />
    </div>
  );
}
