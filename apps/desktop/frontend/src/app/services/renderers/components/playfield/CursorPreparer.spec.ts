import type { ReplayFrame } from "@osujs/core";
import { BaseTexture, Container, Sprite, Texture } from "pixi.js";
import { OsuClassicCursor } from "@rewind/osu-pixi/classic-components";
import { generateDefaultSkinConfig, OsuSkinTextures } from "@rewind/osu/skin";
import { Skin } from "../../../../model/Skin";
import type { ComparisonCursorSource } from "../../../manager/ReplayManager";
import { COMPARISON_ANALYSIS_CURSOR_TRAIL_STYLE, DEFAULT_ANALYSIS_CURSOR_TRAIL_STYLE } from "@rewind/osu-pixi/rewind";
import {
  analysisTrailStyleForReplayComparisonStatus,
  comparisonCursorGeometryAt,
  comparisonCursorPositionAt,
  CursorPreparer,
} from "./CursorPreparer";

function frame(time: number, x: number, y = 0): ReplayFrame {
  return { time, position: { x, y }, actions: [] };
}

it("renders a skin's middle cursor at the interpolated replay position", () => {
  const middle = new Texture(new BaseTexture(null, { width: 120, height: 120 }));
  const skin = new Skin(generateDefaultSkinConfig(false), {
    CURSOR: [Texture.EMPTY],
    CURSOR_TRAIL: [Texture.EMPTY],
    ["CURSOR_MIDDLE" as OsuSkinTextures]: [middle],
  });
  const cursor = new OsuClassicCursor();
  const container = new Container();
  const preparer = Object.create(CursorPreparer.prototype) as CursorPreparer;
  Object.assign(preparer, {
    container,
    osuClassicCursor: cursor,
    skinManager: { getSkin: () => skin },
    replayManager: { getMainReplay: () => ({ frames: [frame(0, 100, 50), frame(100, 200, 150)] }) },
    gameClock: { timeElapsedInMs: 50 },
    replayCursorSettingsStore: { settings: { enabled: true, scale: 0.8, showTrail: false, smoothCursorTrail: false } },
  });
  try {
    preparer.updateOsuCursor();
    const sprite = cursor.container.children.find(
      (child) => child instanceof Sprite && child.texture === middle,
    ) as Sprite;
    expect(sprite).toBeDefined();
    expect(sprite.position.x).toBe(150);
    expect(sprite.position.y).toBe(100);
    expect(sprite.width).toBeCloseTo(96);
    expect(sprite.height).toBeCloseTo(96);
    expect(container.children).toContain(cursor.container);
  } finally {
    container.destroy({ children: true });
    middle.destroy(true);
  }
});

function source(overrides: Partial<ComparisonCursorSource> = {}): ComparisonCursorSource {
  return {
    id: "comparison",
    label: "Comparison",
    kind: "autoplay-reference",
    frames: [],
    excludedRanges: [],
    coordinateComparable: true,
    ...overrides,
  };
}

