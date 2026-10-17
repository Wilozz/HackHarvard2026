import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { ArrowRight, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ChatPanel, type ChatMessage } from "./ChatPanel";
import { findWin, landingRow, turnOf, type GameConfig, type Piece } from "./connect-four";
import { GamePreview, type Phase } from "./GamePreview";
import { OrbitBackground } from "./OrbitBackground";
import { EnsembleLogo } from "./EnsembleLogo";
import { firstVersion, script, type Speaker } from "./script";

const STOP = Symbol("stop");
/** Stretches every pause in the script so each chat message and change has time to land. */
const PACE = 1.35;

const rise = (delay: number) => ({
  initial: { opacity: 0, y: 18, filter: "blur(6px)" },
  animate: { opacity: 1, y: 0, filter: "blur(0px)" },
  transition: { duration: 0.7, delay, ease: [0.22, 1, 0.36, 1] },
}) as const;

/**
 * The landing hero: a scripted iMessage group chat on one side and the app it
 * builds on the other. Every request in the chat changes the live game.
 */
export function Hero({ onStart }: { onStart: () => void }) {
  const [run, setRun] = useState(0);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [typing, setTyping] = useState<Speaker | null>(null);
  const [phase, setPhase] = useState<Phase>("empty");
  const [config, setConfig] = useState<GameConfig>(firstVersion);
  const [version, setVersion] = useState(0);
  const [pieces, setPieces] = useState<Piece[]>([]);
  const [toast, setToast] = useState<{ id: number; text: string }>();

  const configRef = useRef(config);
  configRef.current = config;
  // Set once a visitor plays; the script stops making moves for them.
  const playerTookOver = useRef(false);
  const nextId = useRef(0);

  const win = useMemo(() => findWin(pieces), [pieces]);

  const drop = useCallback((col: number) => {
    setPieces((current) => {
      const { rows } = configRef.current;
      if (findWin(current)) return current;
      const row = landingRow(current, col, rows);
      if (row < 0) return current;
      return [...current, { id: nextId.current++, col, row, player: turnOf(current) }];
    });
  }, []);

  const showToast = useCallback((text: string) => {
    const id = nextId.current++;
    setToast({ id, text });
    setTimeout(() => setToast((t) => (t?.id === id ? undefined : t)), 3200);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const sleep = (ms: number) =>
      new Promise<void>((resolve, reject) => {
        timers.push(setTimeout(() => (cancelled ? reject(STOP) : resolve()), ms * PACE));
      });

    setMessages([]);
    setTyping(null);
    setPhase("empty");
    setConfig(firstVersion);
    setVersion(0);
    setPieces([]);
    setToast(undefined);
    playerTookOver.current = false;

    (async () => {
      for (const step of script) {
        if (cancelled) return;
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
            await sleep(450);
            break;
          case "build":
            setPhase("building");
            await sleep(step.ms);
            setConfig(step.config);
            setVersion(1);
            setPhase("ready");
            showToast(step.note);
            await sleep(700);
            break;
          case "apply":
            setConfig((c) => ({ ...c, ...step.patch }));
            setVersion((v) => v + 1);
            showToast(step.note);
            await sleep(500);
            break;
          case "moves":
            for (const col of step.cols) {
              if (playerTookOver.current) break;
              drop(col);
              await sleep(step.gap);
            }
            break;
        }
      }
    })().catch((err) => {
      if (err !== STOP) throw err;
    });

    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [run, drop, showToast]);

  return (
    <section className="relative isolate overflow-hidden">
      <OrbitBackground />

      <header className="relative z-10 mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-6 sm:px-8">
        <EnsembleLogo />
        <Button onClick={onStart} className="rounded-full px-5">
          Start a group chat
        </Button>
      </header>

      <div className="relative z-10 mx-auto flex w-full max-w-6xl flex-col items-center px-5 pt-6 text-center sm:px-8 sm:pt-10">
        <motion.p {...rise(0.05)} className="mb-5 text-[11px] font-medium tracking-[0.36em] text-primary uppercase dark:text-[#8daaff]">
          Build apps from your group chat
        </motion.p>
        <motion.h1 {...rise(0.15)} className="max-w-4xl text-[clamp(44px,7vw,92px)] leading-[0.98] font-semibold tracking-[-0.055em]">
          Collaborative <em className="font-serif font-normal tracking-[-0.02em] text-primary italic dark:text-[#8daaff]">prompting.</em>
        </motion.h1>
        <motion.p {...rise(0.28)} className="mt-6 max-w-xl text-[clamp(16px,1.4vw,19px)] leading-relaxed text-muted-foreground">
          Text an idea to your iMessage group. Ensemble builds it into a real app, and every message after that changes it live.
        </motion.p>
        <motion.div {...rise(0.4)} className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Button size="lg" onClick={onStart} className="h-12 rounded-full px-7 text-base">
            Start a group chat <ArrowRight className="ml-1 size-4" />
          </Button>
          <Button size="lg" variant="ghost" onClick={() => setRun((r) => r + 1)} className="h-12 rounded-full px-6 text-base">
            <Play className="mr-1 size-4" /> Watch it build
          </Button>
        </motion.div>
      </div>

      <motion.div
        initial={{ opacity: 0, y: 40 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.9, delay: 0.5, ease: [0.22, 1, 0.36, 1] }}
        className="relative z-10 mx-auto mt-14 grid w-full max-w-6xl gap-5 px-5 pb-16 sm:px-8 lg:grid-cols-[1.35fr_1fr]"
      >
        <GamePreview
          className="h-[420px] sm:h-[540px]"
          phase={phase}
          version={version}
          toast={toast}
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
        <ChatPanel className="h-[480px] sm:h-[540px]" messages={messages} typing={typing} onReplay={() => setRun((r) => r + 1)} />
      </motion.div>
    </section>
  );
}
