import "server-only";

import { cache } from "react";
import { unscopedPrisma } from "@/server/db/tenant";
import { resolveDisplayTimeZone } from "@/lib/date-time";

/**
 * The IANA zone a signed-in viewer's times are shown in (policy:
 * src/lib/date-time.ts): their own profile timezone (`User.timezone`), or the
 * app default (Europe/Helsinki) when it is missing or unknown. Server-rendered
 * pages must pass it explicitly, since the server runtime itself runs in UTC.
 * Cached per request: several components of one page share a single read.
 */
export const getViewerTimeZone = cache(async (userId: string): Promise<string> => {
  const viewer = await unscopedPrisma.user.findUnique({
    where: { id: userId },
    select: { timezone: true },
  });
  return resolveDisplayTimeZone(viewer?.timezone);
});