describe("comparison cursor geometry", () => {
  it("keeps an Autoplay reference's single/final frame visible", () => {
    const singleFrameSource = source({ frames: [frame(100, 25, 30)] });

    expect(comparisonCursorPositionAt(singleFrameSource, 100)).toEqual({ x: 25, y: 30 });
    expect(comparisonCursorPositionAt(singleFrameSource, 250)).toEqual({ x: 25, y: 30 });

    const twoFrameSource = source({ frames: [frame(0, 0), frame(100, 100)] });
    expect(comparisonCursorPositionAt(twoFrameSource, 100)).toEqual({ x: 100, y: 0 });
  });

  it("hides a replay cursor after its final frame while rendering the exact endpoint", () => {
    const singleFrameReplay = source({ kind: "replay", frames: [frame(100, 25, 30)] });

    expect(comparisonCursorPositionAt(singleFrameReplay, 100)).toEqual({ x: 25, y: 30 });
    expect(comparisonCursorPositionAt(singleFrameReplay, 100.001)).toBeUndefined();
    expect(comparisonCursorGeometryAt(singleFrameReplay, 250)).toBeUndefined();

    const twoFrameReplay = source({ kind: "replay", frames: [frame(0, 0), frame(100, 100)] });
    expect(comparisonCursorPositionAt(twoFrameReplay, 100)).toEqual({ x: 100, y: 0 });
    expect(comparisonCursorPositionAt(twoFrameReplay, 101)).toBeUndefined();
  });

  it("does not interpolate or connect a trail across excluded map-time ranges", () => {
    const comparison = source({
      frames: [frame(0, 0), frame(100, 100), frame(300, 300), frame(400, 400)],
      excludedRanges: [{ startTime: 150, endTime: 250, reason: "spinner" }],
    });

    expect(comparisonCursorPositionAt(comparison, 125)).toBeUndefined();
    expect(comparisonCursorPositionAt(comparison, 200)).toBeUndefined();
    expect(comparisonCursorPositionAt(comparison, 300)).toEqual({ x: 300, y: 0 });

    const geometry = comparisonCursorGeometryAt(comparison, 300, 300, 25);
    expect(geometry?.trailSegments).toHaveLength(2);
    expect(geometry?.trailSegments[0].every((position) => position.x <= 100)).toBe(true);
    expect(geometry?.trailSegments[1]).toEqual([{ x: 300, y: 0 }]);
  });

  it("bounds a sparse-frame trail by map time", () => {
    const comparison = source({
      kind: "replay",
      frames: [frame(0, 0), frame(1000, 1000)],
    });

    const geometry = comparisonCursorGeometryAt(comparison, 1000, 180, 20);
    expect(geometry?.trailSegments).toHaveLength(1);
    expect(geometry?.trailSegments[0][0].x).toBe(820);
    const trail = geometry?.trailSegments[0] ?? [];
    expect(trail[trail.length - 1]).toEqual({ x: 1000, y: 0 });
  });

  it("includes the trail boundaries and irregular frame times after seeking", () => {
    const comparison = source({
      frames: [frame(0, 0), frame(100, 100), frame(100, 120), frame(111, 111), frame(130, 130), frame(500, 500)],
    });

    comparisonCursorGeometryAt(comparison, 500, 30, 20);
    expect(comparisonCursorGeometryAt(comparison, 130, 30, 20)?.trailSegments).toEqual([
      [
        { x: 120, y: 0 },
        { x: 111, y: 0 },
        { x: 120, y: 0 },
        { x: 130, y: 0 },
      ],
    ]);
  });

  it("reads only a bounded trail window from a long replay", () => {
    const frames = Array.from({ length: 20000 }, (_, index) => frame(index * 10, index * 10));
    let frameReads = 0;
    const trackedFrames = new Proxy(frames, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) frameReads++;
        return Reflect.get(target, key, receiver);
      },
    });

    const geometry = comparisonCursorGeometryAt(source({ frames: trackedFrames }), 100000);

    expect(geometry?.position).toEqual({ x: 100000, y: 0 });
    expect(geometry?.trailSegments[0][0]).toEqual({ x: 99820, y: 0 });
    expect(frameReads).toBeLessThan(1000);
  });
});

describe("primary trail comparison styling", () => {
  it("uses bright silver only for a ready replay or Autoplay comparison", () => {
    expect(analysisTrailStyleForReplayComparisonStatus("EMPTY")).toBe(DEFAULT_ANALYSIS_CURSOR_TRAIL_STYLE);
    expect(analysisTrailStyleForReplayComparisonStatus("LOADING")).toBe(DEFAULT_ANALYSIS_CURSOR_TRAIL_STYLE);
    expect(analysisTrailStyleForReplayComparisonStatus("ERROR")).toBe(DEFAULT_ANALYSIS_CURSOR_TRAIL_STYLE);
    expect(analysisTrailStyleForReplayComparisonStatus("READY")).toBe(COMPARISON_ANALYSIS_CURSOR_TRAIL_STYLE);
  });
});
