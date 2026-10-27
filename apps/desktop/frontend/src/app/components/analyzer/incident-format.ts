import type { ComponentMechanism } from "../../../../../../../libs/osu/core/src/gameplay/error-analysis/ComponentMechanisms";
import type { MemberLabel } from "../../services/analysis/incident-summary";
import type { ReplayDisplaySettings } from "../../services/analysis/replay-display-settings";
import type { ReplayError } from "../../services/analysis/replay-events";
import { REWIND_COLORS } from "../../styles/tokens";
import { presentCause } from "./error-cause-presentation";

const ERROR_TYPE_LABEL: Record<ReplayError["type"], string> = {
  MISS: "Miss",
  SLIDER_BREAK: "Slider break",
  SLIDER_COMPONENT_MISS: "Slider tick",
  ANALYSIS_ERROR: "Analysis error",
};

/**
 * What the player calls this error. A slider component miss is named by the component that was missed;
 * `TAIL` misses never become errors, so anything that is not a head or a repeat reads as a tick.
 */
export function errorTypeLabel(error: Pick<ReplayError, "type" | "sliderComponentType">): string {
  if (error.type === "SLIDER_COMPONENT_MISS") {
    if (error.sliderComponentType === "HEAD") return "Slider head";
    if (error.sliderComponentType === "REPEAT") return "Slider repeat";
  }
  return ERROR_TYPE_LABEL[error.type];
}

/**
 * The inspector header's position text: "34/92", "34–36/92" for a contiguous run and "34, 36/92" for errors that are
 * not. Error numbers count from 1.
 */
export function formatIncidentPosition(errorIndices: readonly number[], totalErrors: number): string {
  const numbers = errorIndices.map((index) => index + 1);
  const contiguous = numbers.every((value, position) => position === 0 || value === numbers[position - 1] + 1);
  const range =
    numbers.length === 1
      ? `${numbers[0]}`
      : contiguous
      ? `${numbers[0]}–${numbers[numbers.length - 1]}`
      : numbers.join(", ");
  return `${range}/${totalErrors}`;
}

export const ERROR_TYPE_COLOR: Record<ReplayError["type"], string> = {
  MISS: REWIND_COLORS.judgementMiss,
  SLIDER_BREAK: REWIND_COLORS.sliderBreak,
  SLIDER_COMPONENT_MISS: REWIND_COLORS.sliderBreak,
  ANALYSIS_ERROR: REWIND_COLORS.textTertiary,
};

/** `m:ss` and `.mmm`, split so the milliseconds can be dimmed. */
export function splitErrorTime(ms: number): [string, string] {
  const safe = Math.max(0, Math.round(ms));
  const minutes = Math.floor(safe / 60000);
  const seconds = Math.floor((safe % 60000) / 1000);
  return [`${minutes}:${String(seconds).padStart(2, "0")}`, `.${String(safe % 1000).padStart(3, "0")}`];
}

export const EMPTY_CAUSES: readonly ComponentMechanism[] = [];

/**
 * Text for assistive technology only. Sizes are px strings: in MUI's `sx` a bare `1` is 100 %, not 1 px.
 * It is out of flow, so its nearest positioned ancestor (the row, the entry) must be `position: relative`
 * or it is placed against, and can overflow, a scroller further up.
 */
export const visuallyHidden = {
  position: "absolute",
  width: "1px",
  height: "1px",
  m: "-1px",
  p: 0,
  border: 0,
  overflow: "hidden",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
} as const;

/** A quiet 28 px text button (Follow, Show / Hide, Replay). */
export const quietTextButton = {
  height: 28,
  px: "8px",
  borderRadius: "5px",
  fontSize: 12.5,
  fontWeight: 500,
  color: REWIND_COLORS.textSecondary,
  "&:hover": { backgroundColor: "rgba(255,255,255,0.07)", color: REWIND_COLORS.textPrimary },
  "&.Mui-disabled": { color: REWIND_COLORS.textQuaternary },
  "&.Mui-focusVisible": { outline: `2px solid ${REWIND_COLORS.focus}`, outlineOffset: 1 },
} as const;

/** The existing cause wording of each error (or none) and its type, for incident summaries. */
export function memberLabeller(
  errors: readonly ReplayError[],
  causes: ReadonlyMap<string, readonly ComponentMechanism[]>,
  displayMode: ReplayDisplaySettings["errorCauseDisplay"],
): (errorIndex: number) => MemberLabel {
  return (errorIndex) => {
    const error = errors[errorIndex];
    const presentation = presentCause(causes.get(error.id) ?? EMPTY_CAUSES, displayMode);
    return {
      cause: presentation?.labels.join(" · "),
      type: errorTypeLabel(error),
      ...(presentation?.chainStartMs !== undefined
        ? { chain: { startMs: presentation.chainStartMs, ...(presentation.chainCause ? { cause: presentation.chainCause } : {}) } }
        : {}),
    };
  };
}

/**
 * What the chain arrow means, in a few words: `Caused by early tap at 1:10.192`. The time is the earlier press in
 * displayed playback time; without a usable cause it reads `Caused by an earlier mistake at …`.
 */
export function chainMessage(startMs: number, cause: readonly string[] | undefined, baseRate: number): string {
  const what = cause?.length ? cause.map((label) => label.charAt(0).toLowerCase() + label.slice(1)).join(" and ") : "an earlier mistake";
  return `Caused by ${what} at ${splitErrorTime(startMs / baseRate).join("")}`;
}
