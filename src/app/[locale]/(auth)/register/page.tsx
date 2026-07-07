import { getTranslations } from "next-intl/server";
import { RegisterForm } from "./register-form";

export async function generateMetadata() {
  const t = await getTranslations("auth");
  return { title: t("register") };
}

export default function RegisterPage() {
  return <RegisterForm />;
}
