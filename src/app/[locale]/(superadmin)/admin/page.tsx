export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";

export default function AdminIndex() {
  redirect("/admin/organizations" as never);
}
