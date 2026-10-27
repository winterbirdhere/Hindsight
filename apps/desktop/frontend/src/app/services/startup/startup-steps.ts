/** The two real startup steps, in the order `RewindApp` runs them. */
export const STARTUP_STEPS = ["Reading osu! folder", "Loading skin"] as const;

/** `stepIndex` is 0 or 1 while a step runs and 2 once startup has finished. */
export interface StartupProgress {
  stepIndex: number;
}

export function startupCaption({ stepIndex }: StartupProgress): { label: string; counter: string; fraction: number } {
  const last = STARTUP_STEPS.length - 1;
  const shown = Math.min(Math.max(stepIndex, 0), last);
  return {
    label: STARTUP_STEPS[shown],
    counter: `${shown + 1} / ${STARTUP_STEPS.length}`,
    fraction: Math.min(Math.max(stepIndex, 0), STARTUP_STEPS.length) / STARTUP_STEPS.length,
  };
}
