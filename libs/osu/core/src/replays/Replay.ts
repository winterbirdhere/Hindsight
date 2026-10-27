import { Position } from "@osujs/math";

export enum OsuAction {
  leftButton,
  rightButton,
}

/** Parser-owned indices are assigned while consuming the original comma tokens. */
export interface ParsedReplayFrameSource {
  origin: "parsed";
  parsedFrameIndex: number;
  rawTokenIndex: number;
  discontinuityBefore?: string[];
}

export type ReplaySkippedTokenReason =
  | "empty-token"
  | "malformed-token"
  | "seed"
  | "stable-sentinel"
  | "negative-delta";

export const REPLAY_LEADING_RESET_WITNESS_VERSION = "stable-released-leading-reset-v2";
export interface ReplayLeadingResetToken {
  rawTokenIndex: number; delta: number; x: number; y: number; rawButtonMask: number; timeBefore: number; timeAfter: number;
}
/** Additive parser facts only. Consumers still qualify profile, activation and the entire suffix. */
export interface ReplayLeadingResetWitness {
  version: typeof REPLAY_LEADING_RESET_WITNESS_VERSION;
  parserVersion: string;
  tokens: ReplayLeadingResetToken[];
  frameCount: number;
  rawTokenCount: number;
}
export const REPLAY_INITIAL_NEGATIVE_WITNESS_VERSION = "native-zero-initial-negative-v1";
/** A distinct consumed-stream fact; native profile and activation are consumer responsibilities. */
export interface ReplayInitialNegativeWitness {
  version: typeof REPLAY_INITIAL_NEGATIVE_WITNESS_VERSION;
  parserVersion: string;
  tokens: ReplayLeadingResetToken[];
  frameCount: number;
  rawTokenCount: number;
}
export const REPLAY_RELEASED_PREFIX_WITNESS_VERSION = "stable-released-prefix-v1";
export const REPLAY_RELEASED_PREFIX_MAX_TOKENS = 256;
/** Complete bounded raw prefix through a released retained frame after the last reset.
 * This attests input only; exact-map timing and numerical convergence remain consumer gates. */
export interface ReplayReleasedPrefixWitness {
  version: typeof REPLAY_RELEASED_PREFIX_WITNESS_VERSION;
  parserVersion: string;
  tokens: ReplayLeadingResetToken[];
  releaseFrameIndex: number;
  frameCount: number;
  rawTokenCount: number;
}
export const REPLAY_NEUTRAL_PREFIX_WITNESS_VERSION = "stable-neutral-multi-reset-v1";
export const REPLAY_NEUTRAL_LATER_RESET_WITNESS_VERSION = "stable-neutral-later-reset-v1";
/** All-released multi-reset or single-later-reset prefix. A later single reset
 * requires retained input before it; it never replaces canonical leading evidence. */
export interface ReplayNeutralPrefixWitness extends Omit<ReplayReleasedPrefixWitness, "version"> {
  version: typeof REPLAY_NEUTRAL_PREFIX_WITNESS_VERSION | typeof REPLAY_NEUTRAL_LATER_RESET_WITNESS_VERSION;
}

export const REPLAY_INITIAL_HELD_PREFIX_WITNESS_VERSION = "native-initial-held-release-v1";
/** One initial negative timestamp followed by actual held input and a bounded
 * released checkpoint. Profile/activation and complete suffix remain consumer gates. */
export interface ReplayInitialHeldPrefixWitness extends Omit<ReplayReleasedPrefixWitness, "version"> {
  version: typeof REPLAY_INITIAL_HELD_PREFIX_WITNESS_VERSION;
}

export interface ReplayParseDiagnostics {
  parserVersion: string;
  /** One source for each emitted frame, in the exact same order. */
  frameSources: ParsedReplayFrameSource[];
  skippedTokens: { rawTokenIndex: number; reason: ReplaySkippedTokenReason }[];
  sourceCoverageLimits: string[];
  /** A first recorded sample does not establish the action state before it. */
  initialActionsKnown: boolean;
  leadingResetWitness?: ReplayLeadingResetWitness;
  initialNegativeWitness?: ReplayInitialNegativeWitness;
  releasedPrefixWitness?: ReplayReleasedPrefixWitness;
  neutralPrefixWitness?: ReplayNeutralPrefixWitness;
  initialHeldPrefixWitness?: ReplayInitialHeldPrefixWitness;
}

export interface ParsedReplayFrames {
  frames: ReplayFrame[];
  diagnostics: ReplayParseDiagnostics;
}

export type ReplayFrame = {
  time: number;
  position: Position;
  actions: OsuAction[];
  /**
   * The unmodified button bitmask stored in an osu! replay frame.
   *
   * `actions` intentionally collapses keyboard and mouse buttons into the two
   * logical osu! actions used by gameplay simulation. Stable-produced replays
   * retain a keyboard discriminator in this mask. Lazer's legacy replay export,
   * however, writes only the two logical actions and therefore does not retain
   * keyboard-versus-mouse provenance.
   */
  rawButtonMask?: number;
  /**
   * Exact ordered frames grouped by native lazer input preparation. Inputs are
   * evaluated in order before time-driven events at this timestamp. Parsed
   * replay frames remain ungrouped so gameplay and display retain each sample.
   */
  sourceFramesAtSameTime?: ReplayFrame[];
};

export enum ReplayButtonState {
  None = 0,
  Left1 = 1,
  Right1 = 2,
  Left2 = 4,
  Right2 = 8,
  Smoke = 16,
}
