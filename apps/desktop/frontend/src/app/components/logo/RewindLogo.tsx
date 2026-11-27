import { useEffect, useId, useState } from "react";
import { LOGO_STATIC, logoFrame, trailPath, type LogoFrame } from "./logo-geometry";

export type RewindLogoVariant = "static" | "animated" | "broken";

export interface RewindLogoProps {
  variant?: RewindLogoVariant;
  size?: number;
}

const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)")?.matches === true;

const fmt = (n: number) => n.toFixed(2);

/** The two label triangles ("rewind" glyph), as the polygon point lists of card 14b / 7f. */
const LABEL_TRIANGLES = ["42.64,50 49.54,45.63 49.54,54.37", "49.54,50 56.44,45.63 56.44,54.37"];
const BROKEN_LABEL_TRIANGLES = ["42.18,50 49.08,45.63 49.08,54.37", "49.08,50 55.98,45.63 55.98,54.37"];

/** Frame of an animated logo: the final static frame under reduced motion, the faded first frame otherwise. */
function useLogoFrame(animated: boolean): LogoFrame {
  const [frame, setFrame] = useState<LogoFrame>(() =>
    animated && !prefersReducedMotion() ? logoFrame(0) : LOGO_STATIC,
  );

  useEffect(() => {
    if (!animated || prefersReducedMotion()) {
      setFrame(LOGO_STATIC);
      return undefined;
    }
    const start = performance.now();
    let cancelled = false;
    let id = 0;
    const tick = () => {
      if (cancelled) return;
      setFrame(logoFrame(performance.now() - start));
      id = window.requestAnimationFrame(tick);
    };
    setFrame(logoFrame(0));
    id = window.requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(id);
    };
  }, [animated]);

  return frame;
}

/**
 * The 14b mark: a vinyl disc, a pink cursor trail and a rewind label.
 * `animated` plays the 16a intro and then keeps the cursor turning; `broken` is the stopped mark of card 7f.
 */
export const RewindLogo = ({ variant = "static", size = 92 }: RewindLogoProps) => {
  const rawId = useId();
  const id = rawId.replace(/[^A-Za-z0-9_-]/g, "");
  const broken = variant === "broken";
  const frame = useLogoFrame(variant === "animated");
  const { d, head, tail } = trailPath(frame.headDeg, frame.spanDeg);
  const [hx, hy] = head;
  const [tx, ty] = tail;

  const shadow = broken
    ? "drop-shadow(0 8px 18px rgba(0,0,0,0.6))"
    : size >= 200
      ? "drop-shadow(0 10px 22px rgba(0,0,0,0.55))"
      : "drop-shadow(0 6px 14px rgba(0,0,0,0.55))";
  const grooveStroke = broken ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.07)";
  const labelColour = broken ? "#bdbab3" : "#fff";
  const triangles = broken ? BROKEN_LABEL_TRIANGLES : LABEL_TRIANGLES;

  return (
    <svg
      role="img"
      aria-label="Hindsight"
      width={size}
      height={size}
      viewBox="0 0 100 100"
      style={{ display: "block", overflow: "visible", filter: shadow }}
    >
      <defs>
        <radialGradient id={`${id}d`} cx={0.45} cy={0.3} r={0.8}>
          <stop offset={0} stopColor={broken ? "#2a2c33" : "#2e3039"} />
          <stop offset={1} stopColor="#0c0d10" />
        </radialGradient>
        <linearGradient id={`${id}t`} gradientUnits="userSpaceOnUse" x1={tx} y1={ty} x2={hx} y2={hy}>
          <stop offset={0} stopColor={broken ? "#6a6770" : "#ff5468"} stopOpacity={0} />
          <stop offset={1} stopColor={broken ? "#8a8690" : "#ff7aa0"} />
        </linearGradient>
        <filter id={`${id}g`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation={broken ? 3.2 : 3} />
        </filter>
      </defs>
      <g opacity={frame.discOpacity} transform={`translate(50 50) scale(${frame.discScale}) translate(-50 -50)`}>
        <circle cx={50} cy={50} r={46} fill={`url(#${id}d)`} />
        <circle cx={50} cy={50} r={41} fill="none" stroke={grooveStroke} strokeWidth={0.8} />
        <circle cx={50} cy={50} r={24} fill="none" stroke={grooveStroke} strokeWidth={0.8} />
        <path
          d={d}
          fill="none"
          stroke={`url(#${id}t)`}
          strokeWidth={11}
          strokeLinecap="round"
          opacity={broken ? 0.7 : undefined}
        />
        {broken ? (
          <g data-logo-miss transform={`translate(${fmt(hx)} ${fmt(hy)})`}>
            <circle r={12} fill="#ff5468" filter={`url(#${id}g)`} opacity={0.55} />
            <path d="M-7 -7 L7 7 M7 -7 L-7 7" stroke="#ff5468" strokeWidth={4.5} strokeLinecap="round" />
          </g>
        ) : (
          <g data-logo-cursor>
            <circle cx={hx} cy={hy} r={11} fill="#ff5f8f" filter={`url(#${id}g)`} opacity={frame.glowOpacity} />
            <circle cx={hx} cy={hy} r={7.5} fill="#fff" stroke="#ffb3c9" strokeWidth={2.5} />
          </g>
        )}
        <g
          opacity={frame.labelOpacity}
          transform={`translate(50 50) scale(${frame.labelScale}) translate(-50 -50)`}
        >
          <circle cx={50} cy={50} r={16} fill="#1c1d22" stroke={labelColour} strokeWidth={4} />
          {triangles.map((points) => (
            <polygon
              key={points}
              points={points}
              fill={labelColour}
              stroke={labelColour}
              strokeWidth={1.15}
              strokeLinejoin="round"
            />
          ))}
        </g>
        {frame.approachOpacity > 0 ? (
          <circle
            cx={50}
            cy={50}
            r={frame.approachRadius}
            fill="none"
            stroke="#fff"
            strokeWidth={1.8}
            opacity={frame.approachOpacity}
          />
        ) : null}
      </g>
    </svg>
  );
};
