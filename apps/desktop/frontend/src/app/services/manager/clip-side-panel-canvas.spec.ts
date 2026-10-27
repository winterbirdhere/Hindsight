import { CLIP_STATS_DESIGN_HEIGHT, drawSidePanel, layoutClipStatsColumn } from "./clip-side-panel-canvas";
import type { ColumnLayout, ColumnLine, FontMeasure } from "./clip-side-panel-canvas";
import type { ReadoutModel } from "../analysis/readout-model";
import { REWIND_COLORS } from "../../styles/tokens";

const sizeOf = (font: string) => Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1]);
const measure: FontMeasure = (font, text = "") => ({ ascent: 0.8 * sizeOf(font), descent: 0.2 * sizeOf(font), width: 0.6 * sizeOf(font) * text.length });

const identity: ReadoutModel["identity"] = { title: "ANiMA", mods: "NM", ruleset: "Stable" };
const fixture: ReadoutModel = {
  identity,
  performance: { pp: "195.8", stars: "6.34" },
  rows: [
    { key: "ur", label: "UR", value: "178.0" },
    { key: "bias", label: "Bias", value: "−1.5", suffix: " ms" },
    { key: "combo", label: "Max Combo", value: "441", suffix: "/1140" },
  ],
  judgements: [
    { key: "100", label: "100", count: 25, color: REWIND_COLORS.judgement100 },
    { key: "50", label: "50", count: 2, color: REWIND_COLORS.judgement50 },
    { key: "miss", label: "Miss", count: 2, color: REWIND_COLORS.judgementMiss },
    { key: "sliderBreak", label: "Break", count: 2, color: REWIND_COLORS.sliderBreak },
    { key: "sliderEnd", label: "End", count: 4, color: REWIND_COLORS.sliderEnd },
  ],
};

const lineWith = (layout: ColumnLayout, text: string): ColumnLine => {
  const line = layout.lines.find((candidate) => candidate.runs[0]?.text === text);
  if (!line) throw new Error(`No line starts with "${text}"`);
  return line;
};

