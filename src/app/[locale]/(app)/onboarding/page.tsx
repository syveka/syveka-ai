export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getSessionUser, getTenantContextOrNull } from "@/server/auth/session";
import { OnboardingForm } from "./onboarding-form";

export default async function OnboardingPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  // Already has an org → straight to the app
  const ctx = await getTenantContextOrNull();
  if (ctx) redirect("/dashboard");

  return (
    <div className="mx-auto flex min-h-[70vh] w-full max-w-lg flex-col justify-center">
      <OnboardingForm />
    </div>
  );
}
