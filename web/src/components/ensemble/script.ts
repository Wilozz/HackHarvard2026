import type { GameConfig } from "./connect-four";

// The hard-coded group chat that plays in the hero. Each request changes the
// live Connect Four preview next to it, the way Ensemble would rebuild the app.

export type Speaker = "you" | "maya" | "jordan" | "priya" | "ensemble";

export const people: Record<Speaker, { name: string; color: string }> = {
  you: { name: "You", color: "#0a84ff" },
  maya: { name: "Maya", color: "#ec4899" },
  jordan: { name: "Jordan", color: "#f59e0b" },
  priya: { name: "Priya", color: "#8b5cf6" },
  ensemble: { name: "Ensemble", color: "#4f7bf0" },
};

export type Step =
  | { t: "wait"; ms: number }
  | { t: "typing"; who: Speaker; ms: number }
  | { t: "say"; who: Speaker; text: string; link?: boolean }
  /** First build: shows the "writing code" view, then the game. */
  | { t: "build"; ms: number; config: GameConfig; note: string }
  /** A later request: the running game changes in place. */
  | { t: "apply"; patch: Partial<GameConfig>; note: string }
  /** Scripted moves, skipped once a visitor starts playing. */
  | { t: "moves"; cols: number[]; gap: number };

export const firstVersion: GameConfig = {
  cols: 7,
  rows: 6,
  colors: ["#ef4444", "#facc15"],
  names: ["Red", "Yellow"],
  board: "#2f5bd8",
  winGlow: false,
};

export const script: Step[] = [
  { t: "wait", ms: 700 },
  { t: "say", who: "you", text: "@Ensemble make us a Connect Four game" },
  { t: "typing", who: "ensemble", ms: 1100 },
  { t: "say", who: "ensemble", text: "On it. Building Connect Four…" },
  { t: "build", ms: 2600, config: firstVersion, note: "v1 · Connect Four is live" },
  { t: "say", who: "ensemble", text: "v1 is live. Tap to play 👇", link: true },
  { t: "moves", cols: [3, 4, 3, 2], gap: 650 },
  { t: "wait", ms: 500 },
  { t: "typing", who: "maya", ms: 1200 },
  { t: "say", who: "maya", text: "ok but can the pieces be pink and teal? 💅" },
  { t: "typing", who: "ensemble", ms: 900 },
  { t: "apply", patch: { colors: ["#f472b6", "#2dd4bf"], names: ["Pink", "Teal"] }, note: "v2 · Pink vs teal" },
  { t: "say", who: "ensemble", text: "Done. Pink vs teal ✨" },
  { t: "wait", ms: 600 },
  { t: "typing", who: "jordan", ms: 1100 },
  { t: "say", who: "jordan", text: "make the board bigger, like 8×7" },
  { t: "typing", who: "ensemble", ms: 900 },
  { t: "apply", patch: { cols: 8, rows: 7, board: "#3b4fd9" }, note: "v3 · Board is now 8×7" },
  { t: "say", who: "ensemble", text: "Bigger board, coming up. Now 8×7." },
  { t: "wait", ms: 600 },
  { t: "typing", who: "priya", ms: 1100 },
  { t: "say", who: "priya", text: "add a glow when someone wins 👀" },
  { t: "typing", who: "ensemble", ms: 900 },
  { t: "apply", patch: { winGlow: true }, note: "v4 · Winning line glows" },
  { t: "say", who: "ensemble", text: "Added a win glow. Watch:" },
  // Pink stacks four in the column the bigger board just added.
  { t: "moves", cols: [7, 0, 7, 1, 7, 0, 7], gap: 520 },
  { t: "wait", ms: 1200 },
  { t: "say", who: "ensemble", text: "Your turn. Tap any column to play." },
];
