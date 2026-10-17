import { motion, useReducedMotion, useTime, useTransform } from "motion/react";
import { cn } from "@/lib/utils";

/** A planet with a moon circling it on a tilted ring. */
export function OrbitMark({ className }: { className?: string }) {
  // One lap every 6 seconds along the ring (rx 17, ry 6.5).
  const time = useTime();
  const still = useReducedMotion();
  const angle = useTransform(time, (t) => (still ? 0.6 : (t / 6000) * Math.PI * 2));
  const cx = useTransform(angle, (a) => 20 + 17 * Math.cos(a));
  const cy = useTransform(angle, (a) => 20 + 6.5 * Math.sin(a));
  return (
    <svg viewBox="0 0 40 40" className={cn("size-8", className)} aria-hidden>
      <defs>
        <radialGradient id="orbit-core" cx="35%" cy="30%">
          <stop offset="0" stopColor="#9bb5ff" />
          <stop offset="1" stopColor="#4673eb" />
        </radialGradient>
      </defs>
      <circle cx="20" cy="20" r="9" fill="url(#orbit-core)" />
      <g transform="rotate(-24 20 20)">
        <ellipse cx="20" cy="20" rx="17" ry="6.5" fill="none" stroke="currentColor" strokeOpacity=".35" strokeWidth="1.2" />
        <motion.circle cx={cx} cy={cy} r="3.2" fill="#8daaff" />
      </g>
    </svg>
  );
}

export function OrbitLogo() {
  return (
    <a href="#" className="flex items-center gap-2.5 text-foreground" aria-label="Orbit home">
      <OrbitMark className="size-9 text-primary" />
      <span className="flex flex-col leading-none">
        <span className="text-[26px] font-semibold tracking-[-0.06em]">orbit</span>
        <span className="mt-1 text-[8px] font-medium tracking-[0.28em] text-muted-foreground uppercase">built by your group</span>
      </span>
    </a>
  );
}
