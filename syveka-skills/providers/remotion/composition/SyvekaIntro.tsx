import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

/**
 * The one approved composition for this milestone. Deliberately simple and
 * entirely self-contained: no network requests, no external fonts/images, no
 * user-supplied code - only two bounded text strings (validated by
 * ../input-schema.js before this component ever renders) are allowed to
 * vary. This is what "Remotion must remain a replaceable provider, not
 * arbitrary user-supplied code execution" looks like in practice: the set of
 * things a caller can influence is a fixed, small, typed surface.
 */
export interface SyvekaIntroProps extends Record<string, unknown> {
  titleText: string;
  subtitleText: string;
}

export const SYVEKA_INTRO_COMPOSITION_ID = "syveka-intro";
export const SYVEKA_INTRO_FPS = 30;
export const SYVEKA_INTRO_WIDTH = 1920;
export const SYVEKA_INTRO_HEIGHT = 1080;
export const SYVEKA_INTRO_DURATION_IN_FRAMES = 180; // 6s at 30fps

export const SyvekaIntro: React.FC<SyvekaIntroProps> = ({ titleText, subtitleText }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleScale = spring({
    frame,
    fps,
    config: { damping: 14, mass: 0.6 },
    durationInFrames: 24,
  });
  const titleOpacity = interpolate(frame, [0, 20], [0, 1], { extrapolateRight: "clamp" });
  const subtitleOpacity = interpolate(frame, [30, 55], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const subtitleShiftY = interpolate(frame, [30, 55], [16, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const bgShift = interpolate(frame, [0, SYVEKA_INTRO_DURATION_IN_FRAMES], [0, 60]);
  const fadeOut = interpolate(
    frame,
    [SYVEKA_INTRO_DURATION_IN_FRAMES - 20, SYVEKA_INTRO_DURATION_IN_FRAMES],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  return (
    <AbsoluteFill
      style={{
        backgroundImage: `radial-gradient(circle at ${50 + Math.sin(bgShift / 10) * 10}% ${50 + Math.cos(bgShift / 12) * 10}%, #1b2a4a 0%, #0a0f1f 70%)`,
        opacity: fadeOut,
        justifyContent: "center",
        alignItems: "center",
        fontFamily: "Arial, sans-serif",
      }}
    >
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
        <div
          style={{
            width: 180,
            height: 180,
            borderRadius: 40,
            background: "linear-gradient(135deg, #5b8cff 0%, #7b5bff 100%)",
            transform: `scale(${titleScale}) rotate(${interpolate(frame, [0, SYVEKA_INTRO_DURATION_IN_FRAMES], [0, 25])}deg)`,
            marginBottom: 48,
            boxShadow: "0 20px 60px rgba(91,140,255,0.35)",
          }}
        />
      </AbsoluteFill>
      <div
        style={{
          position: "absolute",
          textAlign: "center",
          color: "white",
          transform: `scale(${titleScale})`,
          opacity: titleOpacity,
        }}
      >
        <div style={{ fontSize: 84, fontWeight: 700, letterSpacing: -1 }}>{titleText}</div>
      </div>
      <div
        style={{
          position: "absolute",
          marginTop: 130,
          textAlign: "center",
          color: "#9fb3ff",
          fontSize: 36,
          fontWeight: 400,
          opacity: subtitleOpacity,
          transform: `translateY(${subtitleShiftY}px)`,
        }}
      >
        {subtitleText}
      </div>
    </AbsoluteFill>
  );
};
