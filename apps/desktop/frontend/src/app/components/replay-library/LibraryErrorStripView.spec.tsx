import { cleanup, render, screen } from "@testing-library/react";
import type { LibraryErrorStrip } from "../../../../../shared/library-error-strip";
import { validateLibraryErrorStrip } from "../../../../../shared/library-error-strip";
import { LibraryErrorStripView } from "./LibraryReplay";

type StableStrip = Extract<LibraryErrorStrip, { ruleset: "stable" }>;

// This is the unchanged wire budget, independent of the defensive count preflight.
const STRIP_WIRE_BYTES = 64 * 1024;
const CHANNELS = ["ok", "meh", "miss", "sliderEndMiss", "sliderBreak"] as const;
const COLORS = ["#8fe8af", "#f5cd6e", "#ff7082", "#b5b0d6", "#c7b3ff"];
const HEIGHTS = [6, 8, 12, 5, 9];
const TOPS = [5, 4, 2, 5.5, 3.5];

function stable(overrides: Partial<StableStrip> = {}): StableStrip {
  return {
    version: 1,
    timeBasis: "map-ms",
    ruleset: "stable",
    mapStartMs: 0,
    mapEndMs: 0,
    evaluatedThrough: 0,
    endpointBasis: "recorded-end",
    synthesizedEndpoint: true,
    ok: [],
    meh: [],
    miss: [],
    sliderEndMiss: [],
    sliderBreak: [],
    ...overrides,
  };
}

const envelope = (strip: LibraryErrorStrip) => ({ state: "known" as const, value: strip });
const wireBytes = (strip: LibraryErrorStrip) => Buffer.byteLength(JSON.stringify(envelope(strip)), "utf8");

function renderedChannels(strip: LibraryErrorStrip) {
  const started = performance.now();
  render(<LibraryErrorStripView strip={strip} />);
  const renderMs = performance.now() - started;
  const svg = screen.getByRole("img", { name: "Replay judgement error strip" });
  const paths = Array.from(svg.querySelectorAll("path"));
  expect(svg.tagName.toLowerCase()).toBe("svg");
  expect(svg.getAttribute("viewBox")).toBe("0 0 1000 16");
  expect(svg.getAttribute("preserveAspectRatio")).toBe("none");
  expect(svg.childElementCount).toBe(6);
  expect(svg.querySelectorAll("*")).toHaveLength(6);
  expect(paths).toHaveLength(6);
  expect(paths[0].getAttribute("d")).toBe("M0 8H1000");
  expect(paths[0].getAttribute("stroke")).toBe("rgba(255,255,255,.2)");
  expect(paths[0].getAttribute("stroke-width")).toBe("1");
  paths.slice(1).forEach((path, index) => {
    expect(path.getAttribute("stroke")).toBe(COLORS[index]);
    expect(path.getAttribute("stroke-width")).toBe("1.5");
  });
  return { paths: paths.slice(1), renderMs };
}

function segments(path: Element) {
  const d = path.getAttribute("d") ?? "";
  const matches = Array.from(d.matchAll(/M(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)v(\d+(?:\.\d+)?)/g));
  // Account for the entire path, including duplicated commands; reject NaN/Infinity or stray syntax.
  expect(matches.map((match) => match[0]).join("")).toBe(d);
  return matches.map((match) => ({ x: Number(match[1]), top: Number(match[2]), height: Number(match[3]) }));
}

function diagnostic(label: string, strip: StableStrip, paths: Element[], renderMs: number) {
  // Diagnostic only: React/jsdom construction is not playback, layout, paint or native presentation timing.
  console.info("library-error-strip-headless", JSON.stringify({
    label,
    marks: CHANNELS.reduce((sum, channel) => sum + strip[channel].length, 0),
    wireBytes: wireBytes(strip),
    pathBytes: paths.reduce((sum, path) => sum + Buffer.byteLength(path.getAttribute("d") ?? "", "utf8"), 0),
    pathElements: paths.length + 1,
    renderMs,
  }));
}

afterEach(cleanup);

