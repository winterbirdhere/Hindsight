import type { ReadoutModel } from "../analysis/readout-model";
import { REWIND_COLORS, REWIND_FONTS } from "../../styles/tokens";

/** The design height the live stats column is laid out for; an exported frame scales it by `height / 696`. */
export const CLIP_STATS_DESIGN_HEIGHT = 696;

export interface ColumnRun {
  text: string;
  font: string;
  color: string;
  letterSpacing?: number;
  gapBefore?: number;
}
export interface ColumnLine {
  x: number;
  baseline: number;
  runs: ColumnRun[];
}
export interface ColumnLayout {
  lines: ColumnLine[];
  dividers: { x: number; y: number; width: number; height: number }[];
  bottom: number;
}
/** Font metrics in px; `width` is the width of `text` in that font (0 when no text is passed). */
export type FontMeasure = (font: string, text?: string) => { ascent: number; descent: number; width: number };

// Design px of the live StatsOverlay (components/analyzer/StatsOverlay.tsx and STATS_OVERLAY).
const COLUMN_LEFT = 16;
const COLUMN_TOP = 44;
const COLUMN_WIDTH = 118;
const COLUMN_RIGHT = COLUMN_LEFT + COLUMN_WIDTH;
const GROUP_GAP = 13;
const DIVIDER_HEIGHT = 1;
const SCRIM_WIDTH = 150;
const PP_BOX = 32;

// Sums of scaled font metrics carry float noise (0.8 × 15 + 0.2 × 15); round it away so positions are stable.
const tidy = (value: number) => Math.round(value * 1e6) / 1e6;

/** One item of a group: builds its lines at `top`, `gap` below the item before it. */
interface GroupItem {
  gap: number;
  build: (top: number) => { lines: ColumnLine[]; height: number };
}

/**
 * The live stats column (performance, rows, judgements), mirroring StatsOverlay, in design px times `scale`.
 * Empty `lines` when the model shows nothing. `measure` gives a font's ascent, descent and text widths in px.
 * The judgement counts share one column as wide as the widest count, ending at the column's right edge (the live `1fr auto` grid).
 */
export function layoutClipStatsColumn(model: ReadoutModel, scale: number, measure: FontMeasure): ColumnLayout {
  const px = (design: number) => design * scale;
  const ui = (weight: number, size: number) => `${weight} ${px(size)}px ${REWIND_FONTS.ui}`;
  const mono = (weight: number, size: number) => `${weight} ${px(size)}px ${REWIND_FONTS.mono}`;
  const left = px(COLUMN_LEFT);
  const right = px(COLUMN_RIGHT);

  /** The font that sets a line's height: the one with the tallest box (CSS `line-height: normal`). */
  const tallest = (fonts: string[]) =>
    fonts
      .map((font) => measure(font))
      .reduce((best, next) => (next.ascent + next.descent > best.ascent + best.descent ? next : best));

  /** A row of runs on one baseline, laid out from `top`. */
  const row = (top: number, cells: Array<{ x: number; runs: ColumnRun[] }>) => {
    const { ascent, descent } = tallest(cells.flatMap((cell) => cell.runs.map((run) => run.font)));
    const baseline = top + ascent;
    return { lines: cells.map((cell) => ({ x: cell.x, baseline, runs: cell.runs })), height: ascent + descent };
  };

  const groups: GroupItem[][] = [];
  const { performance, rows, judgements } = model;

  if (performance && (performance.pp !== undefined || performance.stars !== undefined)) {
    const items: GroupItem[] = [];
    if (performance.pp !== undefined) {
      const ppFont = `300 ${px(32)}px ${REWIND_FONTS.ui}`;
      const pp = performance.pp;
      items.push({
        gap: 4,
        build: (top) => {
          // line-height: 1 → a 32 px box with the glyph box centred in it
          const { ascent, descent } = measure(ppFont);
          const baseline = top + (px(PP_BOX) - (ascent + descent)) / 2 + ascent;
          return {
            height: px(PP_BOX),
            lines: [
              {
                x: left,
                baseline,
                runs: [
                  { text: pp, font: ppFont, color: REWIND_COLORS.textPrimary, letterSpacing: px(-0.04 * 32) },
                  { text: "pp", font: mono(400, 13), color: REWIND_COLORS.textSecondary, gapBefore: px(4) },
                ],
              },
            ],
          };
        },
      });
    }
    if (performance.stars !== undefined) {
      const stars = `★ ${performance.stars}`;
      items.push({
        gap: 4,
        build: (top) =>
          row(top, [{ x: left, runs: [{ text: stars, font: mono(500, 15), color: REWIND_COLORS.star }] }]),
      });
    }
    groups.push(items);
  }

  if (rows.length > 0) {
    groups.push(
      rows.map((readout) => ({
        gap: 8,
        build: (top: number) => {
          const label = row(top, [
            { x: left, runs: [{ text: readout.label, font: ui(400, 11.5), color: REWIND_COLORS.textSecondary }] },
          ]);
          const valueRuns: ColumnRun[] = [
            { text: readout.value, font: mono(500, 17), color: REWIND_COLORS.textPrimary },
          ];
          if (readout.suffix)
            valueRuns.push({ text: readout.suffix, font: mono(500, 12), color: REWIND_COLORS.textSecondary });
          const value = row(top + label.height + px(1), [{ x: left, runs: valueRuns }]);
          return { lines: [...label.lines, ...value.lines], height: label.height + px(1) + value.height };
        },
      })),
    );
  }

  if (judgements.length > 0) {
    const countFont = mono(500, 16);
    const countsWidth = Math.max(...judgements.map((readout) => measure(countFont, String(readout.count)).width));
    const countsLeft = right - countsWidth;
    groups.push(
      judgements.map((readout) => ({
        gap: 7,
        build: (top: number) =>
          row(top, [
            {
              x: left,
              runs: [
                {
                  text: readout.label,
                  font: ui(600, readout.key === "sliderBreak" || readout.key === "sliderEnd" ? 12.5 : 13),
                  color: readout.color,
                },
              ],
            },
            {
              x: countsLeft,
              runs: [{ text: String(readout.count), font: countFont, color: REWIND_COLORS.textPrimary }],
            },
          ]),
      })),
    );
  }

  const lines: ColumnLine[] = [];
  const dividers: ColumnLayout["dividers"] = [];
  let y = px(COLUMN_TOP);
  groups.forEach((items, index) => {
    if (index > 0) {
      y += px(GROUP_GAP);
      dividers.push({ x: tidy(left), y: tidy(y), width: tidy(px(COLUMN_WIDTH)), height: tidy(px(DIVIDER_HEIGHT)) });
      y += px(DIVIDER_HEIGHT) + px(GROUP_GAP);
    }
    items.forEach((item, itemIndex) => {
      if (itemIndex > 0) y += px(item.gap);
      const built = item.build(y);
      lines.push(...built.lines);
      y += built.height;
    });
  });
  return {
    lines: lines.map((line) => ({ ...line, baseline: tidy(line.baseline) })),
    dividers,
    bottom: tidy(y),
  };
}

