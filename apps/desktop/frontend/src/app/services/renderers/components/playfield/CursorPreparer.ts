import { Container, Graphics } from "pixi.js";
import { OsuClassicCursor } from "@rewind/osu-pixi/classic-components";
import { findIndexInReplayAtTime, interpolateReplayPosition } from "../../../../utils/replay";
import {
  AnalysisCursor,
  AnalysisCursorTrailStyle,
  AnalysisPoint,
  COMPARISON_ANALYSIS_CURSOR_TRAIL_STYLE,
  DEFAULT_ANALYSIS_CURSOR_TRAIL_STYLE,
} from "@rewind/osu-pixi/rewind";
import { OsuAction } from "@osujs/core";
import { injectable } from "inversify";
import { GameplayClock } from "../../../common/game/GameplayClock";
import { ComparisonCursorSource, ReplayManager } from "../../../manager/ReplayManager";
import { AnalysisCursorSettingsStore, AnalysisCursorSettings } from "../../../analysis/analysis-cursor";
import { ReplayCursorSettingsStore } from "../../../common/replay-cursor";
import { Position } from "@osujs/math";
import { SkinHolder } from "../../../common/skin";
import { cursorIntervalCrossesExcludedTime, isCursorTimeExcluded } from "../../../analysis/replay-comparison";
import { GameSimulator, ReplayComparisonState } from "../../../common/game/GameSimulator";
import type { ClipExportOptions } from "../../../manager/clip-export-types";

const COMPARISON_TRAIL_DURATION_MS = 180;
const COMPARISON_TRAIL_SAMPLE_INTERVAL_MS = 16;

export interface ComparisonCursorGeometry {
  position: Position;
  trailSegments: Position[][];
}

export function analysisTrailStyleForReplayComparisonStatus(
  status: ReplayComparisonState["status"],
): AnalysisCursorTrailStyle {
  return status === "READY" ? COMPARISON_ANALYSIS_CURSOR_TRAIL_STYLE : DEFAULT_ANALYSIS_CURSOR_TRAIL_STYLE;
}

function isFinitePosition(position: Position): boolean {
  return Number.isFinite(position.x) && Number.isFinite(position.y);
}

/**
 * Resolves a comparison cursor without ever bridging a deliberately excluded
 * interval. Replay cursors disappear after their final frame, while an
 * Autoplay reference may keep its final (or only) frame visible.
 */
export function comparisonCursorPositionAt(source: ComparisonCursorSource, time: number): Position | undefined {
  if (!Number.isFinite(time) || isCursorTimeExcluded(time, source.excludedRanges)) return undefined;
  const { frames, excludedRanges } = source;
  const finalFrame = frames[frames.length - 1];
  if (source.kind === "replay" && Number.isFinite(finalFrame?.time) && time > finalFrame.time) return undefined;
  const pi = findIndexInReplayAtTime(frames, time);
  if (pi === -1) return undefined;

  const left = frames[pi];
  if (!Number.isFinite(left.time) || !isFinitePosition(left.position)) return undefined;
  if (isCursorTimeExcluded(left.time, excludedRanges)) return undefined;
  if (pi + 1 >= frames.length) {
    return cursorIntervalCrossesExcludedTime(left.time, time, excludedRanges) ? undefined : left.position;
  }

  if (left.time === time) return left.position;
  const right = frames[pi + 1];
  if (!Number.isFinite(right.time) || !isFinitePosition(right.position)) return undefined;
  if (
    isCursorTimeExcluded(right.time, excludedRanges) ||
    cursorIntervalCrossesExcludedTime(left.time, right.time, excludedRanges)
  ) {
    return undefined;
  }
  return interpolateReplayPosition(left, right, time);
}

