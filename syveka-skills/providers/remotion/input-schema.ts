import { z } from "zod";
import { SYVEKA_INTRO_COMPOSITION_ID } from "./composition/SyvekaIntro.js";

/**
 * The entire trust boundary between "whatever the caller/LLM agent says it
 * wants" and "what actually reaches Remotion/React/Chromium". Two
 * deliberate restrictions make arbitrary code execution impossible here:
 *
 * 1. `compositionId` is a z.literal enum of composition ids that are
 *    actually registered in composition/Root.tsx - not a free-text
 *    component name, not a file path, not anything that could be resolved
 *    to caller-controlled code. Adding a new composition means adding a
 *    reviewed .tsx file AND a new literal here; a caller can never smuggle
 *    in an id that maps to something unreviewed.
 * 2. Every other field is a length-capped string. No functions, no nested
 *    objects, no arrays - so even if this schema is passed straight through
 *    to React as props (which it is), there is no shape available to a
 *    caller that could be interpreted as executable code, and no plausible
 *    injection point for prompt-injection-style "instructions" hidden in
 *    the text to do anything except render as literal on-screen text.
 */
export const remotionRenderInputSchema = z
  .object({
    compositionId: z.literal(SYVEKA_INTRO_COMPOSITION_ID),
    titleText: z.string().min(1).max(80).optional(),
    subtitleText: z.string().min(1).max(160).optional(),
  })
  // .strict(), not the default .passthrough()-adjacent stripping behavior:
  // an unexpected key (e.g. an attempted `outputPath`, `assetUrl`, or
  // `chromiumFlags` override) is a hard rejection, not silently dropped -
  // fail closed on any input shape wider than what was actually reviewed.
  .strict();

export type RemotionRenderInput = z.infer<typeof remotionRenderInputSchema>;
