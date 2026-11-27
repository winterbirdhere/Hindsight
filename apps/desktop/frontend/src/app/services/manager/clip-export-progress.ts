import type { ClipRecorderState, ClipRunSummary } from "./clip-export-types";

export type ExportStepId = "preparing" | "audio" | "frames" | "saving";

export interface ExportStep {
  id: ExportStepId;
  label: string;
  state: "done" | "active" | "pending" | "skipped";
  detail?: string;
}

export interface ExportProgressModel {
  title: string;
  subline: string;
  /** Whole number, 0 … 93, overall. */
  percent: number;
  /** The same figure before rounding down, as 0 … 0.93. */
  fraction: number;
  rendering: boolean;
  steps: ExportStep[];
}

const LABELS: Record<ExportStepId, string> = {
  preparing: "Preparing",
  audio: "Recording audio",
  frames: "Rendering frames",
  saving: "Saving",
};

const clamp01 = (value: number) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);

/**
 * Turns the recorder's state and run summary into the export panel's step list and one overall figure.
 * The spans follow the design's mock: audio 6–22 %, frames 22–93 % (6–93 % without audio), saving rests at 93 %.
 * Statuses that are not part of a running export (idle, cancelled, error) read as the start of a run; done reads as
 * every step finished, still capped at 93 % because the panel switches to its saved view instead.
 */
export function exportProgress(state: ClipRecorderState, run: ClipRunSummary | undefined): ExportProgressModel {
  const p = clamp01(state.progress);
  const status = state.status;
  const finished = status === "saving" || status === "done";
  const framesStarted = status === "rendering" || finished;
  const audioRecorded = run?.audio ?? true;
  const framesDone = run
    ? finished
      ? run.frameCount
      : Math.min(run.frameCount, Math.round((status === "rendering" ? p : 0) * run.frameCount))
    : 0;

  let value: number;
  if (status === "recording") value = 6 + 16 * p;
  else if (status === "rendering") value = audioRecorded ? 22 + 71 * p : 6 + 87 * p;
  else if (finished) value = 93;
  else value = 0;

  const audioState: ExportStep["state"] =
    run && !run.audio ? "skipped" : status === "recording" ? "active" : framesStarted && run ? "done" : "pending";
  const audio: ExportStep = { id: "audio", label: LABELS.audio, state: audioState };
  if (audioState === "skipped") audio.detail = "skipped";
  else if (audioState === "done" && run) audio.detail = `${run.durationSeconds.toFixed(1)} s`;

  const framesState: ExportStep["state"] = finished ? "done" : status === "rendering" ? "active" : "pending";
  const frames: ExportStep = { id: "frames", label: LABELS.frames, state: framesState };
  if (run && (framesState === "active" || framesState === "done")) frames.detail = `${framesDone} / ${run.frameCount}`;

  const preparingDone = status !== "preparing" && status !== "idle" && status !== "cancelled" && status !== "error";
  const steps: ExportStep[] = [
    { id: "preparing", label: LABELS.preparing, state: preparingDone ? "done" : status === "preparing" ? "active" : "pending" },
    audio,
    frames,
    { id: "saving", label: LABELS.saving, state: status === "done" ? "done" : status === "saving" ? "active" : "pending" },
  ];

  let title: string;
  let subline: string;
  if (status === "recording") {
    title = LABELS.audio;
    subline = "Mixing music and hit sounds";
  } else if (status === "rendering") {
    title = LABELS.frames;
    subline = run ? `${framesDone} / ${run.frameCount} frames` : "Rendering";
  } else if (finished) {
    title = LABELS.saving;
    subline = "Writing MP4";
  } else {
    title = LABELS.preparing;
    subline = "Opening the recorder";
  }

  return {
    title,
    subline,
    percent: Math.floor(value + 1e-9),
    fraction: value / 100,
    rendering: status === "rendering",
    steps,
  };
}