/** Produces time-bounded trail segments, splitting rather than drawing across gaps. */
export function comparisonCursorGeometryAt(
  source: ComparisonCursorSource,
  time: number,
  trailDurationMs = COMPARISON_TRAIL_DURATION_MS,
  sampleIntervalMs = COMPARISON_TRAIL_SAMPLE_INTERVAL_MS,
): ComparisonCursorGeometry | undefined {
  const position = comparisonCursorPositionAt(source, time);
  if (!position) return undefined;

  const duration = Math.max(0, trailDurationMs);
  const interval = Math.max(1, sampleIntervalMs);
  const firstFrameTime = source.frames[0]?.time ?? time;
  const startTime = Math.max(firstFrameTime, time - duration);
  const sampleTimes: number[] = [];
  for (let sampleTime = startTime; sampleTime < time; sampleTime += interval) sampleTimes.push(sampleTime);
  // Replay frames are time ordered (as required by position lookup). Only the
  // short trail window can contribute samples; scanning the complete replay
  // here repeated tens of thousands of checks on every rendered frame.
  const firstTrailFrame = Math.max(0, findIndexInReplayAtTime(source.frames, startTime));
  for (let index = firstTrailFrame; index < source.frames.length; index++) {
    const frame = source.frames[index];
    if (frame.time >= time) break;
    if (frame.time >= startTime && frame.time < time) sampleTimes.push(frame.time);
  }
  sampleTimes.push(time);
  sampleTimes.sort((a, b) => a - b);

  const trailSegments: Position[][] = [];
  let segment: Position[] = [];
  let previousTime: number | undefined;
  let lastSampleTime: number | undefined;
  for (const sampleTime of sampleTimes) {
    if (lastSampleTime === sampleTime) continue;
    lastSampleTime = sampleTime;
    const samplePosition = comparisonCursorPositionAt(source, sampleTime);
    const crossesGap =
      previousTime !== undefined && cursorIntervalCrossesExcludedTime(previousTime, sampleTime, source.excludedRanges);
    if (!samplePosition || crossesGap) {
      if (segment.length > 0) trailSegments.push(segment);
      segment = [];
      previousTime = samplePosition ? sampleTime : undefined;
      if (samplePosition) segment.push(samplePosition);
      continue;
    }
    segment.push(samplePosition);
    previousTime = sampleTime;
  }
  if (segment.length > 0) trailSegments.push(segment);

  return { position, trailSegments };
}

@injectable()
export class CursorPreparer {
  private readonly container: Container;
  private readonly osuClassicCursor: OsuClassicCursor;
  private readonly analysisCursor: AnalysisCursor;
  private readonly comparisonCursor: Graphics;
  private readonly comparisonTrail: Graphics;

  constructor(
    private readonly replayManager: ReplayManager,
    private readonly gameSimulator: GameSimulator,
    private readonly skinManager: SkinHolder,
    private readonly gameClock: GameplayClock,
    private readonly analysisCursorSettingsStore: AnalysisCursorSettingsStore,
    private readonly replayCursorSettingsStore: ReplayCursorSettingsStore,
  ) {
    this.container = new Container();
    this.osuClassicCursor = new OsuClassicCursor();
    this.analysisCursor = new AnalysisCursor();
    this.comparisonCursor = new Graphics();
    this.comparisonTrail = new Graphics();
  }

  get time() {
    return this.gameClock.timeElapsedInMs;
  }

  get analysisCursorSettings() {
    return this.analysisCursorSettingsStore.settings;
  }

  updateOsuCursor(enabledOverride?: boolean) {
    const { scale, showTrail, smoothCursorTrail } = this.replayCursorSettingsStore.settings;
    const enabled = enabledOverride ?? this.replayCursorSettingsStore.settings.enabled;

    if (!enabled) {
      return;
    }

    const skin = this.skinManager.getSkin();
    const replay = this.replayManager.getMainReplay();
    const { time } = this;
    const cursor = this.osuClassicCursor;
    if (!replay) return;
    const frames = replay.frames;

    const pi = findIndexInReplayAtTime(frames, time);
    // we are either before the beginning or after the end of the replay
    if (pi === -1 || pi + 1 >= frames.length) return;

    // console.log(pi);
    const position = interpolateReplayPosition(frames[pi], frames[pi + 1], time);

    const trailPositions: Position[] = [];
    const numberOfTrailSprites = 8;
    if (showTrail) {
      if (smoothCursorTrail) {
        const fps = 144;
        const deltaCursorSmoothingTime = Math.floor(1000 / fps);
        let t = time - deltaCursorSmoothingTime,
          j = pi + 1;
        while (j > 0 && trailPositions.length < numberOfTrailSprites) {
          while (j > 0 && frames[j - 1].time > t) {
            j--;
          }
          if (j === 0) {
            trailPositions.push(frames[j].position);
          } else {
            trailPositions.push(interpolateReplayPosition(frames[j - 1], frames[j], t));
          }
          t -= deltaCursorSmoothingTime;
        }
      } else {
        for (let i = 1; i <= numberOfTrailSprites && pi - i >= 0; i++) {
          trailPositions.push(frames[pi - i].position);
        }
      }
    }

    cursor.prepare({
      position,
      trailPositions,
      cursorScale: scale,
      cursorTexture: skin.getTexture("CURSOR"),
      cursorTrailTexture: skin.getTexture("CURSOR_TRAIL"),
      cursorMiddleTexture: skin.getTexture("CURSOR_MIDDLE"),
    });

    this.container.addChild(cursor.container);
  }

  get replay() {
    return this.replayManager.getMainReplay();
  }

