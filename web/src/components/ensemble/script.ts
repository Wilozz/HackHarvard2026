import type { GameConfig } from "./connect-four";

// The hard-coded group chat that plays in the hero. Each request opens the
// game panel to full view, shows the change, then folds back to the chat,
// the way Ensemble would rebuild the app.

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
  /** Open the game panel to full view, or fold it back to show the chat. */
  | { t: "view"; open: boolean }
  /** First build: shows the "writing code" view, then the game. */
  | { t: "build"; ms: number; config: GameConfig; title: string; by: string }
  /** A later request: the running game changes in place. */
  | { t: "apply"; patch: Partial<GameConfig>; title: string; by: string }
  /** Scripted moves, skipped once a visitor starts playing. */
  | { t: "moves"; cols: number[]; gap: number };

/** How long the runner pauses after each kind of step, before pacing. */
export const timing = { say: 500, view: 850, buildSettle: 700, applySettle: 600 };

export function stepMs(step: Step): number {
  switch (step.t) {
    case "wait":
    case "typing":
      return step.ms;
    case "say":
      return timing.say;
    case "view":
      return timing.view;
    case "build":
      return step.ms + timing.buildSettle;
    case "apply":
      return timing.applySettle;
    case "moves":
      return step.cols.length * step.gap;
  }
}

export const firstVersion: GameConfig = {
  cols: 7,
  rows: 6,
  colors: ["#ef4444", "#facc15"],
  names: ["Red", "Yellow"],
  board: "#2f5bd8",
  winGlow: false,
};

export const script: Step[] = [
  { t: "wait", ms: 600 },
  { t: "say", who: "you", text: "@Ensemble make us a Connect Four game" },
  { t: "typing", who: "ensemble", ms: 1000 },
  { t: "say", who: "ensemble", text: "On it 🛠️" },
  { t: "view", open: true },
  { t: "build", ms: 3000, config: firstVersion, title: "Connect Four", by: "You" },
  { t: "moves", cols: [3, 4, 3, 2], gap: 600 },
  { t: "wait", ms: 700 },
  { t: "view", open: false },
  { t: "say", who: "ensemble", text: "v1 is live. Tap to play 👇", link: true },
  { t: "wait", ms: 500 },

  { t: "typing", who: "maya", ms: 1100 },
  { t: "say", who: "maya", text: "ok but can the pieces be pink and teal? 💅" },
  { t: "typing", who: "ensemble", ms: 800 },
  { t: "view", open: true },
  { t: "apply", patch: { colors: ["#f472b6", "#2dd4bf"], names: ["Pink", "Teal"] }, title: "Pink vs teal", by: "Maya" },
  { t: "wait", ms: 1700 },
  { t: "view", open: false },
  { t: "say", who: "ensemble", text: "Done. Pink vs teal ✨" },

  { t: "typing", who: "jordan", ms: 1100 },
  { t: "say", who: "jordan", text: "make the board bigger, like 8×7" },
  { t: "typing", who: "ensemble", ms: 800 },
  { t: "view", open: true },
  { t: "apply", patch: { cols: 8, rows: 7, board: "#3b4fd9" }, title: "Bigger board, 8×7", by: "Jordan" },
  { t: "wait", ms: 1900 },
  { t: "view", open: false },
  { t: "say", who: "ensemble", text: "Bigger board, now 8×7." },

  { t: "typing", who: "priya", ms: 1100 },
  { t: "say", who: "priya", text: "add a glow when someone wins 👀" },
  { t: "typing", who: "ensemble", ms: 800 },
  { t: "view", open: true },
  { t: "apply", patch: { winGlow: true }, title: "Winning line glows", by: "Priya" },
  // Pink stacks four in the column the bigger board just added.
  { t: "moves", cols: [7, 0, 7, 1, 7, 0, 7], gap: 520 },
  { t: "wait", ms: 2000 },
  { t: "view", open: false },
  { t: "say", who: "ensemble", text: "Added a win glow. Your turn: tap a column to play." },
];

export const scriptMs = script.reduce((total, step) => total + stepMs(step), 0);
