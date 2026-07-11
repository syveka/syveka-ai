export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";

export default function SettingsIndex() {
  redirect("/settings/profile");
}
