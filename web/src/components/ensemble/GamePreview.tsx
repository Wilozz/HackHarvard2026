import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Lock, RotateCcw, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { landingRow, turnOf, type GameConfig, type Piece } from "./connect-four";
import { EnsembleMark } from "./EnsembleLogo";

export type Phase = "empty" | "building" | "ready";

const spring = { type: "spring", stiffness: 190, damping: 24 } as const;

const codeLines = [
  "import { useState } from 'react'",
  "",
  "export default function ConnectFour() {",
  "  const [board, setBoard] = useState(emptyBoard(7, 6))",
  "  const [turn, setTurn] = useState<Player>('red')",
  "",
  "  function drop(col: number) {",
  "    const row = lowestOpenRow(board, col)",
  "    if (row < 0 || winner) return",
  "    setBoard(place(board, col, row, turn))",
  "  }",
  "",
  "  return <Board cells={board} onDrop={drop} />",
  "}",
];

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ w: entry.contentRect.width, h: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, size] as const;
}

function Building() {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setShown((n) => Math.min(n + 1, codeLines.length)), 210);
    return () => clearInterval(id);
  }, []);
  return (
    <motion.div
      key="building"
      className="flex size-full flex-col gap-4 p-6"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, scale: 0.97, filter: "blur(4px)" }}
    >
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Sparkles className="size-4 text-primary" />
        Claude is writing your game…
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-muted">
        <motion.div className="h-full rounded-full bg-primary" initial={{ width: "4%" }} animate={{ width: "100%" }} transition={{ duration: 3.3, ease: "easeInOut" }} />
      </div>
      <pre className="flex-1 overflow-hidden font-mono text-[12px] leading-6 text-muted-foreground">
        {codeLines.slice(0, shown).map((line, i) => (
          <motion.div key={i} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }}>
            <span className="mr-4 inline-block w-5 text-right opacity-40 select-none">{i + 1}</span>
            {line}
          </motion.div>
        ))}
      </pre>
    </motion.div>
  );
}

function Placeholder() {
  return (
    <motion.div key="empty" className="flex size-full flex-col items-center justify-center gap-3 text-center" exit={{ opacity: 0 }}>
      <motion.div animate={{ scale: [1, 1.06, 1] }} transition={{ duration: 2.4, repeat: Infinity }}>
        <EnsembleMark className="size-14 text-primary" />
      </motion.div>
      <p className="text-sm text-muted-foreground">Your group's app shows up here</p>
    </motion.div>
  );
}

interface BoardProps {
  config: GameConfig;
  pieces: Piece[];
  win: number[] | null;
  onDrop: (col: number) => void;
  onReset: () => void;
}

