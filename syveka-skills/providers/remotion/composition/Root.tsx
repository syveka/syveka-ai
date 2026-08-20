import React from "react";
import { Composition } from "remotion";
// Extensionless - see the comment in ./entry.ts for why this differs from
// the rest of the repo's usual ".js"-suffixed relative imports.
import {
  SyvekaIntro,
  SYVEKA_INTRO_COMPOSITION_ID,
  SYVEKA_INTRO_DURATION_IN_FRAMES,
  SYVEKA_INTRO_FPS,
  SYVEKA_INTRO_HEIGHT,
  SYVEKA_INTRO_WIDTH,
} from "./SyvekaIntro";

/**
 * The full set of compositions this bundle exposes. This list IS the
 * allow-list: providers/remotion/render.ts only ever selects a composition
 * by an id that is validated (via providers/remotion/input-schema.ts)
 * against this exact set - there is no code path that lets a caller render
 * an id that isn't registered here.
 */
export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id={SYVEKA_INTRO_COMPOSITION_ID}
      component={SyvekaIntro}
      durationInFrames={SYVEKA_INTRO_DURATION_IN_FRAMES}
      fps={SYVEKA_INTRO_FPS}
      width={SYVEKA_INTRO_WIDTH}
      height={SYVEKA_INTRO_HEIGHT}
      defaultProps={{
        titleText: "Syveka AI",
        subtitleText: "Intelligent Workflows",
      }}
    />
  );
};
