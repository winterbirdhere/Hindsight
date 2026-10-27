import { Container } from "@pixi/display";
import { Graphics } from "pixi.js";
import { applyEasing, Easing, Position, Vec2 } from "@osujs/math";

export class AnalysisCross extends Graphics {
  prepare(color: number, interesting?: boolean) {
    this.clear();

    // osu!px
    const size = interesting ? 5 : 2;
    const width = interesting ? 2 : 1;

    this.lineStyle(width, color);
    /* / */
    this.moveTo(-size, size);
    this.lineTo(size, -size);
    /* \ */
    this.moveTo(-size, -size);
    this.lineTo(+size, +size);
  }
}

const numberOfFrames = 25;

/**
 * Neutral silver keeps the primary analysis path distinct from the cyan replay
 * comparison trace. The minimum opacity prevents the older end of the path
 * from disappearing against a dimmed beatmap background.
 */
export interface AnalysisCursorTrailStyle {
  color: number;
  width: number;
  minimumAlpha: number;
}

export const DEFAULT_ANALYSIS_CURSOR_TRAIL_STYLE: AnalysisCursorTrailStyle = {
  color: 0x5d6463,
  width: 1,
  minimumAlpha: 0,
};

export const COMPARISON_ANALYSIS_CURSOR_TRAIL_STYLE: AnalysisCursorTrailStyle = {
  color: 0xe4e9ef,
  width: 2.25,
  minimumAlpha: 0.24,
};

export function analysisCursorTrailAlpha(
  easedAlpha: number,
  style: AnalysisCursorTrailStyle = DEFAULT_ANALYSIS_CURSOR_TRAIL_STYLE,
): number {
  const normalizedAlpha = Number.isFinite(easedAlpha) ? Math.min(1, Math.max(0, easedAlpha)) : 0;
  return style.minimumAlpha + normalizedAlpha * (1 - style.minimumAlpha);
}

export enum AnalysisColorStyle {
  RAW, // just display the color based on the keys that are pressed (similar to circle guard)
  NEW, // only display the "new" key presses
}

export interface AnalysisPoint {
  position: Position;
  color: number;
  interesting: boolean;
}

interface Settings {
  points: AnalysisPoint[];
  smoothedPosition: Position;
  trailStyle: AnalysisCursorTrailStyle;
}

const defaultSettings: Settings = {
  points: [],
  smoothedPosition: { x: 0, y: 0 },
  trailStyle: DEFAULT_ANALYSIS_CURSOR_TRAIL_STYLE,
};

export class AnalysisCursor {
  container: Container;
  analysisPoints: AnalysisCross[];
  trail: Graphics;
  circle: Graphics; // small circle at the smoothed position

  constructor() {
    this.container = new Container();
    this.analysisPoints = [];
    this.container.addChild((this.trail = new Graphics()));
    for (let i = 0; i < numberOfFrames; i++) {
      this.container.addChild((this.analysisPoints[numberOfFrames - i - 1] = new AnalysisCross()));
    }
    this.container.addChild((this.circle = new Graphics()));
    this.circle.beginFill(0xffff00, 1.0);
    this.circle.drawCircle(0, 0, 2);
    this.circle.endFill();
  }

  prepare(settings: Partial<Settings>): void {
    const { points, smoothedPosition, trailStyle } = { ...defaultSettings, ...settings };
    // Trail
    this.trail.clear();
    this.trail.moveTo(0, 0);
    const numberOfFrames = points.length;
    for (let i = 0; i < numberOfFrames; i++) {
      const { color, interesting, position } = points[i];
      const f = (numberOfFrames - i) / numberOfFrames;
      const baseAlpha = 1 - applyEasing(1 - f, Easing.OUT);
      const offset = Vec2.sub(position, smoothedPosition);

      this.trail.lineStyle(trailStyle.width, trailStyle.color, analysisCursorTrailAlpha(baseAlpha, trailStyle));
      this.trail.lineTo(offset.x, offset.y);
      this.analysisPoints[i].prepare(color, interesting);
      this.analysisPoints[i].alpha = (interesting ? 1 : 0.6) * baseAlpha;
      this.analysisPoints[i].position.set(offset.x, offset.y);
    }
  }
}