function Board({ config, pieces, win, onDrop, onReset }: BoardProps) {
  const [area, size] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = 10;
  const cell = Math.max(18, Math.min(62, Math.floor(Math.min((size.w - pad * 2) / config.cols, (size.h - pad * 2) / config.rows))));
  const width = config.cols * cell + pad * 2;
  const height = config.rows * cell + pad * 2;
  const disc = Math.round(cell * 0.8);
  const inset = (cell - disc) / 2;
  const at = (col: number, row: number) => ({ x: pad + col * cell + inset, y: pad + (config.rows - 1 - row) * cell + inset });
  const turn = turnOf(pieces);
  const winner = win ? pieces.find((p) => p.id === win[0])?.player : undefined;
  const ghostRow = hover !== null && !win ? landingRow(pieces, hover, config.rows) : -1;

  return (
    <motion.div key="board" className="flex size-full flex-col items-center gap-3 p-4 sm:p-5" initial={{ opacity: 0, scale: 0.9, y: 16 }} animate={{ opacity: 1, scale: 1, y: 0 }} transition={spring}>
      <div ref={area} className="flex min-h-0 w-full flex-1 items-center justify-center">
        {size.w > 0 && (
          <motion.div
            className="relative rounded-[22px] shadow-[0_24px_60px_-20px_rgba(20,40,120,0.55),inset_0_1px_0_rgba(255,255,255,0.18)]"
            initial={false}
            animate={{ width, height, backgroundColor: config.board }}
            transition={spring}
            onMouseLeave={() => setHover(null)}
          >
            {/* Holes */}
            {Array.from({ length: config.cols * config.rows }, (_, i) => {
              const col = i % config.cols;
              const row = Math.floor(i / config.cols);
              const { x, y } = at(col, row);
              return (
                <motion.div
                  key={`${col}-${row}`}
                  className="absolute top-0 left-0 rounded-full bg-black/30 shadow-[inset_0_3px_6px_rgba(0,0,0,0.35)]"
                  initial={{ x, y, width: disc, height: disc, scale: 0 }}
                  animate={{ x, y, width: disc, height: disc, scale: 1 }}
                  transition={{ ...spring, delay: Math.min(0.25, (col + row) * 0.015) }}
                />
              );
            })}

            {/* Where your piece would land */}
            {hover !== null && ghostRow >= 0 && (
              <motion.div
                className="absolute top-0 left-0 rounded-full"
                style={{ width: disc, height: disc, backgroundColor: config.colors[turn] }}
                initial={false}
                animate={{ ...at(hover, ghostRow), opacity: 0.35 }}
                transition={{ type: "spring", stiffness: 500, damping: 35 }}
              />
            )}

            {/* Pieces */}
            {pieces.map((p) => {
              const { x, y } = at(p.col, p.row);
              const winning = !!win?.includes(p.id);
              return (
                <motion.div
                  key={p.id}
                  className="absolute top-0 left-0 rounded-full"
                  style={{ boxShadow: "inset 0 -4px 0 rgba(0,0,0,0.18), inset 0 3px 0 rgba(255,255,255,0.35)" }}
                  initial={{ x, y: -disc * 1.4, width: disc, height: disc, opacity: 0, backgroundColor: config.colors[p.player] }}
                  animate={{
                    x,
                    y,
                    width: disc,
                    height: disc,
                    opacity: win && config.winGlow && !winning ? 0.35 : 1,
                    backgroundColor: config.colors[p.player],
                    scale: winning && config.winGlow ? [1, 1.12, 1] : 1,
                    filter: winning && config.winGlow ? `drop-shadow(0 0 ${cell * 0.25}px ${config.colors[p.player]})` : "drop-shadow(0 0 0px transparent)",
                  }}
                  transition={{
                    y: { type: "spring", stiffness: 420, damping: 18 },
                    opacity: { duration: 0.2 },
                    backgroundColor: { duration: 0.9 },
                    scale: winning && config.winGlow ? { duration: 1.1, repeat: Infinity } : spring,
                    default: spring,
                  }}
                />
              );
            })}

            {/* Click targets, one per column */}
            <div className="absolute inset-0 flex" style={{ padding: pad }}>
              {Array.from({ length: config.cols }, (_, col) => (
                <button
                  key={col}
                  type="button"
                  aria-label={`Drop a piece in column ${col + 1}`}
                  className="h-full flex-1 rounded-xl transition-colors hover:bg-white/8 focus-visible:bg-white/10 focus-visible:outline-none"
                  onMouseEnter={() => setHover(col)}
                  onFocus={() => setHover(col)}
                  onClick={() => onDrop(col)}
                />
              ))}
            </div>
          </motion.div>
        )}
      </div>

      <div className="flex h-8 w-full items-center justify-between text-sm">
        <AnimatePresence mode="wait">
          <motion.div
            key={win ? `win-${winner}` : `turn-${turn}-${config.names[turn]}`}
            className="flex items-center gap-2 font-medium"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
          >
            <motion.span className="size-3.5 rounded-full" animate={{ backgroundColor: config.colors[winner ?? turn] }} />
            {win && winner !== undefined ? `${config.names[winner]} wins!` : `${config.names[turn]}'s turn`}
          </motion.div>
        </AnimatePresence>
        <button type="button" onClick={onReset} className="flex items-center gap-1.5 rounded-full px-3 py-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
          <RotateCcw className="size-3.5" />
          {win ? "Play again" : "Reset"}
        </button>
      </div>
    </motion.div>
  );
}

interface GamePreviewProps extends BoardProps {
  phase: Phase;
  version: number;
  toast?: { id: number; text: string };
  className?: string;
}

/** A browser window showing the app Ensemble built, updated live as the chat asks for changes. */
export function GamePreview({ phase, version, toast, className, ...board }: GamePreviewProps) {
  return (
    <div className={cn("relative flex flex-col overflow-hidden rounded-[26px] border bg-card/85 shadow-[0_30px_120px_-30px_rgba(24,60,115,0.45)] backdrop-blur-xl", className)}>
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <div className="flex gap-1.5">
          <span className="size-3 rounded-full bg-[#ff5f57]" />
          <span className="size-3 rounded-full bg-[#febc2e]" />
          <span className="size-3 rounded-full bg-[#28c840]" />
        </div>
        <div className="flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
          <Lock className="size-3 shrink-0" />
          <span className="truncate">ensemble.app/p/connect-four</span>
        </div>
        <AnimatePresence mode="popLayout">
          {phase === "ready" && (
            <motion.span
              key={version}
              className="rounded-full bg-primary/15 px-2.5 py-1 text-xs font-semibold text-primary dark:text-[#8daaff]"
              initial={{ opacity: 0, scale: 0.6, y: -8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.6, y: 8 }}
              transition={{ type: "spring", stiffness: 500, damping: 25 }}
            >
              v{version}
            </motion.span>
          )}
        </AnimatePresence>
      </div>

      <div className="relative min-h-0 flex-1">
        <AnimatePresence mode="wait">
          {phase === "empty" && <Placeholder />}
          {phase === "building" && <Building />}
          {phase === "ready" && <Board {...board} />}
        </AnimatePresence>

        <AnimatePresence>
          {toast && (
            <motion.div
              key={toast.id}
              className="absolute top-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border bg-popover/95 px-3 py-1.5 text-xs font-medium whitespace-nowrap shadow-lg"
              initial={{ opacity: 0, y: -12, scale: 0.9 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -12, scale: 0.9 }}
              transition={{ type: "spring", stiffness: 420, damping: 28 }}
            >
              <Sparkles className="size-3.5 text-primary" />
              {toast.text}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