describe("layoutClipStatsColumn", () => {
  it("stacks performance, rows and judgements with a divider between groups", () => {
    const layout = layoutClipStatsColumn(fixture, 1, measure);
    expect(layout.dividers).toEqual([
      { x: 16, y: 108, width: 118, height: 1 },
      { x: 16, y: 239.5, width: 118, height: 1 },
    ]);
    expect(layout.bottom).toBeCloseTo(361.5);
  });

  it("centres the pp line in its 32 px box and keeps pp on its baseline", () => {
    const [pp, stars] = layoutClipStatsColumn(fixture, 1, measure).lines;
    expect(pp.baseline).toBeCloseTo(69.6);
    expect(pp.x).toBe(16);
    expect(pp.runs.map((run) => run.text)).toEqual(["195.8", "pp"]);
    expect(pp.runs[0].font).toMatch(/^300 32px /);
    expect(pp.runs[0].letterSpacing).toBeCloseTo(-1.28);
    expect(pp.runs[1].gapBefore).toBe(4);
    expect(pp.runs[1].font).toMatch(/^400 13px /);
    expect(pp.runs[1].color).toBe(REWIND_COLORS.textSecondary);
    expect(stars.runs).toEqual([expect.objectContaining({ text: "★ 6.34", color: REWIND_COLORS.star })]);
    expect(stars.runs[0].font).toMatch(/^500 15px /);
    expect(stars.baseline).toBeCloseTo(92);
  });

  it("centres the pp line even when the font's box is not 32 px", () => {
    const tall: FontMeasure = (font) => ({ ascent: 0.9 * sizeOf(font), descent: 0.3 * sizeOf(font), width: 0 });
    const [pp] = layoutClipStatsColumn(fixture, 1, tall).lines;
    // box 38.4 in a 32 px line: top 44 + (32 − 38.4) / 2, plus the 28.8 ascent
    expect(pp.baseline).toBeCloseTo(44 + (32 - 38.4) / 2 + 28.8);
  });

  it("puts a row's label above its value and the suffix on the value's baseline", () => {
    const layout = layoutClipStatsColumn(fixture, 1, measure);
    const label = lineWith(layout, "UR");
    expect(label.baseline).toBeCloseTo(131.2);
    expect(label.runs[0].font).toMatch(/^400 11.5px /);
    expect(label.runs[0].color).toBe(REWIND_COLORS.textSecondary);
    const value = lineWith(layout, "178.0");
    expect(value.baseline).toBeCloseTo(148.1);
    expect(value.runs[0].font).toMatch(/^500 17px /);
    expect(value.runs[0].color).toBe(REWIND_COLORS.textPrimary);
    const bias = lineWith(layout, "−1.5");
    expect(bias.runs.map((run) => run.text)).toEqual(["−1.5", " ms"]);
    expect(bias.runs[1].font).toMatch(/^500 12px /);
    expect(bias.runs[1].color).toBe(REWIND_COLORS.textSecondary);
    expect(bias.runs[1].gapBefore ?? 0).toBe(0);
    // rows are 8 px apart: label 11.5 + 1 + value 17 = 29.5 tall
    expect(lineWith(layout, "Bias").baseline).toBeCloseTo(122 + 29.5 + 8 + 9.2);
  });

  it("puts the counts in one column that ends at 134 px and starts each count at its left edge, on the label's baseline", () => {
    const layout = layoutClipStatsColumn(fixture, 1, measure);
    const label = lineWith(layout, "100");
    const first = lineWith(layout, "25");
    expect(label.x).toBe(16);
    expect(label.baseline).toBeCloseTo(266.3);
    expect(label.runs[0].font).toMatch(/^600 13px /);
    expect(label.runs[0].color).toBe(REWIND_COLORS.judgement100);
    expect(first.baseline).toBeCloseTo(266.3);
    expect(first.runs[0].font).toMatch(/^500 16px /);
    expect(first.runs[0].color).toBe(REWIND_COLORS.textPrimary);
    // the widest count is "25": 2 × 0.6 × 16 = 19.2 px, so the column starts at 134 − 19.2
    const counts = layout.lines.filter((line) => line.runs[0].font.startsWith("500 16px"));
    expect(counts.map((line) => line.runs[0].text)).toEqual(["25", "2", "2", "2", "4"]);
    for (const count of counts) {
      expect(count.x).toBeCloseTo(114.8);
    }
    // judgement rows are 16 tall and 7 apart, and each count shares its label's baseline
    expect(lineWith(layout, "50").baseline).toBeCloseTo(266.3 + 23);
    expect(counts[1].baseline).toBeCloseTo(266.3 + 23);
  });

  it("sizes the count column by the widest count, at one digit and at scale 2", () => {
    const single: ReadoutModel = { ...fixture, judgements: fixture.judgements.map((row) => ({ ...row, count: 7 })) };
    const oneDigit = layoutClipStatsColumn(single, 1, measure).lines.filter((line) => line.runs[0].font.startsWith("500 16px"));
    expect(oneDigit).toHaveLength(5);
    for (const count of oneDigit) expect(count.x).toBeCloseTo(124.4); // 134 − 0.6 × 16
    const scaled = layoutClipStatsColumn(fixture, 2, measure).lines.filter((line) => line.runs[0].font.startsWith("500 32px"));
    expect(scaled).toHaveLength(5);
    for (const count of scaled) expect(count.x).toBeCloseTo(229.6); // 268 − 2 × 0.6 × 32
  });

  it("uses 12.5 px for Break and End", () => {
    const layout = layoutClipStatsColumn(fixture, 1, measure);
    expect(lineWith(layout, "Break").runs[0].font).toMatch(/^600 12.5px /);
    expect(lineWith(layout, "End").runs[0].font).toMatch(/^600 12.5px /);
    expect(lineWith(layout, "Miss").runs[0].font).toMatch(/^600 13px /);
  });

  it("scales every position and font size", () => {
    const layout = layoutClipStatsColumn(fixture, 2, measure);
    expect(layout.dividers[0]).toEqual({ x: 32, y: 216, width: 236, height: 2 });
    expect(layout.bottom).toBeCloseTo(723);
    const [pp] = layout.lines;
    expect(pp.runs[0].font).toMatch(/^300 64px /);
    expect(pp.runs[1].gapBefore).toBe(8);
    expect(pp.baseline).toBeCloseTo(139.2);
    expect(lineWith(layout, "25").x).toBeCloseTo(229.6);
  });

  it("starts at the top when a group is missing", () => {
    const layout = layoutClipStatsColumn({ ...fixture, performance: undefined }, 1, measure);
    expect(lineWith(layout, "UR").baseline).toBeCloseTo(53.2);
    expect(layout.dividers).toHaveLength(1);
  });

  it("draws the performance line that is present when the other is absent", () => {
    const starsOnly = layoutClipStatsColumn({ ...fixture, performance: { stars: "6.34" } }, 1, measure);
    expect(starsOnly.lines[0].runs[0].text).toBe("★ 6.34");
    expect(starsOnly.lines[0].baseline).toBeCloseTo(44 + 12);
    const ppOnly = layoutClipStatsColumn({ ...fixture, performance: { pp: "—" } }, 1, measure);
    expect(ppOnly.lines[0].runs[0].text).toBe("—");
    expect(ppOnly.dividers[0].y).toBeCloseTo(44 + 32 + 13);
  });

  it("is empty for a model with nothing switched on", () => {
    for (const model of [
      { identity, rows: [], judgements: [] },
      { identity, performance: {}, rows: [], judgements: [] },
    ] satisfies ReadoutModel[]) {
      const layout = layoutClipStatsColumn(model, 1, measure);
      expect(layout.lines).toEqual([]);
      expect(layout.dividers).toEqual([]);
    }
  });
});

