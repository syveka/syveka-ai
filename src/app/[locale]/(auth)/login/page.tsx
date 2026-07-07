import { getTranslations } from "next-intl/server";
import { LoginForm } from "./login-form";

export async function generateMetadata() {
  const t = await getTranslations("auth");
  return { title: t("login") };
}

export default function LoginPage() {
  return <LoginForm />;
}
