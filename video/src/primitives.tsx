import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { C, MONO } from "./theme";

/** A macOS-style terminal window frame. */
export const Terminal: React.FC<{
  title: string;
  children: React.ReactNode;
  style?: React.CSSProperties;
  accent?: string;
}> = ({ title, children, style, accent = C.panelBorder }) => (
  <div
    style={{
      background: C.panel,
      border: `1px solid ${accent}`,
      borderRadius: 14,
      boxShadow: "0 40px 120px rgba(0,0,0,0.55)",
      overflow: "hidden",
      display: "flex",
      flexDirection: "column",
      ...style,
    }}
  >
    <div
      style={{
        height: 46,
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "0 18px",
        background: "#0d1119",
        borderBottom: `1px solid ${C.panelBorder}`,
      }}
    >
      {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
        <div key={c} style={{ width: 13, height: 13, borderRadius: 7, background: c }} />
      ))}
      <div
        style={{
          fontFamily: MONO,
          fontSize: 18,
          color: C.dim,
          marginLeft: 12,
          letterSpacing: 0.3,
        }}
      >
        {title}
      </div>
    </div>
    <div style={{ flex: 1, padding: 26, fontFamily: MONO, position: "relative" }}>
      {children}
    </div>
  </div>
);

/** Reveal `text` character-by-character between startFrame and startFrame+durationFrames. */
export const Typewriter: React.FC<{
  text: string;
  startFrame: number;
  cps?: number; // chars per second
  style?: React.CSSProperties;
  caret?: boolean;
}> = ({ text, startFrame, cps = 45, style, caret = true }) => {
  const frame = useCurrentFrame();
  const elapsed = Math.max(0, frame - startFrame);
  const shown = Math.min(text.length, Math.floor((elapsed / 30) * cps));
  const done = shown >= text.length;
  const blink = Math.floor(frame / 15) % 2 === 0;
  return (
    <span style={style}>
      {text.slice(0, shown)}
      {caret && (!done || blink) && (
        <span style={{ color: C.green, opacity: done && !blink ? 0 : 1 }}>▋</span>
      )}
    </span>
  );
};

/** Fade + rise in over `dur` frames starting at `start`. */
export const FadeIn: React.FC<{
  start: number;
  dur?: number;
  y?: number;
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ start, dur = 14, y = 16, children, style }) => {
  const frame = useCurrentFrame();
  const o = interpolate(frame, [start, start + dur], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const ty = interpolate(frame, [start, start + dur], [y, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return <div style={{ opacity: o, transform: `translateY(${ty}px)`, ...style }}>{children}</div>;
};
