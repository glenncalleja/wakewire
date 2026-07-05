import React from "react";
import { Composition } from "remotion";
import { WakeWireDemo, TOTAL_FRAMES } from "./WakeWireDemo";

export const Root: React.FC = () => (
  <Composition
    id="WakeWireDemo"
    component={WakeWireDemo}
    durationInFrames={TOTAL_FRAMES}
    fps={30}
    width={1920}
    height={1080}
  />
);
