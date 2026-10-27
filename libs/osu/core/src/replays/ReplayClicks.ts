import { OsuAction, ReplayButtonState, ReplayFrame } from "./Replay";

export type TimeInterval = [number, number];
export type TimeIntervals = TimeInterval[];

export const PHYSICAL_REPLAY_BUTTONS = ["K1", "K2", "M1", "M2"] as const;
export type PhysicalReplayButton = typeof PHYSICAL_REPLAY_BUTTONS[number];
export type ReplayButtonIntervals = Record<PhysicalReplayButton, TimeIntervals>;
export type ReplayButtonEncoding = "stable-physical" | "lazer-logical";

/** Lazer reserves replay versions at and above this value for legacy score export. */
export const FIRST_LAZER_REPLAY_VERSION = 30_000_000;

export function replayButtonEncodingForGameVersion(gameVersion: number | undefined): ReplayButtonEncoding {
  return typeof gameVersion === "number" && Number.isInteger(gameVersion) && gameVersion >= FIRST_LAZER_REPLAY_VERSION
    ? "lazer-logical"
    : "stable-physical";
}

const logicalFallbackActions: Record<PhysicalReplayButton, OsuAction | undefined> = {
  // Frames constructed by older callers do not have a raw mask. Preserve the
  // old two-lane visualization by treating logical actions as keyboard input.
  K1: OsuAction.leftButton,
  K2: OsuAction.rightButton,
  M1: undefined,
  M2: undefined,
};

/**
 * Stable stores keyboard presses as a logical mouse action plus a keyboard
 * discriminator: K1 is `Left1 | Left2` (5) and K2 is `Right1 | Right2` (10).
 * Consequently the lower bit is a physical mouse press only when the matching
 * keyboard discriminator is absent. Same-side keyboard/mouse overlap cannot be
 * recovered from the legacy format because it has the same mask as the key.
 */
export function isPhysicalReplayButtonPressed(mask: number, button: PhysicalReplayButton): boolean {
  switch (button) {
    case "K1":
      return (mask & ReplayButtonState.Left2) !== 0;
    case "K2":
      return (mask & ReplayButtonState.Right2) !== 0;
    case "M1":
      return (mask & ReplayButtonState.Left1) !== 0 && (mask & ReplayButtonState.Left2) === 0;
    case "M2":
      return (mask & ReplayButtonState.Right1) !== 0 && (mask & ReplayButtonState.Right2) === 0;
  }
}

/** Counts decoded K1/K2/M1/M2 rising edges rather than raw replay bits. */
export function countFreshPhysicalReplayButtons(previousMask: number, currentMask: number): number {
  return PHYSICAL_REPLAY_BUTTONS.filter(
    (button) =>
      !isPhysicalReplayButtonPressed(previousMask, button) && isPhysicalReplayButtonPressed(currentMask, button),
  ).length;
}

function calculateIntervals(
  frames: ReplayFrame[],
  buttons: readonly PhysicalReplayButton[],
  isPressing: (frame: ReplayFrame, button: PhysicalReplayButton) => boolean,
) {
  const clicks: ReplayButtonIntervals = { K1: [], K2: [], M1: [], M2: [] };
  const startTime: Partial<Record<PhysicalReplayButton, number>> = {};

  for (const frame of frames) {
    for (const button of buttons) {
      const pressed = isPressing(frame, button);
      const startedAt = startTime[button];
      if (!pressed && startedAt !== undefined) {
        clicks[button].push([startedAt, frame.time]);
        delete startTime[button];
      } else if (pressed && startedAt === undefined) {
        startTime[button] = frame.time;
      }
    }
  }

  for (const button of buttons) {
    const startedAt = startTime[button];
    if (startedAt !== undefined) clicks[button].push([startedAt, 1e9]);
  }

  return clicks;
}

/**
 * Preserve original input order for callers supplying native lazer groups.
 * Parsed replay frames already contain the individual zero-delta samples.
 */
function exactLazerFrames(frames: ReplayFrame[]): ReplayFrame[] {
  const exactFrames: ReplayFrame[] = [];
  for (const frame of frames) {
    if (frame.sourceFramesAtSameTime?.length) exactFrames.push(...frame.sourceFramesAtSameTime);
    else exactFrames.push(frame);
  }
  return exactFrames;
}

/**
 * Calculates physical K1/K2/M1/M2 press intervals without changing the two
 * logical actions used by the stable gameplay evaluator.
 *
 * A Lazer-exported `.osr` only contains logical Left/Right actions. In that
 * encoding bits 1 and 2 must not be presented as physical M1/M2; use the two
 * keyboard-coloured fallback lanes and leave the mouse lanes empty.
 */
export function calculateReplayButtonIntervals(
  frames: ReplayFrame[],
  encoding: ReplayButtonEncoding = "stable-physical",
): ReplayButtonIntervals {
  if (encoding === "lazer-logical") {
    return calculateIntervals(exactLazerFrames(frames), PHYSICAL_REPLAY_BUTTONS, (frame, button) => {
      if (button === "K1") return frame.actions.includes(OsuAction.leftButton);
      if (button === "K2") return frame.actions.includes(OsuAction.rightButton);
      return false;
    });
  }

  return calculateIntervals(frames, PHYSICAL_REPLAY_BUTTONS, (frame, button) => {
    if (frame.rawButtonMask !== undefined) {
      return isPhysicalReplayButtonPressed(frame.rawButtonMask, button);
    }

    const fallback = logicalFallbackActions[button];
    return fallback !== undefined && frame.actions.includes(fallback);
  });
}

export function calculateReplayClicks(frames: ReplayFrame[]) {
  const logicalButtons = ["K1", "K2"] as const;
  const clicks = calculateIntervals(frames, logicalButtons, (frame, button) =>
    frame.actions.includes(button === "K1" ? OsuAction.leftButton : OsuAction.rightButton),
  );
  return [clicks.K1, clicks.K2] as [TimeIntervals, TimeIntervals];
}