function recordingContext(widthPerPx = 0.6, withLetterSpacing = true) {
  const calls: Array<[string, unknown[]]> = [];
  const gradients: Array<{ args: number[]; stops: Array<[number, string]> }> = [];
  const state = { font: "", letterSpacing: "0px", shadowColor: "", shadowBlur: 0, shadowOffsetY: 0, fillStyle: "" as unknown };
  const fillTexts: Array<{ text: string; x: number; y: number; font: string; fillStyle: unknown; shadowBlur: number; textAlign: string; letterSpacing: string }> = [];
  const fillRects: Array<{ args: number[]; fillStyle: unknown; shadowColor: string }> = [];
  const strokeTexts: Array<{ text: string; x: number; y: number; lineWidth: unknown; strokeStyle: unknown; lineJoin: unknown; before: number }> = [];
  const saved: Array<typeof state & { textAlign: string }> = [];
  const ctx = {
    // like a canvas, save() snapshots the drawing state and restore() brings it back
    save: () => {
      calls.push(["save", []]);
      saved.push({ ...state, textAlign: ctxProps.textAlign });
    },
    restore: () => {
      calls.push(["restore", []]);
      const previous = saved.pop();
      if (!previous) return;
      const { textAlign, ...rest } = previous;
      Object.assign(state, rest);
      ctxProps.textAlign = textAlign;
    },
    createLinearGradient: (...args: number[]) => {
      const gradient = { args, stops: [] as Array<[number, string]>, addColorStop: (at: number, color: string) => void gradient.stops.push([at, color]) };
      gradients.push(gradient);
      return gradient;
    },
    fillRect: (...args: number[]) => {
      calls.push(["fillRect", args]);
      fillRects.push({ args, fillStyle: state.fillStyle, shadowColor: state.shadowColor });
    },
    fillText: (text: string, x: number, y: number) => {
      calls.push(["fillText", [text, x, y]]);
      fillTexts.push({ text, x, y, font: state.font, fillStyle: state.fillStyle, shadowBlur: state.shadowBlur, textAlign: String(ctxProps.textAlign), letterSpacing: state.letterSpacing });
    },
    strokeText: (text: string, x: number, y: number) => {
      const own = ctx as unknown as { lineWidth: unknown; strokeStyle: unknown; lineJoin: unknown };
      strokeTexts.push({ text, x, y, lineWidth: own.lineWidth, strokeStyle: own.strokeStyle, lineJoin: own.lineJoin, before: fillTexts.length });
    },
    measureText: (text: string) => {
      const size = sizeOf(state.font);
      return { width: text.length * widthPerPx * size, fontBoundingBoxAscent: 0.8 * size, fontBoundingBoxDescent: 0.2 * size };
    },
  };
  const ctxProps = { textAlign: "left" };
  const accessors = Object.fromEntries(
    (["font", ...(withLetterSpacing ? ["letterSpacing" as const] : []), "shadowColor", "shadowBlur", "shadowOffsetY", "fillStyle"] as const).map((key) => [
      key,
      { get: () => state[key], set: (value: never) => void ((state as Record<string, unknown>)[key] = value), enumerable: true },
    ]),
  );
  Object.defineProperties(ctx, { ...accessors, textAlign: { get: () => ctxProps.textAlign, set: (value: string) => void (ctxProps.textAlign = value), enumerable: true } });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, gradients, fillTexts, fillRects, strokeTexts, state };
}

