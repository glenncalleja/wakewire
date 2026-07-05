// Shared visual language — a calm, dark terminal palette.
export const C = {
  bg: "#0b0e14",
  panel: "#11151f",
  panelBorder: "#1e2530",
  text: "#c8d3e0",
  dim: "#5c6b7e",
  green: "#4ec9a5",
  blue: "#4aa3ff",
  amber: "#e6b450",
  red: "#e06c75",
  magenta: "#c586c0",
  white: "#f2f6fc",
} as const;

export const MONO =
  '"SF Mono", "JetBrains Mono", "Fira Code", Menlo, Consolas, monospace';

// Source accent colors, reused across scenes.
export const SOURCE_COLOR: Record<string, string> = {
  GitHub: C.blue,
  Gmail: C.red,
  Slack: C.magenta,
  Linear: C.amber,
};
