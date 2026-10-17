import { useReducedMotion, useTime, useTransform, motion, type MotionValue } from "motion/react";

// Slow, tilted orbit rings behind the hero. Each ring carries one small moon.

const rings = [
  { rx: 760, ry: 210, tilt: -8, period: 70, phase: 0.3, moon: 5 },
  { rx: 560, ry: 150, tilt: -8, period: 48, phase: 2.4, moon: 4 },
  { rx: 380, ry: 100, tilt: -8, period: 32, phase: 4.1, moon: 3.5 },
];

function Moon({ time, ring, still }: { time: MotionValue<number>; ring: (typeof rings)[number]; still: boolean }) {
  const angle = useTransform(time, (t) => ring.phase + (still ? 0 : (t / (ring.period * 1000)) * Math.PI * 2));
  const cx = useTransform(angle, (a) => ring.rx * Math.cos(a));
  const cy = useTransform(angle, (a) => ring.ry * Math.sin(a));
  return <motion.circle cx={cx} cy={cy} r={ring.moon} className="fill-[#8daaff]" filter="url(#moon-glow)" />;
}

export function OrbitBackground() {
  const time = useTime();
  const still = !!useReducedMotion();
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      <div className="absolute top-[-20%] left-1/2 h-[900px] w-[1300px] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgba(79,123,240,0.20),transparent)] dark:bg-[radial-gradient(closest-side,rgba(79,123,240,0.28),transparent)]" />
      <svg className="absolute top-[300px] left-1/2 h-[700px] w-[1700px] -translate-x-1/2" viewBox="-850 -350 1700 700">
        <defs>
          <filter id="moon-glow" x="-200%" y="-200%" width="500%" height="500%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        {rings.map((ring) => (
          <g key={ring.rx} transform={`rotate(${ring.tilt})`}>
            <ellipse rx={ring.rx} ry={ring.ry} fill="none" className="stroke-primary/20 dark:stroke-[#8daaff]/15" strokeWidth="1" strokeDasharray="2 7" />
            <Moon time={time} ring={ring} still={still} />
          </g>
        ))}
      </svg>
      <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-b from-transparent to-background" />
    </div>
  );
}