it("measures each font box once per draw and only run widths needed to place a following run", () => {
  const { ctx } = recordingContext();
  const measured: Array<{ font: string; text: string }> = [];
  const original = ctx.measureText.bind(ctx);
  jest.spyOn(ctx, "measureText").mockImplementation(text => {
    measured.push({ font: ctx.font, text });
    return original(text);
  });
  drawSidePanel(ctx, fixture, { width: 1920, height: 1080 });
  const boxes = measured.filter(call => call.text === "0");
  expect(boxes.length).toBe(new Set(boxes.map(call => call.font)).size);
  expect(measured.some(call => ["pp", "UR", "Max Combo", " ms", "/1140"].includes(call.text))).toBe(false);
  // Repeated counts must still be measured; only the font box is cached.
  expect(measured.filter(call => call.text === "2")).toHaveLength(3);
  const firstCount = measured.length;
  drawSidePanel(ctx, fixture, { width: 1920, height: 1080 });
  expect(measured.length).toBe(firstCount * 2);
});

describe("drawSidePanel", () => {
  it("draws the scrim and every run, and reports that it drew", () => {
    const { ctx, calls, gradients, fillTexts, fillRects } = recordingContext();
    expect(drawSidePanel(ctx, fixture, { width: 1920, height: 1080 })).toBe(true);
    const scale = 1080 / CLIP_STATS_DESIGN_HEIGHT;
    expect(calls[0][0]).toBe("save");
    expect(calls[calls.length - 1][0]).toBe("restore");
    const scrim = fillRects[0];
    expect(scrim.args[0]).toBe(0);
    expect(scrim.args[1]).toBe(0);
    expect(scrim.args[2]).toBeCloseTo(232.76, 1);
    expect(scrim.args[3]).toBe(1080);
    expect(scrim.fillStyle).toBe(gradients[0]);
    expect(gradients[0].stops).toEqual([
      [0, "rgba(12,12,14,0.8)"],
      [0.72, "rgba(12,12,14,0.55)"],
      [1, "rgba(12,12,14,0)"],
    ]);
    // two dividers follow the scrim, drawn without a shadow
    const dividers = fillRects.slice(1);
    expect(dividers).toHaveLength(2);
    expect(dividers.every((rect) => rect.fillStyle === REWIND_COLORS.statDivider)).toBe(true);
    expect(dividers[0].args[2]).toBeCloseTo(118 * scale);
    expect(dividers.every((rect) => rect.shadowColor === "" || rect.shadowColor === "transparent")).toBe(true);
    const expectedTexts = ["195.8", "pp", "★ 6.34", "UR", "178.0", "Bias", "−1.5", " ms", "Max Combo", "441", "/1140", "100", "25", "50", "2", "Miss", "2", "Break", "2", "End", "4"];
    expect(fillTexts.map((entry) => entry.text)).toEqual(expectedTexts);
    for (const entry of fillTexts) {
      expect(entry.shadowBlur).toBeCloseTo(3 * scale);
    }
  });

  it("outlines nothing while the shade is on", () => {
    const { ctx, strokeTexts } = recordingContext();
    drawSidePanel(ctx, fixture, { width: 1920, height: 1080 }, { shade: true });
    expect(strokeTexts).toEqual([]);
  });

  describe("without the shade", () => {
    const scale = 1080 / CLIP_STATS_DESIGN_HEIGHT;

    it("draws no scrim: only the dividers are filled", () => {
      const { ctx, gradients, fillRects } = recordingContext();
      expect(drawSidePanel(ctx, fixture, { width: 1920, height: 1080 }, { shade: false })).toBe(true);
      expect(gradients).toEqual([]);
      expect(fillRects).toHaveLength(2);
      expect(fillRects.every((rect) => rect.fillStyle === REWIND_COLORS.statDivider)).toBe(true);
    });

    it("outlines every run in near black before filling it", () => {
      const { ctx, fillTexts, strokeTexts } = recordingContext();
      drawSidePanel(ctx, fixture, { width: 1920, height: 1080 }, { shade: false });
      expect(strokeTexts.map((entry) => [entry.text, entry.x, entry.y])).toEqual(fillTexts.map((entry) => [entry.text, entry.x, entry.y]));
      // Each outline is under its own fill.
      expect(strokeTexts.map((entry) => entry.before)).toEqual(fillTexts.map((_entry, index) => index));
      for (const entry of strokeTexts) {
        expect(entry.lineWidth).toBeCloseTo(3 * scale);
        expect(entry.strokeStyle).toBe("rgba(0,0,0,0.9)");
        expect(entry.lineJoin).toBe("round");
      }
    });

    it("draws the grey labels one step brighter and leaves the other colours", () => {
      const { ctx, fillTexts } = recordingContext();
      drawSidePanel(ctx, fixture, { width: 1920, height: 1080 }, { shade: false });
      const colorOf = (text: string) => fillTexts.find((entry) => entry.text === text)?.fillStyle;
      expect(colorOf("UR")).toBe(REWIND_COLORS.textBright);
      expect(colorOf("pp")).toBe(REWIND_COLORS.textBright);
      expect(colorOf("/1140")).toBe(REWIND_COLORS.textBright);
      expect(colorOf("195.8")).toBe(REWIND_COLORS.textPrimary);
      expect(colorOf("★ 6.34")).toBe(REWIND_COLORS.star);
      expect(colorOf("Miss")).toBe(REWIND_COLORS.judgementMiss);
    });

    it("keeps the shaded column's colours when the shade is on", () => {
      const { ctx, fillTexts } = recordingContext();
      drawSidePanel(ctx, fixture, { width: 1920, height: 1080 });
      expect(fillTexts.find((entry) => entry.text === "UR")?.fillStyle).toBe(REWIND_COLORS.textSecondary);
    });
  });

  it("shadows text and sets the shadow offset and colour", () => {
    const { ctx, state } = recordingContext();
    const seen: Array<[string, number]> = [];
    const original = ctx.fillText.bind(ctx);
    ctx.fillText = ((text: string, x: number, y: number) => {
      seen.push([state.shadowColor, state.shadowOffsetY]);
      original(text, x, y);
    }) as CanvasRenderingContext2D["fillText"];
    drawSidePanel(ctx, fixture, { width: 1920, height: 1080 });
    expect(seen[0][0]).toBe("rgba(0,0,0,0.85)");
    expect(seen[0][1]).toBeCloseTo(1080 / 696);
  });

  it("starts every count at the shared column's left edge and advances runs by their measured width", () => {
    const { ctx, fillTexts } = recordingContext();
    drawSidePanel(ctx, fixture, { width: 1920, height: 1080 });
    const scale = 1080 / 696;
    // "25" is the widest count: 2 × 0.6 × 16 px (scaled)
    const columnX = 134 * scale - 2 * 0.6 * 16 * scale;
    const counts = fillTexts.filter((entry) => entry.font.startsWith("500 ") && entry.font.includes(`${16 * scale}px`));
    expect(counts.map((entry) => entry.text)).toEqual(["25", "2", "2", "2", "4"]);
    for (const count of counts) {
      expect(count.x).toBeCloseTo(columnX);
      expect(count.textAlign).toBe("left");
    }
    const pp = fillTexts.find((entry) => entry.text === "195.8");
    const unit = fillTexts.find((entry) => entry.text === "pp");
    const ppWidth = "195.8".length * 0.6 * 32 * scale;
    expect(pp?.x).toBeCloseTo(16 * scale);
    expect(unit?.x).toBeCloseTo(16 * scale + ppWidth + 4 * scale);
  });

  it("sets the scaled -0.04em letter spacing for the pp number only, and restores it", () => {
    const { ctx, fillTexts, state } = recordingContext();
    drawSidePanel(ctx, fixture, { width: 1920, height: 1080 });
    const scale = 1080 / 696;
    const spacingOf = (text: string) => fillTexts.find((entry) => entry.text === text)?.letterSpacing;
    expect(String(spacingOf("195.8"))).toMatch(/px$/);
    expect(Number.parseFloat(String(spacingOf("195.8")))).toBeCloseTo(32 * scale * -0.04, 5); // -1.986 px
    expect(spacingOf("pp")).toBe("0px");
    for (const entry of fillTexts.filter((candidate) => candidate.text !== "195.8")) expect(entry.letterSpacing).toBe("0px");
    expect(state.letterSpacing).toBe("0px");
  });

  it("draws on a context without letterSpacing", () => {
    const { ctx, fillTexts } = recordingContext(0.6, false);
    expect("letterSpacing" in ctx).toBe(false);
    expect(drawSidePanel(ctx, fixture, { width: 1920, height: 1080 })).toBe(true);
    expect(fillTexts.map((entry) => entry.text)).toContain("195.8");
  });

  it("draws nothing and reports false for an empty model", () => {
    const { ctx, calls } = recordingContext();
    expect(drawSidePanel(ctx, { identity, rows: [], judgements: [] }, { width: 1920, height: 1080 })).toBe(false);
    expect(calls.filter(([name]) => name === "fillRect" || name === "fillText")).toEqual([]);
  });

  it("does not reach the playfield at 1080p with a five-digit pp and combo", () => {
    const { ctx, fillTexts } = recordingContext(0.6);
    const wide: ReadoutModel = {
      ...fixture,
      performance: { pp: "12345.6", stars: "10.99" },
      rows: [{ key: "combo", label: "Max Combo", value: "12345", suffix: "/12345" }],
      judgements: [{ key: "miss", label: "Miss", count: 12345, color: REWIND_COLORS.judgementMiss }],
    };
    drawSidePanel(ctx, wide, { width: 1920, height: 1080 });
    const right = fillTexts.map((entry) => entry.x + entry.text.length * 0.6 * sizeOf(entry.font));
    expect(Math.max(...right)).toBeLessThan(373);
  });
});
