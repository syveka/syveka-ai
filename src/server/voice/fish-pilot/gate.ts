/**
 * The pilot exists only on a developer's machine. An allowlist, not `!== "production"`:
 * `next start` keeps a NODE_ENV set at runtime, so anything but `next dev` must stay
 * closed. The literal `process.env.NODE_ENV` is what Next inlines at build time, which
 * compiles this to false in a production bundle whatever the runtime environment says.
 * This module imports nothing, so a closed gate loads no other code.
 */
export function isFishVoicePilotEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    process.env.NODE_ENV === "development" &&
    !env.VERCEL &&
    !env.VERCEL_ENV &&
    env.FISH_VOICE_PILOT_ENABLED === "1"
  );
}
