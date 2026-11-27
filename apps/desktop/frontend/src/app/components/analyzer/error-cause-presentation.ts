import type { ComponentMechanism } from "../../../../../../../libs/osu/core/src/gameplay/error-analysis/ComponentMechanisms";
import type { ReplayDisplaySettings } from "../../services/analysis/replay-display-settings";

export interface CauseDetail {
  phrase: string;
  metric?: { value: number; unit: string };
}
/** Signed tap offset in playback ms (+ late, − early) and its player text. */
export interface TapTiming {
  offsetMs: number;
  text: string;
}
export interface CausePresentation {
  labels: string[];
  detail?: CauseDetail;
  timing?: TapTiming;
  /**
   * Set for a chained error: the cause is an earlier mistake's, and this is the map time of the press that made it.
   * The detail and timing of such a cause describe that earlier press, not this error.
   */
  chainStartMs?: number;
  /** The earlier mistake's own cause, in player wording; absent when its record is unusable. */
  chainCause?: string[];
}

/**
 * The analysis calls these causes Overshoot / Undershoot (its codes and headlines keep those words); the player sees
 * Overaim / Underaim. Whole words, case kept, so a label, a joined headline and a detail phrase all read alike.
 */
function playerWording(text: string): string {
  return text
    .replace(/\bOvershoot\b/g, "Overaim")
    .replace(/\bUndershoot\b/g, "Underaim")
    .replace(/\bovershoot\b/g, "overaim")
    .replace(/\bundershoot\b/g, "underaim");
}

/** A headline's labels as the player reads them. */
function playerLabels(codes: readonly string[], headline: string): string[] {
  let text = headline.trim();
  if (codes.includes("aim-late")) text = text.replace(/\bAim late\b/g, "Late entry");
  if (codes.includes("left-early")) text = text.replace(/\bLeft early\b/g, "Early exit");
  if (codes.includes("released-early")) text = text.replace(/\bReleased early\b/g, "Early release");
  return playerWording(text).split(/\s*[·,]\s*/).filter(Boolean);
}

/** Presentation only: reject unranked diagnoses without selecting their first causes. */
export function presentCause(
  mechanisms: readonly ComponentMechanism[],
  displayMode: ReplayDisplaySettings["errorCauseDisplay"] = "concise",
): CausePresentation | undefined {
  if (
    !mechanisms.length ||
    mechanisms.some(
      (mechanism) =>
        mechanism.status !== "supported" ||
        !mechanism.codes.length ||
        mechanism.codes.some((code) => !code.trim()) ||
        !mechanism.headline.trim() ||
        mechanism.codes.some((code) => code === "no-retap" || code === "tap-taken") ||
        /\b(?:no re[-\s]tap|tap taken|hit taken)\b/i.test(mechanism.headline),
    )
  )
    return undefined;

  // A legacy component or parent payload may list independent conditions but
  // supply no primary comparison. Hiding the whole invalid presentation keeps
  // its diagnostic evidence intact; slicing would silently invent a winner.
  if (new Set(mechanisms.flatMap((mechanism) => mechanism.codes)).size > 2) return undefined;
  const labels = mechanisms.flatMap((mechanism) => playerLabels(mechanism.codes, mechanism.headline));
  const distinctLabels = [...new Set(labels)];
  if (!distinctLabels.length || distinctLabels.length > 2) return undefined;
  // Detail is supplied by the diagnosis policy. Never use diagnostic prose or
  // select between competing observations by label, array order or unit size.
  const details = new Map<string, CauseDetail>();
  if (displayMode === "brief")
    for (const mechanism of mechanisms) {
      const supplied = mechanism.briefDetail;
      if (!supplied) continue;
      const metric =
        supplied.metric && Number.isFinite(supplied.metric.value) && supplied.metric.unit.trim()
          ? { value: supplied.metric.value, unit: supplied.metric.unit.trim() }
          : undefined;
      const phrase = playerWording(supplied.phrase.trim());
      if (!phrase && !metric) continue;
      const detail = { phrase, ...(metric ? { metric } : {}) };
      details.set(JSON.stringify(detail), detail);
    }
  const detail = details.size === 1 ? [...details.values()][0] : undefined;

  // The timing line and diagram exist only for one cause whose metric is a tap offset.
  const metric = mechanisms.length === 1 ? mechanisms[0].metric : undefined;
  const timing =
    metric && Number.isFinite(metric.value) && (metric.unit === "ms late" || metric.unit === "ms early")
      ? { offsetMs: metric.unit === "ms late" ? metric.value : -metric.value, text: `${Math.round(metric.value)} ${metric.unit}` }
      : undefined;

  // One arrow points at one press: every shown cause must come from the same recorded start.
  const starts = new Set(mechanisms.map((mechanism) => (mechanism.chain?.chained ? mechanism.chain.start?.timeMs : undefined)));
  const start = starts.size === 1 ? [...starts][0] : undefined;
  const chainStartMs = start !== undefined && Number.isFinite(start) ? start : undefined;
  // The start's own cause names the earlier mistake; a protected label (Notelock) keeps it only here.
  const startCause = chainStartMs !== undefined ? mechanisms.find((mechanism) => mechanism.chain?.chained)?.chain?.cause : undefined;
  const startLabels =
    startCause?.codes?.length && startCause.headline?.trim() ? [...new Set(playerLabels(startCause.codes, startCause.headline))] : [];
  const chainCause = startLabels.length && startLabels.length <= 2 ? startLabels : undefined;

  return {
    labels: distinctLabels,
    ...(detail ? { detail } : {}),
    ...(timing ? { timing } : {}),
    ...(chainStartMs !== undefined ? { chainStartMs } : {}),
    ...(chainCause ? { chainCause } : {}),
  };
}

export function formatCauseDetail(detail: CauseDetail): string {
  return [detail.phrase, detail.metric ? `${Math.round(detail.metric.value)} ${detail.metric.unit}` : ""]
    .filter(Boolean)
    .join(" · ");
}
