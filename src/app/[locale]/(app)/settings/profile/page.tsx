export const dynamic = "force-dynamic";

import { getTranslations } from "next-intl/server";
import { getTenantContext } from "@/server/auth/session";
import { unscopedPrisma } from "@/server/db/tenant";
import { ProfileForm } from "./profile-form";

export default async function ProfilePage() {
  const ctx = await getTenantContext();
  const t = await getTranslations("settingsProfile");
  const user = await unscopedPrisma.user.findUniqueOrThrow({
    where: { id: ctx.userId },
    select: { fullName: true, email: true, locale: true, timezone: true },
  });

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <ProfileForm
        initial={{
          fullName: user.fullName ?? "",
          email: user.email,
          locale: user.locale,
          timezone: user.timezone,
        }}
      />
    </div>
  );
}
