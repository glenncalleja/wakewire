import React from "react";
import { AbsoluteFill, Sequence, interpolate, useCurrentFrame } from "remotion";
import { C } from "./theme";
import { ScenePain, SceneTitle, SceneLive, SceneSources, SceneInstall } from "./scenes";

// 30fps. Scene lengths (frames) — total ≈ 38s.
const S = {
  pain: 165,
  title: 120,
  live: 330,
  sources: 165,
  install: 165,
} as const;

const XFADE = 18;
export const TOTAL_FRAMES =
  S.pain + S.title + S.live + S.sources + S.install - XFADE * 4;

/** Wrap a scene in a subtle cross-fade at its head and tail. */
const Scene: React.FC<{ dur: number; children: React.ReactNode }> = ({ dur, children }) => {
  const frame = useCurrentFrame();
  const o = interpolate(
    frame,
    [0, XFADE, dur - XFADE, dur],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  return <AbsoluteFill style={{ opacity: o }}>{children}</AbsoluteFill>;
};

export const WakeWireDemo: React.FC = () => {
  // scenes overlap by XFADE so the cross-fades blend
  let at = 0;
  const next = (dur: number) => {
    const from = at;
    at += dur - XFADE;
    return from;
  };
  const pain = next(S.pain);
  const title = next(S.title);
  const live = next(S.live);
  const sources = next(S.sources);
  const install = next(S.install);

  return (
    <AbsoluteFill style={{ background: `radial-gradient(120% 120% at 50% 0%, #0f1522 0%, ${C.bg} 60%)` }}>
      <Sequence from={pain} durationInFrames={S.pain}>
        <Scene dur={S.pain}><ScenePain /></Scene>
      </Sequence>
      <Sequence from={title} durationInFrames={S.title}>
        <Scene dur={S.title}><SceneTitle /></Scene>
      </Sequence>
      <Sequence from={live} durationInFrames={S.live}>
        <Scene dur={S.live}><SceneLive /></Scene>
      </Sequence>
      <Sequence from={sources} durationInFrames={S.sources}>
        <Scene dur={S.sources}><SceneSources /></Scene>
      </Sequence>
      <Sequence from={install} durationInFrames={S.install}>
        <Scene dur={S.install}><SceneInstall /></Scene>
      </Sequence>
    </AbsoluteFill>
  );
};
