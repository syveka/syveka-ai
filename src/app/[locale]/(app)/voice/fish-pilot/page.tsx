export const dynamic = "force-dynamic";

import { notFound } from "next/navigation";
import { FishPilotDemo } from "@/components/voice/fish-pilot-demo";
import { requirePermission } from "@/server/auth/guard";
import { isFishVoicePilotEnabled } from "@/server/voice/fish-pilot/gate";

/** Developer tool, not found on every deployment, so it is not translated. */
export default async function FishVoicePilotPage() {
  if (!isFishVoicePilotEnabled()) notFound();
  await requirePermission("voice:configure");
  return <FishPilotDemo />;
}
