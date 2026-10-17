import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ChevronLeft, Mic, Plus, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { OrbitMark } from "./OrbitLogo";
import { people, type Speaker } from "./script";

export interface ChatMessage {
  id: number;
  who: Speaker;
  text: string;
  link?: boolean;
}

function Avatar({ who, className }: { who: Speaker; className?: string }) {
  if (who === "orbit") {
    return (
      <span className={cn("grid size-7 shrink-0 place-items-center rounded-full bg-[#0f1a30] ring-1 ring-white/10", className)}>
        <OrbitMark className="size-6 text-[#8daaff]" />
      </span>
    );
  }
  return (
    <span className={cn("grid size-7 shrink-0 place-items-center rounded-full text-[11px] font-semibold text-white", className)} style={{ backgroundColor: people[who].color }}>
      {people[who].name[0]}
    </span>
  );
}

function LinkCard() {
  return (
    <div className="w-56 overflow-hidden rounded-2xl border bg-card text-left">
      <div className="grid h-24 place-items-center bg-gradient-to-br from-[#2f5bd8] to-[#5b7cf5]">
        <div className="grid grid-cols-4 gap-1.5">
          {["#ef4444", "#facc15", "#ef4444", "#00000033", "#facc15", "#ef4444", "#facc15", "#ef4444"].map((c, i) => (
            <span key={i} className="size-4 rounded-full" style={{ backgroundColor: c }} />
          ))}
        </div>
      </div>
      <div className="px-3 py-2">
        <p className="text-[13px] font-semibold">Connect Four</p>
        <p className="text-[11px] text-muted-foreground">orbit.app</p>
      </div>
    </div>
  );
}

function TypingDots() {
  return (
    <span className="flex gap-1 px-1 py-1">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="size-2 rounded-full bg-muted-foreground/60"
          animate={{ y: [0, -4, 0], opacity: [0.5, 1, 0.5] }}
          transition={{ duration: 0.9, repeat: Infinity, delay: i * 0.15 }}
        />
      ))}
    </span>
  );
}

const bubbleIn = {
  initial: { opacity: 0, scale: 0.6, y: 14 },
  animate: { opacity: 1, scale: 1, y: 0 },
  exit: { opacity: 0, scale: 0.6 },
  transition: { type: "spring", stiffness: 520, damping: 30 },
} as const;

interface ChatPanelProps {
  messages: ChatMessage[];
  typing: Speaker | null;
  onReplay: () => void;
  className?: string;
}

/** The group's iMessage thread, filling in one bubble at a time. */
export function ChatPanel({ messages, typing, onReplay, className }: ChatPanelProps) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, typing]);

  const members: Speaker[] = ["maya", "jordan", "orbit", "priya"];
  return (
    <div className={cn("flex flex-col overflow-hidden rounded-[30px] border bg-card/85 shadow-[0_30px_120px_-30px_rgba(24,60,115,0.45)] backdrop-blur-xl", className)}>
      <div className="relative flex flex-col items-center gap-1 border-b px-4 pt-3 pb-2.5">
        <ChevronLeft className="absolute top-5 left-3 size-5 text-[#0a84ff]" aria-hidden />
        <button
          type="button"
          onClick={onReplay}
          className="absolute top-3.5 right-3 flex items-center gap-1 rounded-full px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <RotateCcw className="size-3.5" /> Replay
        </button>
        <div className="flex -space-x-2">
          {members.map((who) => (
            <Avatar key={who} who={who} className="size-8 ring-2 ring-card" />
          ))}
        </div>
        <p className="text-[13px] font-semibold">Game night 🎲</p>
        <p className="-mt-1 text-[11px] text-muted-foreground">You, Maya, Jordan, Priya & Orbit</p>
      </div>

      <div ref={list} className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-3 py-4 [scrollbar-width:none]">
        <AnimatePresence initial={false}>
          {messages.map((m, i) => {
            const mine = m.who === "you";
            const prev = messages[i - 1];
            const next = messages[i + 1];
            const firstInRun = prev?.who !== m.who;
            const lastInRun = next?.who !== m.who && !(typing === m.who && i === messages.length - 1);
            return (
              <motion.div key={m.id} layout {...bubbleIn} style={{ originX: mine ? 1 : 0, originY: 1 }} className={cn("flex flex-col", mine ? "items-end" : "items-start", firstInRun && i > 0 && "mt-2")}>
                {!mine && firstInRun && <span className="mb-0.5 ml-10 text-[11px] text-muted-foreground">{people[m.who].name}</span>}
                <div className={cn("flex items-end gap-2", mine && "flex-row-reverse")}>
                  {!mine && (lastInRun ? <Avatar who={m.who} /> : <span className="w-7 shrink-0" />)}
                  <div className="flex max-w-[78%] flex-col gap-1">
                    <div
                      className={cn(
                        "rounded-[20px] px-3.5 py-2 text-[14.5px] leading-snug",
                        mine ? "bg-[#0a84ff] text-white" : "bg-secondary text-foreground",
                        lastInRun && (mine ? "rounded-br-md" : "rounded-bl-md"),
                      )}
                    >
                      {m.text}
                    </div>
                    {m.link && <LinkCard />}
                  </div>
                </div>
              </motion.div>
            );
          })}
          {typing && (
            <motion.div key={`typing-${typing}`} layout {...bubbleIn} style={{ originX: typing === "you" ? 1 : 0, originY: 1 }} className={cn("mt-2 flex items-end gap-2", typing === "you" && "flex-row-reverse")}>
              {typing !== "you" && <Avatar who={typing} />}
              <div className={cn("rounded-[20px] px-3 py-2", typing === "you" ? "bg-[#0a84ff]" : "bg-secondary")}>
                <TypingDots />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="flex items-center gap-2 border-t px-3 py-2.5">
        <span className="grid size-8 place-items-center rounded-full bg-muted text-muted-foreground">
          <Plus className="size-4" />
        </span>
        <div className="flex flex-1 items-center justify-between rounded-full border px-3.5 py-1.5 text-sm text-muted-foreground">
          iMessage
          <Mic className="size-4" />
        </div>
      </div>
    </div>
  );
}
