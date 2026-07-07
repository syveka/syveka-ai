import { getTranslations } from "next-intl/server";
import { Card, CardContent } from "@/components/ui/card";
import { Link } from "@/i18n/routing";

export default async function VerifyPage() {
  const t = await getTranslations("auth");
  return (
    <Card>
      <CardContent className="space-y-4 pt-6 text-center text-sm">
        <p>{t("verifyEmailSent")}</p>
        <Link href="/login" className="text-primary hover:underline">
          {t("login")}
        </Link>
      </CardContent>
    </Card>
  );
}
