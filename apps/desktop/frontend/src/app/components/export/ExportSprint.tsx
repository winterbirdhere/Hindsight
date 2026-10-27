import { Box } from "@mui/material";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { RewindLogo } from "../logo/RewindLogo";

/**
 * The sprint lane of the exporting view (mock `ExportSprint`, 18d): the app's record travels left to right with the
 * export's progress along a track with a pink trail, with speed streaks passing behind it. The mock's lane is 340 px
 * wide and driven by a demo timer; this one is `min(300px, 100%)` wide and driven by `fraction`.
 *
 * One `requestAnimationFrame` loop drives the record's turn (0.7° per ms), its jitter (only while `rendering`) and the
 * streaks, writing straight to the elements so React does not render per frame. Under `prefers-reduced-motion` there is
 * no loop: no streaks, a record that does not turn, and a position that still follows `fraction`.
 */

const LOGO_SIZE = 40;
/** The lane's width where it cannot be measured (no layout): its maximum. */
const FALLBACK_LANE_WIDTH = 300;
const LANE_HEIGHT = 62;
const DEGREES_PER_MS = 0.7;
const JITTER_PERIOD = 38;
const JITTER_PX = 0.9;

/** The mock's `SL`: eleven streaks with a height in the lane, a length, a speed (px per ms) and a phase. */
const STREAKS = Array.from({ length: 11 }, (_, i) => ({
  y: 6 + ((i * 37) % 34),
  len: 18 + ((i * 53) % 46),
  spd: 0.28 + ((i * 29) % 10) / 22,
  ph: (i * 97) % 340,
  pink: i % 4 === 0,
}));

const WHITE_STREAK = "linear-gradient(90deg, rgba(255,255,255,0), rgba(255,255,255,0.35))";
const PINK_STREAK = "linear-gradient(90deg, rgba(255,122,160,0), rgba(255,122,160,0.7))";
const TRACK = "rgba(255,255,255,0.12)";
const TRAIL = "linear-gradient(90deg, rgba(255,84,104,0), #ff5468 55%, #ff7aa0)";
const TRAIL_GLOW = "0 0 8px rgba(255,95,143,0.55)";

const readReducedMotion = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)")?.matches === true;

/** `prefers-reduced-motion: reduce`, following the system setting while mounted. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(readReducedMotion);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (!query) return undefined;
    const update = () => setReduced(query.matches === true);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);
  return reduced;
}

const clamp01 = (value: number) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);

export function ExportSprint({ fraction, rendering }: { fraction: number; rendering: boolean }) {
  const reduced = usePrefersReducedMotion();
  const laneRef = useRef<HTMLDivElement>(null);
  const recordRef = useRef<HTMLDivElement>(null);
  const streakRefs = useRef<Array<HTMLDivElement | null>>([]);
  const [laneWidth, setLaneWidth] = useState(FALLBACK_LANE_WIDTH);

  const progress = clamp01(fraction);
  // The loop starts once and reads what changes through refs, so progress never restarts it.
  const laneWidthRef = useRef(laneWidth);
  const progressRef = useRef(progress);
  const renderingRef = useRef(rendering);
  laneWidthRef.current = laneWidth;
  progressRef.current = progress;
  renderingRef.current = rendering;

  useLayoutEffect(() => {
    const lane = laneRef.current;
    if (!lane) return undefined;
    const measure = () => setLaneWidth(lane.clientWidth > 0 ? lane.clientWidth : FALLBACK_LANE_WIDTH);
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(lane);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (reduced) return undefined;
    const record = recordRef.current;
    if (!record) return undefined;
    const startedAt = performance.now();
    let cancelled = false;
    let frame = 0;

    const draw = (elapsed: number) => {
      const width = laneWidthRef.current;
      const live = renderingRef.current;
      const x = progressRef.current * Math.max(0, width - LOGO_SIZE);
      const jitter = live ? Math.sin(elapsed / JITTER_PERIOD) * JITTER_PX : 0;
      record.style.transform = `translateY(${jitter.toFixed(2)}px) rotate(${((elapsed * DEGREES_PER_MS) % 360).toFixed(1)}deg)`;
      STREAKS.forEach((streak, i) => {
        const element = streakRefs.current[i];
        if (!element) return;
        const left = width - ((elapsed * streak.spd + streak.ph) % (width + streak.len));
        const behind = left + streak.len < x + LOGO_SIZE * 0.5;
        element.style.transform = `translateX(${left.toFixed(1)}px)`;
        element.style.opacity = String((behind ? 1 : 0.35) * (live ? 1 : 0.4));
      });
    };
    const tick = () => {
      if (cancelled) return;
      draw(performance.now() - startedAt);
      frame = window.requestAnimationFrame(tick);
    };

    draw(0);
    frame = window.requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      record.style.transform = "";
    };
  }, [reduced]);

  const x = progress * Math.max(0, laneWidth - LOGO_SIZE);

  return (
    <Box
      ref={laneRef}
      aria-hidden="true"
      sx={{
        position: "relative",
        width: "min(300px, 100%)",
        height: LANE_HEIGHT,
        m: "10px 0 8px",
        overflow: "hidden",
      }}
    >
      {!reduced &&
        STREAKS.map((streak, i) => (
          <Box
            key={i}
            ref={(element: HTMLDivElement | null) => {
              streakRefs.current[i] = element;
            }}
            data-sprint-streak=""
            data-pink={streak.pink ? "true" : "false"}
            sx={{
              position: "absolute",
              left: 0,
              top: streak.y,
              width: streak.len,
              height: 1.5,
              borderRadius: "1px",
              background: streak.pink ? PINK_STREAK : WHITE_STREAK,
              // Out of sight until the first frame positions it.
              opacity: 0,
            }}
          />
        ))}
      <Box sx={{ position: "absolute", left: 0, right: 0, bottom: 8, height: 2, borderRadius: "1px", background: TRACK }} />
      <Box
        data-sprint-trail=""
        // Inline: the value changes with every percent, which would otherwise mint a stylesheet rule each time.
        style={{ width: x + LOGO_SIZE / 2 }}
        sx={{
          position: "absolute",
          left: 0,
          bottom: 8,
          height: 2,
          borderRadius: "1px",
          background: TRAIL,
          boxShadow: TRAIL_GLOW,
        }}
      />
      <Box
        ref={recordRef}
        data-sprint-record=""
        style={{ left: x }}
        sx={{ position: "absolute", bottom: 9, width: LOGO_SIZE, height: LOGO_SIZE }}
      >
        <RewindLogo variant="static" size={LOGO_SIZE} />
      </Box>
    </Box>
  );
}
