import { motion, useReducedMotion, useTime, useTransform, type MotionValue } from "motion/react";
import { cn } from "@/lib/utils";

// The Ensemble mark: the group's speech bubble (with the rest of the group
// peeking from behind) and blocks stacking up inside it, like an app being
// built from the chat. Colors come from the theme: navy and very light blue.

const clamp = (v: number) => Math.min(1, Math.max(0, v));
/** 0 before `a`, 1 after `b`, smooth in between. */
const ease = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** Rounded rectangle centered on (cx, cy) with a speech-bubble tail at the bottom-left or bottom-right. */
function bubblePath(cx: number, cy: number, w: number, h: number, r: number, tail: "left" | "right") {
  const x = cx - w / 2;
  const y = cy - h / 2;
  const top = `M${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h}`;
  const bottom =
    tail === "right"
      ? ` H${x + w - r * 0.6} Q${x + w + 1.5},${y + h + 3.5} ${x + w - r * 1.6},${y + h} H${x + r}`
      : ` H${x + r * 1.6} Q${x - 1.5},${y + h + 3.5} ${x + r * 0.6},${y + h} H${x + r}`;
  return `${top}${bottom} Q${x},${y + h} ${x},${y + h - r} V${y + r} Q${x},${y} ${x + r},${y} Z`;
}

// The main bubble's body, and three 7×7 blocks stacked as a small pyramid centered in it.
const BUBBLE = { cx: 18.5, cy: 21.5, w: 29, h: 23 };
const BLOCK = 7;
const GAP = 1.2;
const blocks = [
  { x: BUBBLE.cx - BLOCK - GAP / 2, y: BUBBLE.cy + GAP / 2, at: 0.08 },
  { x: BUBBLE.cx + GAP / 2, y: BUBBLE.cy + GAP / 2, at: 0.22 },
  { x: BUBBLE.cx - BLOCK / 2, y: BUBBLE.cy - BLOCK - GAP / 2, at: 0.36 },
];

function Block({ phase, block }: { phase: MotionValue<number>; block: (typeof blocks)[number] }) {
  // Each block drops into place in turn; all three clear together before the loop restarts.
  const k = useTransform(phase, (p) => ease(block.at, block.at + 0.12, p) * (1 - ease(0.84, 0.96, p)));
  const y = useTransform(k, (v) => block.y - (1 - v) * 7);
  return <motion.rect x={block.x} y={y} width={BLOCK} height={BLOCK} rx="2" className="fill-primary-foreground" opacity={k} />;
}

export function EnsembleMark({ className }: { className?: string }) {
  const time = useTime();
  const still = !!useReducedMotion();
  const phase = useTransform(time, (t) => (still ? 0.7 : (t % 3400) / 3400));
  // A small "done" pulse once the last block lands.
  const scale = useTransform(phase, (p) => 1 + 0.05 * Math.sin(clamp((p - 0.5) / 0.14) * Math.PI));
  return (
    <svg viewBox="0 0 40 40" className={cn("size-8 shrink-0 overflow-visible", className)} aria-hidden>
      {/* The rest of the group, peeking from behind */}
      <path d={bubblePath(25, 13, 21, 15, 6, "right")} className="fill-primary" opacity=".35" />
      <motion.g style={{ scale, originX: "20px", originY: "20px" }}>
        <path d={bubblePath(BUBBLE.cx, BUBBLE.cy, BUBBLE.w, BUBBLE.h, 7.5, "left")} className="fill-primary" />
        {blocks.map((b) => (
          <Block key={b.at} phase={phase} block={b} />
        ))}
      </motion.g>
    </svg>
  );
}

export function EnsembleLogo() {
  return (
    <a href="#" className="flex items-center gap-2.5 text-foreground" aria-label="Ensemble home">
      <EnsembleMark className="size-9" />
      <span className="flex flex-col leading-none">
        <span className="text-[26px] font-semibold tracking-[-0.06em]">ensemble</span>
        <span className="mt-1 text-[8px] font-medium tracking-[0.28em] text-muted-foreground uppercase">built by your group</span>
      </span>
    </a>
  );
}
