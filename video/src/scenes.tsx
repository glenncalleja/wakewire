import React from "react";
import { interpolate, useCurrentFrame, spring, useVideoConfig } from "remotion";
import { C, MONO, SOURCE_COLOR } from "./theme";
import { Terminal, Typewriter, FadeIn } from "./primitives";

/* ── Scene 1: the polling-loop pain ───────────────────────────────── */
export const ScenePain: React.FC = () => {
  const frame = useCurrentFrame();
  // three poll iterations land in the first ~1.5s, then the loop idles
  const iters = Math.min(3, Math.floor(frame / 15) + 1);
  const lines: string[] = [];
  for (let i = 0; i < iters; i++) {
    lines.push(`$ check-for-new-events.sh        # polling every 30s`);
    lines.push(`  …nothing. sleeping 30s`);
  }
  const blink = Math.floor(frame / 15) % 2 === 0;
  return (
    <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <Terminal title="your agent, on a timer" style={{ width: 1180, height: 600 }}>
        <div style={{ fontSize: 26, lineHeight: 1.75 }}>
          {lines.map((l, i) => (
            <div key={i} style={{ color: l.startsWith("$") ? C.text : C.dim }}>
              {l}
            </div>
          ))}
          <div style={{ color: C.text }}>
            $ check-for-new-events.sh <span style={{ color: C.green }}>{blink ? "▋" : " "}</span>
          </div>
        </div>
        {/* punchline fades in early (~2s) and holds for the rest of the scene */}
        <FadeIn start={58} style={{ position: "absolute", bottom: 34, left: 26 }}>
          <span style={{ fontSize: 26, color: C.amber }}>
            ↻ polling burns tokens, adds latency, and still misses things.
          </span>
        </FadeIn>
      </Terminal>
    </div>
  );
};

/* ── Scene 2 / outro: title card ──────────────────────────────────── */
export const SceneTitle: React.FC<{ subtitle?: string; footer?: string }> = ({
  subtitle = "push external events straight into your Codex threads — no polling",
  footer,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame, fps, config: { damping: 200 } });
  const scale = interpolate(s, [0, 1], [0.92, 1]);
  const glow = interpolate(frame, [0, 20, 40], [0, 1, 0.85], { extrapolateRight: "clamp" });
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 26,
      }}
    >
      <div style={{ transform: `scale(${scale})`, textAlign: "center" }}>
        <div
          style={{
            fontFamily: MONO,
            fontSize: 128,
            fontWeight: 700,
            color: C.white,
            letterSpacing: -1,
            textShadow: `0 0 ${40 * glow}px rgba(78,201,165,${0.5 * glow})`,
          }}
        >
          WakeWire
        </div>
      </div>
      <FadeIn start={16}>
        <div style={{ fontFamily: MONO, fontSize: 44, color: C.green, letterSpacing: 4 }}>
          Break the loop.
        </div>
      </FadeIn>
      <FadeIn start={30}>
        <div style={{ fontFamily: MONO, fontSize: 27, color: C.dim, marginTop: 10 }}>{subtitle}</div>
      </FadeIn>
      {footer && (
        <FadeIn start={46}>
          <div style={{ fontFamily: MONO, fontSize: 26, color: C.text, marginTop: 18 }}>
            <span style={{ color: C.green }}>$</span> {footer}
          </div>
        </FadeIn>
      )}
    </div>
  );
};

/* closing reprise — same card, with the install line as the last thing on screen */
export const SceneOutro: React.FC = () => (
  <SceneTitle subtitle="GitHub · Gmail · Slack · any webhook → your agent" footer="npm install -g wakewire" />
);

/* ── Scene 3: the money shot — an email wakes the agent, streaming live ── */
const AGENT_REPLY =
  "IMPORTANT — the deploy window was moved to 6pm. Drafted a reply confirming " +
  "you'll cut the release after standup. Say the word and I'll send it.";

