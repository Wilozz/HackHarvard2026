import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { RotateCcw, Sparkles, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { landingRow, turnOf, type GameConfig, type Piece } from "./connect-four";
import { EnsembleMark } from "./EnsembleLogo";

export type Phase = "empty" | "building" | "ready";

const spring = { type: "spring", stiffness: 190, damping: 24 } as const;

const codeLines = [
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
      className="flex size-full max-w-lg flex-col justify-center gap-4"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, scale: 0.96, filter: "blur(6px)" }}
    >
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Sparkles className="size-4 text-primary" />
        Claude is writing your game…
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-foreground/10">
        <motion.div className="h-full rounded-full bg-primary" initial={{ width: "4%" }} animate={{ width: "100%" }} transition={{ duration: 3, ease: "easeInOut" }} />
      </div>
      <pre className="overflow-hidden font-mono text-[12px] leading-6 text-muted-foreground">
        {codeLines.slice(0, shown).map((line, i) => (
          <motion.div key={i} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }}>
            {line || " "}
          </motion.div>
        ))}
      </pre>
    </motion.div>
  );
}

function Placeholder() {
  return (
    <motion.div key="empty" className="flex flex-col items-center gap-3 text-center" exit={{ opacity: 0, scale: 0.9 }}>
      <motion.div animate={{ scale: [1, 1.06, 1] }} transition={{ duration: 2.4, repeat: Infinity }}>
        <EnsembleMark className="size-16" />
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
}

function Board({ config, pieces, win, onDrop }: BoardProps) {
  const [area, size] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = 10;
  const cell = Math.max(16, Math.min(64, Math.floor(Math.min((size.w - pad * 2) / config.cols, (size.h - pad * 2) / config.rows))));
  const width = config.cols * cell + pad * 2;
  const height = config.rows * cell + pad * 2;
  const disc = Math.round(cell * 0.8);
  const inset = (cell - disc) / 2;
  const at = (col: number, row: number) => ({ x: pad + col * cell + inset, y: pad + (config.rows - 1 - row) * cell + inset });
  const turn = turnOf(pieces);
  const ghostRow = hover !== null && !win ? landingRow(pieces, hover, config.rows) : -1;

  return (
    <motion.div key="board" ref={area} className="flex size-full items-center justify-center" initial={{ opacity: 0, scale: 0.85, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} transition={spring}>
      {size.w > 0 && (
        <motion.div
          className="relative rounded-[22px] shadow-[0_30px_60px_-24px_rgba(20,40,120,0.6),inset_0_1px_0_rgba(255,255,255,0.18)]"
          initial={false}
          animate={{ width, height, backgroundColor: config.board }}
          transition={spring}
          onMouseLeave={() => setHover(null)}
        >
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
                transition={{ ...spring, delay: Math.min(0.3, (col + row) * 0.02) }}
              />
            );
          })}

          {hover !== null && ghostRow >= 0 && (
            <motion.div
              className="absolute top-0 left-0 rounded-full"
              style={{ width: disc, height: disc, backgroundColor: config.colors[turn] }}
              initial={false}
              animate={{ ...at(hover, ghostRow), opacity: 0.35 }}
              transition={{ type: "spring", stiffness: 500, damping: 35 }}
            />
          )}

          {pieces.map((p) => {
            const { x, y } = at(p.col, p.row);
            const winning = !!win?.includes(p.id);
            const glow = winning && config.winGlow;
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
                  scale: glow ? [1, 1.12, 1] : 1,
                  filter: glow ? `drop-shadow(0 0 ${cell * 0.25}px ${config.colors[p.player]})` : "drop-shadow(0 0 0px transparent)",
                }}
                transition={{
                  y: { type: "spring", stiffness: 420, damping: 18 },
                  opacity: { duration: 0.2 },
                  backgroundColor: { duration: 0.9 },
                  scale: glow ? { duration: 1.1, repeat: Infinity } : spring,
                  default: spring,
                }}
              />
            );
          })}

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
    </motion.div>
  );
}

