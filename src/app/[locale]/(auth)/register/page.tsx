import { getTranslations } from "next-intl/server";
import { inviteContinuation } from "@/lib/auth-redirect";
import { RegisterForm } from "./register-form";

export async function generateMetadata() {
  const t = await getTranslations("auth");
  return { title: t("register") };
}

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  // Only an invitation is carried through register; see inviteContinuation.
  const next = inviteContinuation((await searchParams).next);
  return <RegisterForm next={next} />;
}
