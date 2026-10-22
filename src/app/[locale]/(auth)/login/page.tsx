import { getTranslations } from "next-intl/server";
import { inviteContinuation } from "@/lib/auth-redirect";
import { LoginForm } from "./login-form";

export async function generateMetadata() {
  const t = await getTranslations("auth");
  return { title: t("login") };
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[]; error?: string | string[] }>;
}) {
  const params = await searchParams;
  // Only an invitation is carried through login; see inviteContinuation.
  const next = inviteContinuation(params.next);
  return <LoginForm next={next} linkFailed={params.error === "auth_callback_failed"} />;
}