/** Floating white card in a corner of the stage, like the stat cards in a game lobby. */
function StatCard({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("rounded-[22px] bg-card/90 px-4 py-3 text-foreground shadow-[0_12px_40px_-12px_rgba(11,21,48,0.35)] backdrop-blur", className)}>
      {children}
    </div>
  );
}

export interface Change {
  version: number;
  title: string;
  by: string;
}

interface GameStageProps extends BoardProps {
  phase: Phase;
  change?: Change;
  showChange: boolean;
  people: number;
  onReset: () => void;
  className?: string;
}

/** The app the group is building, on a softly lit stage with its latest change called out. */
export function GameStage({ phase, change, showChange, people, onReset, className, ...board }: GameStageProps) {
  const turn = turnOf(board.pieces);
  const winner = board.win ? board.pieces.find((p) => p.id === board.win![0])?.player : undefined;
  return (
    <div className={cn("relative size-full overflow-hidden bg-[radial-gradient(ellipse_at_50%_42%,#ffffff_0%,#e6efff_62%,#d5e4ff_100%)] dark:bg-[radial-gradient(ellipse_at_50%_42%,#1b2f5c_0%,#12224a_60%,#0b1530_100%)]", className)}>
      {/* Top row: whose turn, and the version */}
      <div className="absolute inset-x-4 top-4 z-10 flex items-start justify-between gap-3 sm:inset-x-5 sm:top-5">

        <AnimatePresence>
          {phase === "ready" && (
            <motion.div
              className="flex items-center gap-2 rounded-full bg-card/80 py-1.5 pr-1.5 pl-3 text-sm font-medium text-foreground shadow-sm backdrop-blur"
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
            >
              <motion.span className="size-3 rounded-full" animate={{ backgroundColor: board.config.colors[winner ?? turn] }} />
              {board.win && winner !== undefined ? `${board.config.names[winner]} wins!` : `${board.config.names[turn]}'s turn`}
              <button type="button" onClick={onReset} aria-label={board.win ? "Play again" : "Reset the board"} className="grid size-7 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10">
                <RotateCcw className="size-3.5" />
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="ml-auto grid size-11 shrink-0 place-items-center rounded-[14px] border-2 border-primary/70 bg-card/70 text-sm font-bold text-foreground backdrop-blur">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span key={change?.version ?? 0} initial={{ y: 14, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -14, opacity: 0 }} transition={{ type: "spring", stiffness: 500, damping: 28 }}>
              {change ? `v${change.version}` : "–"}
            </motion.span>
          </AnimatePresence>
        </div>
      </div>

      {/* The app itself */}
      <div className="absolute inset-x-4 top-[76px] bottom-[96px] flex items-center justify-center sm:inset-x-8 sm:bottom-[108px]">
        <AnimatePresence mode="wait">
          {phase === "empty" && <Placeholder />}
          {phase === "building" && <Building />}
          {phase === "ready" && <Board {...board} />}
        </AnimatePresence>
      </div>

      {/* Bottom corners: what just changed, and who's prompting */}
      <AnimatePresence>
        {showChange && change && (
          <motion.div
            key={change.version}
            className="absolute bottom-4 left-4 z-10 sm:bottom-5 sm:left-5"
            initial={{ opacity: 0, y: 24, scale: 0.92 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 24, scale: 0.92 }}
            transition={{ type: "spring", stiffness: 300, damping: 26, delay: 0.15 }}
          >
            <StatCard className="min-w-44">
              <p className="text-[19px] leading-tight font-semibold tracking-[-0.02em]">{change.title}</p>
              <p className="mt-1.5 text-xs text-muted-foreground">
                v{change.version} · asked by {change.by}
              </p>
            </StatCard>
          </motion.div>
        )}
      </AnimatePresence>

      <StatCard className="absolute right-5 bottom-5 z-10 hidden min-w-36 flex-col sm:flex">
        <span className="flex items-center justify-between gap-6">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span key={people} className="text-[26px] leading-none font-semibold tracking-[-0.03em]" initial={{ y: 12, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -12, opacity: 0 }}>
              {people}
            </motion.span>
          </AnimatePresence>
          <Users className="size-4 text-muted-foreground" />
        </span>
        <span className="mt-2 text-xs font-medium">People prompting</span>
      </StatCard>
    </div>
  );
}