  updateAnalysisCursor(analysisCursorSettings: AnalysisCursorSettings = this.analysisCursorSettings) {
    const { replay, time } = this;
    const { enabled } = analysisCursorSettings;
    if (!enabled) {
      return;
    }

    if (!replay) return;
    const { frames } = replay;
    const cursor = this.analysisCursor;
    const pi = findIndexInReplayAtTime(frames, time);
    // we are either before the beginning or after the end of the replay
    if (pi === -1 || pi + 1 >= frames.length) return;
    const position = interpolateReplayPosition(frames[pi], frames[pi + 1], time);

    const interesting: boolean[] = [];
    const masks: number[] = [];
    // the interesting rule can be changed...

    const points: AnalysisPoint[] = [];
    const trailCount = 25;
    for (let i = trailCount - 1; i >= 0; i--) {
      masks[i] = 0;
      if (pi - i >= 0) {
        const r = frames[pi - i];
        if (r.actions.includes(OsuAction.leftButton)) masks[i] |= 1;
        if (r.actions.includes(OsuAction.rightButton)) masks[i] |= 2;
        if (i + 1 === trailCount) continue;

        // i has a bit that i + 1 does not have (bit=press)
        if ((masks[i] ^ masks[i + 1]) & masks[i]) {
          interesting[i] = true;
        }
      }
    }
    const colorScheme = [
      analysisCursorSettings.colorNoKeys,
      analysisCursorSettings.colorKey1,
      analysisCursorSettings.colorKey2,
      analysisCursorSettings.colorBothKeys,
    ];
    for (let i = 0; i < trailCount && pi - i >= 0; i++) {
      const j = pi - i;
      const maskDelta = (masks[i] ^ masks[i + 1]) & masks[i]; //
      points.push({
        interesting: interesting[i],
        color: colorScheme[maskDelta],
        position: frames[j].position,
      });
    }
    cursor.prepare({
      points,
      smoothedPosition: position,
      trailStyle: analysisTrailStyleForReplayComparisonStatus(this.gameSimulator.replayComparison$.getValue().status),
    });
    cursor.container.position.set(position.x, position.y);

    this.container.addChild(cursor.container);
  }

  updateComparisonCursor(enabled = true) {
    if (!enabled) return;
    const source = this.replayManager.getComparisonCursorSource();
    if (!source || !source.coordinateComparable) return;
    const geometry = comparisonCursorGeometryAt(source, this.time);
    if (!geometry) return;
    const { position, trailSegments } = geometry;
    const color = source.kind === "autoplay-reference" ? 0xffd166 : 0x59d9ff;
    const cursor = this.comparisonCursor;
    const trail = this.comparisonTrail;
    cursor.clear();
    trail.clear();

    if (trailSegments.some((segment) => segment.length > 1)) {
      trail.lineStyle(2, color, 0.34);
      for (const segment of trailSegments) {
        if (segment.length < 2) continue;
        trail.moveTo(segment[0].x, segment[0].y);
        for (let index = 1; index < segment.length; index++) {
          trail.lineTo(segment[index].x, segment[index].y);
        }
      }
    }

    cursor.lineStyle(2.5, color, 0.95);
    cursor.beginFill(color, 0.12);
    cursor.drawCircle(position.x, position.y, 10);
    cursor.endFill();
    cursor.lineStyle(1.5, color, 0.82);
    cursor.moveTo(position.x - 14, position.y);
    cursor.lineTo(position.x + 14, position.y);
    cursor.moveTo(position.x, position.y - 14);
    cursor.lineTo(position.x, position.y + 14);

    this.container.addChild(trail);
    this.container.addChild(cursor);
  }

  updateCursors(options?: Pick<ClipExportOptions, "showReplayCursor" | "showAnalysisCursor" | "showComparisonCursor">) {
    this.container.removeChildren();
    this.updateOsuCursor(options?.showReplayCursor);
    this.updateAnalysisCursor({
      ...this.analysisCursorSettings,
      enabled: options?.showAnalysisCursor ?? this.analysisCursorSettings.enabled,
    });
    this.updateComparisonCursor(options?.showComparisonCursor ?? true);
  }

  /** Rebuild only this frame's cursor composition; never persist clip visibility into the viewer. */
  withCaptureCursors<T>(
    options: Pick<ClipExportOptions, "showReplayCursor" | "showAnalysisCursor" | "showComparisonCursor">,
    render: () => T,
  ): T {
    const previous = this.container.children.slice();
    try {
      this.updateCursors(options);
      if (this.container.parent) this.container.updateTransform();
      return render();
    } finally {
      this.container.removeChildren();
      previous.forEach((child) => this.container.addChild(child));
      if (this.container.parent) this.container.updateTransform();
    }
  }

  getContainer() {
    return this.container;
  }
}