describe("LibraryErrorStripView", () => {
  it("keeps all five Stable channels, duplicate marks, and observed markers outside the nominal map domain", () => {
    const strip = stable({
      mapStartMs: 1000, mapEndMs: 2000, evaluatedThrough: 2200,
      ok: [800, 800, 1200], meh: [1600], miss: [2400], sliderEndMiss: [2000], sliderBreak: [2200],
    });
    const { paths } = renderedChannels(strip);
    expect(paths.map((path) => path.getAttribute("d"))).toEqual([
      "M0.00 5v6M0.00 5v6M250.00 5v6",
      "M500.00 4v8",
      "M1000.00 2v12",
      "M750.00 5.5v5",
      "M875.00 3.5v9",
    ]);
  });

  it("uses the lazer component-miss channel and includes evaluatedThrough beyond the last event", () => {
    const strip: LibraryErrorStrip = {
      version: 1, timeBasis: "map-ms", ruleset: "lazer", mapStartMs: 0, mapEndMs: 1000,
      evaluatedThrough: 1500, endpointBasis: "health-derived", synthesizedEndpoint: false,
      ok: [0], meh: [300], miss: [600], sliderEndMiss: [900], componentMiss: [1200, 1200],
    };
    const { paths } = renderedChannels(strip);
    expect(paths.map((path) => path.getAttribute("d"))).toEqual([
      "M0.00 5v6", "M200.00 4v8", "M400.00 2v12", "M600.00 5.5v5", "M800.00 3.5v9M800.00 3.5v9",
    ]);
  });

  it("retains a constant SVG for empty channels and a finite zero-width domain", () => {
    const { paths } = renderedChannels(stable({ mapStartMs: 123, mapEndMs: 123, evaluatedThrough: 123, miss: [123, 123] }));
    expect(paths.map((path) => path.getAttribute("d"))).toEqual(["", "", "M0.00 2v12M0.00 2v12", "", ""]);
  });

  it("keeps finite coordinates at the largest admitted positive and negative timestamps", () => {
    const strip = stable({
      mapStartMs: -Number.MAX_SAFE_INTEGER, mapEndMs: Number.MAX_SAFE_INTEGER,
      ok: [-Number.MAX_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER],
    });
    expect(() => validateLibraryErrorStrip(envelope(strip))).not.toThrow();
    const { paths } = renderedChannels(strip);
    expect(paths[0].getAttribute("d")).toBe("M0.00 5v6M500.00 5v6M1000.00 5v6");
  });

  it.each([
    { label: "dense-3125", counts: [225, 129, 2173, 529, 69], total: 3125 },
    { label: "dense-3105", counts: [468, 158, 2308, 57, 114], total: 3105 },
  ])("renders every mark of $label without adding per-mark DOM nodes", ({ label, counts, total }) => {
    // The counts match the two source-proved dense shapes; timestamps are synthetic, with deliberate duplicates.
    const strip = stable({ mapStartMs: 100000, mapEndMs: 200000, evaluatedThrough: 200500 });
    CHANNELS.forEach((channel, index) => {
      strip[channel] = Array.from({ length: counts[index] }, (_, mark) => 100000 + Math.floor(mark / 2) * 32);
    });
    strip.miss[strip.miss.length - 1] = 201000;
    expect(CHANNELS.reduce((sum, channel) => sum + strip[channel].length, 0)).toBe(total);
    expect(wireBytes(strip)).toBeLessThan(STRIP_WIRE_BYTES);
    expect(() => validateLibraryErrorStrip(envelope(strip))).not.toThrow();
    const { paths, renderMs } = renderedChannels(strip);
    const invalid: string[] = [];
    paths.forEach((path, channel) => {
      const points = segments(path);
      expect(points).toHaveLength(counts[channel]);
      expect(points[0]).toEqual(points[1]);
      points.forEach((point, mark) => {
        // Invert the known fixture extent. Two-decimal SVG x rounding permits at most 0.505ms error.
        const reconstructedTime = 100000 + point.x * 101;
        if (!Number.isFinite(point.x) || point.x < 0 || point.x > 1000 ||
          point.top !== TOPS[channel] || point.height !== HEIGHTS[channel] ||
          Math.abs(reconstructedTime - strip[CHANNELS[channel]][mark]) > 0.506) invalid.push(`${channel}:${mark}`);
      });
    });
    expect(invalid).toEqual([]);
    expect(segments(paths[2]).at(-1)).toEqual({ x: 1000, top: 2, height: 12 });
    diagnostic(label, strip, paths, renderMs);
  });

  it("renders the maximum mark count fitting the 64KiB minimal valid payload without truncation or a spread-stack failure", () => {
    const strip = stable({ ok: [0], meh: [0], miss: [0], sliderEndMiss: [0], sliderBreak: [0] });
    // A further zero in a nonempty channel costs exactly two ASCII bytes. Zero is the shortest valid number.
    const additional = Math.floor((STRIP_WIRE_BYTES - wireBytes(strip)) / 2);
    CHANNELS.forEach((channel, index) => {
      strip[channel] = Array(1 + Math.floor(additional / CHANNELS.length) + (index < additional % CHANNELS.length ? 1 : 0)).fill(0);
    });
    const marks = CHANNELS.reduce((sum, channel) => sum + strip[channel].length, 0);
    expect(marks).toBeGreaterThan(32000);
    expect(wireBytes(strip)).toBeLessThanOrEqual(STRIP_WIRE_BYTES);
    expect(wireBytes(strip)).toBeGreaterThan(STRIP_WIRE_BYTES - 2);
    expect(() => validateLibraryErrorStrip(envelope(strip))).not.toThrow();
    const overflow = { ...strip, ok: [...strip.ok, 0] };
    expect(wireBytes(overflow)).toBeGreaterThan(STRIP_WIRE_BYTES);
    expect(() => validateLibraryErrorStrip(envelope(overflow))).toThrow("Invalid library error strip");
    const { paths, renderMs } = renderedChannels(strip);
    paths.forEach((path, index) => {
      // Every duplicate remains an explicit drawing command in its original channel.
      expect(path.getAttribute("d")).toBe(`M0.00 ${TOPS[index]}v${HEIGHTS[index]}`.repeat(strip[CHANNELS[index]].length));
      expect(segments(path)).toHaveLength(strip[CHANNELS[index]].length);
    });
    diagnostic("maximum-wire-fit", strip, paths, renderMs);
  });
});
