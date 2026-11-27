import { ControlPointInfo } from "../beatmap/ControlPoints/ControlPointInfo";
import { HitObjectSettings } from "./HitObjectSettings";
import { BeatmapDifficulty } from "../beatmap/BeatmapDifficulty";
import { BeatmapBreakPeriod, StoryboardSampleInfo } from "../audio/StoryboardSampleInfo";

/**
 * Blueprints define the default settings of the hitobjects.
 *
 * Beatmaps are instances of blueprints with additional modifications:
 * - Game mods, e.g. HardRock flips the map vertically
 * - Hit object stacking
 *
 * The reason that we have to explicitly distinguish between beatmaps and blueprint is due to clarity:
 * * Players don't play on blueprints, they play on beatmaps.
 * * Difficulty calculation is also not done on blueprints, but on beatmaps.
 * * ...
 */

export interface Blueprint {
  blueprintInfo: BlueprintInfo;
  defaultDifficulty: BeatmapDifficulty;
  controlPointInfo: ControlPointInfo;
  hitObjectSettings: HitObjectSettings[];
}

export interface BlueprintInfo {
  beatmapVersion: number;
  onlineBeatmapId?: number;
  metadata: BlueprintMetadata;
  audioLeadIn: number; // 0
  stackLeniency: number; // 0.7
  samplesMatchPlaybackRate: boolean;
  storyboardSamples: StoryboardSampleInfo[];
  breakPeriods: BeatmapBreakPeriod[];
}

export interface BlueprintMetadata {
  artist: string;
  title: string;
  titleUnicode: string;
  artistUnicode: string;
  /** Human-readable difficulty name from the Metadata Version field. */
  difficultyName?: string;
  /** Mapper name from the Metadata Creator field. */
  creator?: string;
  source: string;
  tags: string;
  previewTime: number;
  audioFile: string;
  backgroundFile: string;
  backgroundOffset: { x: number; y: number };
}
