import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { ChevronLeft, Pause, Play, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ChatPanel, type ChatMessage } from "./ChatPanel";
import { findWin, landingRow, turnOf, type GameConfig, type Piece } from "./connect-four";
import { EnsembleLogo } from "./EnsembleLogo";
import { GameStage, type Change, type Phase } from "./GamePreview";
import { firstVersion, script, scriptMs, timing, type Speaker } from "./script";

const STOP = Symbol("stop");
/** Stretches every pause in the script so each chat message and change has time to land. */
const PACE = 0.95;
const TICK = 50;
/** Gap between the card's edge and its panels, and between the two panels. */
const INSET = 10;

const panelSpring = { type: "spring", stiffness: 160, damping: 24, mass: 1 } as const;

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

/**
 * The landing hero: the slogan, then one card holding the app the group is
 * building and their iMessage thread. Each request opens the app to full view
 * to show the change, then folds back to the chat for the next message.
 */
export function Hero({ onStart }: { onStart: () => void }) {
  const [run, setRun] = useState(0);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [typing, setTyping] = useState<Speaker | null>(null);
  const [phase, setPhase] = useState<Phase>("empty");
  const [config, setConfig] = useState<GameConfig>(firstVersion);
  const [change, setChange] = useState<Change>();
  const [pieces, setPieces] = useState<Piece[]>([]);
  const [open, setOpen] = useState(false);
  const [paused, setPaused] = useState(false);
  const [progress, setProgress] = useState(0);

  const configRef = useRef(config);
  configRef.current = config;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const elapsed = useRef(0);
  // Set once a visitor plays; the script stops making moves for them.
  const playerTookOver = useRef(false);
  const nextId = useRef(0);

  const win = useMemo(() => findWin(pieces), [pieces]);
  const prompting = useMemo(() => new Set(messages.filter((m) => m.who !== "ensemble").map((m) => m.who)).size, [messages]);
  const total = scriptMs * PACE;
  const done = progress >= 1;

  const drop = useCallback((col: number) => {
    setPieces((current) => {
      if (findWin(current)) return current;
      const row = landingRow(current, col, configRef.current.rows);
      if (row < 0) return current;
      return [...current, { id: nextId.current++, col, row, player: turnOf(current) }];
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    // Waits `ms` of script time; the clock stops while paused.
    const sleep = (ms: number) =>
      new Promise<void>((resolve, reject) => {
        let left = ms * PACE;
        const tick = () => {
          if (cancelled) return reject(STOP);
          if (!pausedRef.current) {
            const step = Math.min(TICK, left);
            left -= step;
            elapsed.current += step;
          }
          if (left <= 0) return resolve();
          timers.push(setTimeout(tick, TICK));
        };
        tick();
      });

    setMessages([]);
    setTyping(null);
    setPhase("empty");
    setConfig(firstVersion);
    setChange(undefined);
    setPieces([]);
    setOpen(false);
    setPaused(false);
    setProgress(0);
    elapsed.current = 0;
    playerTookOver.current = false;
    const progressTimer = setInterval(() => setProgress(Math.min(1, elapsed.current / total)), 100);

    (async () => {
      let version = 0;
      for (const step of script) {
        switch (step.t) {
          case "wait":
            await sleep(step.ms);
            break;
          case "typing":
            setTyping(step.who);
            await sleep(step.ms);
            setTyping(null);
            break;
          case "say":
            setMessages((list) => [...list, { id: nextId.current++, who: step.who, text: step.text, link: step.link }]);
            await sleep(timing.say);
            break;
          case "view":
            setOpen(step.open);
            await sleep(timing.view);
            break;
          case "build":
            setPhase("building");
            await sleep(step.ms);
            setConfig(step.config);
            setPhase("ready");
            setChange({ version: ++version, title: step.title, by: step.by });
            await sleep(timing.buildSettle);
            break;
          case "apply":
            setConfig((c) => ({ ...c, ...step.patch }));
            setChange({ version: ++version, title: step.title, by: step.by });
            await sleep(timing.applySettle);
            break;
          case "moves":
            for (const [i, col] of step.cols.entries()) {
              if (playerTookOver.current) {
                // Keep the progress bar honest about the moves we skipped.
                elapsed.current += (step.cols.length - i) * step.gap * PACE;
                break;
              }
              drop(col);
              await sleep(step.gap);
            }
            break;
        }
      }
      // Stop the ticker first, or its rounding (0.9999…) overwrites "finished".
      clearInterval(progressTimer);
      setProgress(1);
    })().catch((err) => {
      if (err !== STOP) throw err;
    });

    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
      clearInterval(progressTimer);
    };
  }, [run, drop, total]);

  // Card geometry: side by side on wide screens, stacked on narrow ones.
  const [card, size] = useSize<HTMLDivElement>();
  const stacked = size.w > 0 && size.w < 760;
  const innerW = size.w - INSET * 2;
  const innerH = size.h - INSET * 2;
  const split = stacked ? Math.round(innerH * 0.5) : Math.round(innerW * 0.6);
  const gameSize = stacked ? { width: innerW, height: open ? innerH : split } : { width: open ? innerW : split, height: innerH };
  const chatBox = stacked
    ? { left: INSET, right: INSET, bottom: INSET, height: innerH - split - INSET }
    : { top: INSET, right: INSET, bottom: INSET, width: innerW - split - INSET };

  return (
    <section className="relative isolate overflow-hidden pb-10">
      <div className="pointer-events-none absolute top-[-30%] left-1/2 -z-10 h-[900px] w-[1300px] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgba(79,123,240,0.16),transparent)] dark:bg-[radial-gradient(closest-side,rgba(79,123,240,0.24),transparent)]" />

      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-6 sm:px-8">
        <EnsembleLogo />
        <Button onClick={onStart} className="rounded-full px-5">
          Start a group chat
        </Button>
      </header>

      <motion.h1
        initial={{ opacity: 0, y: 18, filter: "blur(8px)" }}
        animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
        transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
        className="px-5 pt-4 pb-10 text-center text-[clamp(48px,8vw,104px)] leading-[0.95] font-semibold tracking-[-0.055em] sm:pt-8 sm:pb-14"
      >
        Collaborative <em className="font-serif font-normal tracking-[-0.02em] text-primary italic dark:text-[#8daaff]">prompting.</em>
      </motion.h1>

      <motion.div
        initial={{ opacity: 0, y: 40 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.9, delay: 0.2, ease: [0.22, 1, 0.36, 1] }}
        className="mx-auto w-full max-w-6xl px-4 sm:px-8"
      >
        <div ref={card} className="relative h-[760px] overflow-hidden rounded-[44px] border bg-card shadow-[0_40px_120px_-40px_rgba(24,60,115,0.45)] sm:h-[600px]">
          {size.w > 0 && (
            <>
              <motion.div className="absolute" style={chatBox} animate={{ opacity: open ? 0.3 : 1, scale: open ? 0.97 : 1 }} transition={{ duration: 0.5 }}>
                <ChatPanel className="size-full" messages={messages} typing={typing} />
              </motion.div>

              <motion.div
                className="absolute top-[10px] left-[10px] z-10"
                initial={false}
                animate={gameSize}
                transition={panelSpring}
              >
                <GameStage
                  className="rounded-[34px]"
                  phase={phase}
                  change={change}
                  showChange={open}
                  people={prompting}
                  config={config}
                  pieces={pieces}
                  win={win}
                  onDrop={(col) => {
                    playerTookOver.current = true;
                    drop(col);
                  }}
                  onReset={() => {
                    playerTookOver.current = true;
                    setPieces([]);
                  }}
                />
                {/* Notched tab on the panel's edge: open or fold the app by hand. */}
                <button
                  type="button"
                  onClick={() => setOpen((o) => !o)}
                  aria-label={open ? "Show the group chat" : "Open the app full size"}
                  className={
                    stacked
                      ? "absolute bottom-0 left-1/2 grid h-7 w-14 -translate-x-1/2 place-items-center rounded-t-2xl bg-card text-muted-foreground transition-colors hover:text-foreground"
                      : "absolute top-1/2 right-0 grid h-14 w-7 -translate-y-1/2 place-items-center rounded-l-2xl bg-card text-muted-foreground transition-colors hover:text-foreground"
                  }
                >
                  <motion.span animate={{ rotate: stacked ? (open ? 90 : -90) : open ? 0 : 180 }} transition={{ type: "spring", stiffness: 300, damping: 22 }}>
                    <ChevronLeft className="size-4" />
                  </motion.span>
                </button>
              </motion.div>
            </>
          )}
        </div>

        {/* Play controls, like a video timeline */}
        <div className="mt-5 flex items-center gap-4 px-1">
          <button
            type="button"
            onClick={() => (done ? setRun((r) => r + 1) : setPaused((p) => !p))}
            aria-label={done ? "Replay" : paused ? "Play" : "Pause"}
            className="grid size-11 shrink-0 place-items-center rounded-full border bg-card text-foreground shadow-[0_8px_24px_-10px_rgba(24,60,115,0.45)] transition-transform hover:scale-105 active:scale-95"
          >
            {done ? <RotateCcw className="size-4" /> : paused ? <Play className="size-4 fill-current" /> : <Pause className="size-4 fill-current" />}
          </button>
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-foreground/10">
            <motion.div className="h-full rounded-full bg-gradient-to-r from-[#f472b6] to-primary" animate={{ width: `${progress * 100}%` }} transition={{ ease: "linear", duration: 0.1 }} />
          </div>
        </div>
      </motion.div>
    </section>
  );
}