const fontSize = (font: string) => Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 16);

/**
 * Draws the scrim and the stats column on an exported frame. Returns false, drawing nothing, when the column is empty.
 * With `shade` off there is no scrim: every run gets a near-black outline and the grey labels go one step brighter,
 * as in the viewer.
 */
export function drawSidePanel(
  ctx: CanvasRenderingContext2D,
  model: ReadoutModel,
  frame: { width: number; height: number },
  options: { shade?: boolean } = {},
): boolean {
  const shade = options.shade !== false;
  const scale = frame.height / CLIP_STATS_DESIGN_HEIGHT;
  ctx.save();
  try {
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    const spacing = (px: number) => {
      if ("letterSpacing" in ctx)
        (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${px}px`;
    };
    // Font boxes are shared by many rows, but only within this draw: fonts and
    // scale may change before the next frame. Value widths always stay fresh.
    const fontMetrics = new Map<string, ReturnType<FontMeasure>>();
    const measure: FontMeasure = (font, text) => {
      const cached = text === undefined ? fontMetrics.get(font) : undefined;
      if (cached) return cached;
      ctx.font = font;
      spacing(0);
      const metrics = ctx.measureText(text ?? "0");
      const size = fontSize(font);
      const ascent = metrics.fontBoundingBoxAscent;
      const descent = metrics.fontBoundingBoxDescent;
      const measured = {
        ascent: Number.isFinite(ascent) ? ascent : 0.8 * size,
        descent: Number.isFinite(descent) ? descent : 0.2 * size,
        width: text === undefined ? 0 : metrics.width,
      };
      if (text === undefined) fontMetrics.set(font, measured);
      return measured;
    };
    const layout = layoutClipStatsColumn(model, scale, measure);
    if (layout.lines.length === 0) return false;

    if (shade) {
      const scrim = ctx.createLinearGradient(0, 0, SCRIM_WIDTH * scale, 0);
      scrim.addColorStop(0, "rgba(12,12,14,0.8)");
      scrim.addColorStop(0.72, "rgba(12,12,14,0.55)");
      scrim.addColorStop(1, "rgba(12,12,14,0)");
      ctx.fillStyle = scrim;
      ctx.fillRect(0, 0, SCRIM_WIDTH * scale, frame.height);
    }

    ctx.fillStyle = REWIND_COLORS.statDivider;
    for (const divider of layout.dividers) ctx.fillRect(divider.x, divider.y, divider.width, divider.height);

    ctx.shadowColor = "rgba(0,0,0,0.85)";
    ctx.shadowBlur = 3 * scale;
    ctx.shadowOffsetY = 1 * scale;
    if (!shade) {
      ctx.lineJoin = "round";
      ctx.lineWidth = 3 * scale;
      ctx.strokeStyle = "rgba(0,0,0,0.9)";
    }
    const widthOf = (run: ColumnRun) => {
      ctx.font = run.font;
      spacing(run.letterSpacing ?? 0);
      return ctx.measureText(run.text).width;
    };
    const paint = (run: ColumnRun, x: number, baseline: number) => {
      ctx.font = run.font;
      ctx.fillStyle = !shade && run.color === REWIND_COLORS.textSecondary ? REWIND_COLORS.textBright : run.color;
      spacing(run.letterSpacing ?? 0);
      if (!shade) ctx.strokeText(run.text, x, baseline);
      ctx.fillText(run.text, x, baseline);
    };
    for (const line of layout.lines) {
      let x = line.x;
      for (let index = 0; index < line.runs.length; index++) {
        const run = line.runs[index];
        x += run.gapBefore ?? 0;
        paint(run, x, line.baseline);
        if (index + 1 < line.runs.length) x += widthOf(run);
      }
    }
    return true;
  } finally {
    ctx.restore();
  }
}