export const SceneLive: React.FC = () => {
  const frame = useCurrentFrame();

  // token-streamed agent reply: reveal words over time
  const words = AGENT_REPLY.split(" ");
  const streamStart = 96;
  const wordsShown = Math.max(0, Math.floor((frame - streamStart) / 2.1));
  const streamed = words.slice(0, wordsShown).join(" ");
  const streaming = frame >= streamStart && wordsShown < words.length;

  return (
    <div style={{ width: "100%", height: "100%", padding: 70, display: "flex", flexDirection: "column", gap: 22 }}>
      <FadeIn start={0}>
        <div style={{ fontFamily: MONO, fontSize: 24, color: C.dim }}>
          $ codex --remote ws://127.0.0.1:4571
          <span style={{ color: C.dim }}>   # a live view of your thread</span>
        </div>
      </FadeIn>

      <Terminal title="codex · email-triage thread" accent="#243042" style={{ flex: 1 }}>
        <div style={{ fontSize: 25, lineHeight: 1.65 }}>
          {/* the wake event arriving */}
          <FadeIn start={30}>
            <div style={{ color: C.red }}>
              ● Gmail label:agent-inbox — a message arrived{" "}
              <span style={{ color: C.dim }}>(2s ago)</span>
            </div>
          </FadeIn>
          <FadeIn start={44}>
            <div style={{ color: C.dim, marginTop: 6, paddingLeft: 18, borderLeft: `2px solid ${C.panelBorder}` }}>
              from: ops@company.com · subj: "deploy window moved"
            </div>
          </FadeIn>

          {/* the agent turn, streaming in */}
          <FadeIn start={78} style={{ marginTop: 26 }}>
            <div style={{ color: C.green }}>codex ▸ triaging…</div>
          </FadeIn>
          {frame >= streamStart && (
            <div style={{ color: C.text, marginTop: 12, maxWidth: 1400 }}>
              {streamed}
              {streaming && <span style={{ color: C.green }}>{Math.floor(frame / 6) % 2 ? "▋" : ""}</span>}
            </div>
          )}
        </div>

        <FadeIn start={2} style={{ position: "absolute", top: 18, right: 22 }}>
          <span style={{ fontSize: 19, color: C.green, border: `1px solid ${C.green}44`, borderRadius: 20, padding: "4px 14px" }}>
            ● live
          </span>
        </FadeIn>
      </Terminal>
    </div>
  );
};

/* ── Scene 4: sources + guarantees ────────────────────────────────── */
export const SceneSources: React.FC = () => {
  const sources = ["GitHub", "Gmail", "Slack", "Linear"];
  const guarantees = [
    "signed & verified",
    "deduped",
    "queued — never lost",
    "fenced as untrusted",
  ];
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 60,
      }}
    >
      <div style={{ display: "flex", gap: 26 }}>
        {sources.map((s, i) => (
          <FadeIn key={s} start={i * 7} y={26}>
            <div
              style={{
                fontFamily: MONO,
                fontSize: 34,
                color: SOURCE_COLOR[s],
                border: `1px solid ${SOURCE_COLOR[s]}55`,
                background: `${SOURCE_COLOR[s]}12`,
                borderRadius: 12,
                padding: "18px 34px",
              }}
            >
              {s}
            </div>
          </FadeIn>
        ))}
        <FadeIn start={30} y={26}>
          <div
            style={{
              fontFamily: MONO,
              fontSize: 34,
              color: C.dim,
              border: `1px dashed ${C.panelBorder}`,
              borderRadius: 12,
              padding: "18px 30px",
            }}
          >
            + any webhook
          </div>
        </FadeIn>
      </div>

      <FadeIn start={40}>
        <div style={{ fontFamily: MONO, fontSize: 30, color: C.green }}>→ your Codex threads</div>
      </FadeIn>

      <div style={{ display: "flex", gap: 40, marginTop: 14 }}>
        {guarantees.map((g, i) => (
          <FadeIn key={g} start={52 + i * 6}>
            <div style={{ fontFamily: MONO, fontSize: 23, color: C.dim }}>
              <span style={{ color: C.green }}>✓</span> {g}
            </div>
          </FadeIn>
        ))}
      </div>
    </div>
  );
};

/* ── Scene 5: install card ────────────────────────────────────────── */
export const SceneInstall: React.FC = () => (
  <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
    <Terminal title="get started" accent="#243042" style={{ width: 1000, height: 420 }}>
      <div style={{ fontSize: 30, lineHeight: 2.0 }}>
        <div style={{ color: C.dim }}>
          <span style={{ color: C.green }}>$</span> npm install -g wakewire
        </div>
        <div style={{ color: C.dim }}>
          <span style={{ color: C.green }}>$</span> wakewire init && wakewire start
        </div>
        <div style={{ color: C.dim }}>
          <span style={{ color: C.green }}>$</span> <Typewriter text="# then set it up from inside Codex" startFrame={20} style={{ color: C.dim }} />
        </div>
      </div>
      <FadeIn start={64} style={{ position: "absolute", bottom: 30, left: 26, right: 26, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontFamily: MONO, fontSize: 26, color: C.white, fontWeight: 700 }}>WakeWire</span>
        <span style={{ fontFamily: MONO, fontSize: 22, color: C.green }}>Break the loop.</span>
      </FadeIn>
    </Terminal>
  </div>
);
