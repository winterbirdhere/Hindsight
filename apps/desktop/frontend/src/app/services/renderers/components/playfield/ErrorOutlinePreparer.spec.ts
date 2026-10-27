import "reflect-metadata";
import { Container as InversifyContainer } from "inversify";
import { Circle, Container, Graphics, Polygon, Text, Texture } from "pixi.js";
import { GameplayClock } from "../../../common/game/GameplayClock";
import { ErrorOutlineStore, ErrorOutlineTarget } from "../../../common/error-outline";
import { ErrorOutlinePreparer } from "./ErrorOutlinePreparer";

const MISS_RED = 0xff7082;
const BREAK_LILAC = 0xc7b3ff;
// The same colours at 60 % brightness: (255, 112, 130) -> (153, 67, 78) and (199, 179, 255) -> (119, 107, 153).
const DARK_MISS_RED = 0x99434e;
const DARK_BREAK_LILAC = 0x776b99;

const target = (overrides: Partial<ErrorOutlineTarget> = {}): ErrorOutlineTarget => ({
  errorId: "miss:c1",
  emphasis: "full",
  color: MISS_RED,
  position: { x: 120, y: 80 },
  radius: 32,
  appearTime: 1_000,
  holdFrom: 2_000,
  holdMs: 700,
  markObjectId: "c1",
  trail: [],
  taps: [],
  ...overrides,
});

function fixture(targets: ErrorOutlineTarget[] = [target()]) {
  const clock = { timeElapsedInMs: 2_000, playbackRate: 1, controlsLocked: false, isPlaying: true };
  const store = new ErrorOutlineStore();
  store.setTargets(targets);
  const preparer = new ErrorOutlinePreparer(clock as never, store);
  const drawn = () => {
    preparer.update();
    return (preparer.container.children[0] as Graphics).geometry.graphicsData;
  };
  // The rings are the large circles; tap markers are a few pixels across.
  const rings = () =>
    drawn()
      .filter((data) => data.shape instanceof Circle && data.shape.radius > 10)
      .map((data) => {
        const shape = data.shape as Circle;
        return {
          x: shape.x,
          y: shape.y,
          radius: shape.radius,
          width: data.lineStyle.width,
          color: data.lineStyle.color,
          alpha: data.lineStyle.alpha,
        };
      });
  const paths = () =>
    drawn()
      .filter((data) => data.shape instanceof Polygon)
      .map((data) => ({
        points: (data.shape as Polygon).points,
        width: data.lineStyle.width,
        color: data.lineStyle.color,
        alpha: data.lineStyle.alpha,
      }));
  const tapMarks = () =>
    drawn()
      .filter((data) => data.shape instanceof Circle && data.shape.radius <= 10)
      .map((data) => ({
        x: (data.shape as Circle).x,
        y: (data.shape as Circle).y,
        filled: data.fillStyle.visible,
        fill: data.fillStyle.visible ? data.fillStyle.color : undefined,
        line: data.lineStyle.color,
        alpha: data.lineStyle.alpha,
      }));
  const labels = () => {
    preparer.update();
    return ((preparer.container.children[1] as Container).children as Text[])
      .filter((label) => label.visible)
      .map((label) => ({ text: label.text, x: label.position.x, y: label.position.y, alpha: label.alpha }));
  };
  return { clock, store, rings, paths, tapMarks, labels };
}

describe("ErrorOutlinePreparer", () => {
  // jsdom has no 2D canvas for Pixi's white texture; the rings are read from the geometry, never rasterised.
  beforeEach(() => {
    jest.spyOn(Texture, "WHITE", "get").mockReturnValue(Texture.EMPTY as typeof Texture.WHITE);
    jest.spyOn(console, "debug").mockImplementation(() => undefined);
    // jsdom has no 2D canvas, so the tap labels cannot be measured or drawn here; their text and place are read.
    jest.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    jest.spyOn(Text.prototype, "updateText").mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  // The object's radius is 32: the ring's outer edge lies on it, where the approach circle ends, whatever the line width.
  it("rings the inspected error's object on its own edge, in the error's colour", () => {
    const { rings } = fixture();
    expect(rings()).toEqual([{ x: 120, y: 80, radius: 30.5, width: 3, color: MISS_RED, alpha: 1 }]);
  });

  it("draws an incident's other errors thinner and dimmer", () => {
    const member = target({ errorId: "break", emphasis: "light", color: BREAK_LILAC, position: { x: 300, y: 200 } });
    const { rings } = fixture([target(), member]);
    expect(rings()).toEqual([
      { x: 120, y: 80, radius: 30.5, width: 3, color: MISS_RED, alpha: 1 },
      { x: 300, y: 200, radius: 31.25, width: 1.5, color: BREAK_LILAC, alpha: 0.55 },
    ]);
  });

  it("shows nothing before its time or after the hold and fade, and is there at once when its time comes", () => {
    const { clock, rings } = fixture();
    clock.timeElapsedInMs = 999;
    expect(rings()).toEqual([]);
    clock.timeElapsedInMs = 1_000;
    expect(rings()).toEqual([expect.objectContaining({ alpha: 1 })]);
    clock.timeElapsedInMs = 2_900;
    expect(rings()).toEqual([]);
    clock.timeElapsedInMs = 2_800;
    expect(rings()).toEqual([expect.objectContaining({ alpha: expect.closeTo(0.5, 6) })]);
  });

  it("holds for 0.7 s of real time whatever the playback rate", () => {
    const { clock, rings } = fixture();
    // At half rate 0.7 s of real time is 350 ms of map time, and the 0.2 s fade is 100 ms.
    clock.playbackRate = 0.5;
    clock.timeElapsedInMs = 2_350;
    expect(rings()).toEqual([expect.objectContaining({ alpha: 1 })]);
    clock.timeElapsedInMs = 2_400;
    expect(rings()).toEqual([expect.objectContaining({ alpha: expect.closeTo(0.5, 6) })]);
    // At 1.5× (Double Time) the same real time is 1050 ms of map time.
    clock.playbackRate = 1.5;
    clock.timeElapsedInMs = 3_050;
    expect(rings()).toEqual([expect.objectContaining({ alpha: 1 })]);
  });

  it("holds each ring for its own time", () => {
    const { clock, rings } = fixture([target({ holdMs: 300 })]);
    clock.timeElapsedInMs = 2_300;
    expect(rings()).toEqual([expect.objectContaining({ alpha: 1 })]);
    clock.timeElapsedInMs = 2_400;
    expect(rings()).toEqual([expect.objectContaining({ alpha: expect.closeTo(0.5, 6) })]);
    clock.timeElapsedInMs = 2_500;
    expect(rings()).toEqual([]);
  });

  it("draws nothing for a follower in a run of errors, unless it is the one inspected", () => {
    const trail = [1_900, 1_950, 2_000].map((time) => ({ x: time / 10, y: 60, time }));
    const tap = { position: { x: 200, y: 60 }, time: 2_000, certainty: "attributed" as const, offsetMs: 0, label: "0 ms" };
    const { store, rings, paths, tapMarks, labels } = fixture([target({ follower: true, trail, taps: [tap] })]);
    expect([rings(), paths(), tapMarks(), labels()]).toEqual([[], [], [], []]);
    store.setInspected("miss:c1");
    expect(rings()).toHaveLength(1);
    expect(tapMarks()).toHaveLength(1);
  });

  it("draws nothing while playback is paused, and draws again when it goes on", () => {
    const trail = [1_900, 1_950, 2_000].map((time) => ({ x: time / 10, y: 60, time }));
    const tap = { position: { x: 200, y: 60 }, time: 2_000, certainty: "attributed" as const, offsetMs: 0, label: "0 ms" };
    const { clock, rings, paths, tapMarks, labels } = fixture([target({ trail, taps: [tap] })]);
    expect(rings()).toHaveLength(1);
    clock.isPlaying = false;
    expect([rings(), paths(), tapMarks(), labels()]).toEqual([[], [], [], []]);
    clock.isPlaying = true;
    expect(rings()).toHaveLength(1);
    expect(labels()).toHaveLength(1);
  });

  it("draws nothing while a clip export owns the clock", () => {
    const { clock, rings } = fixture();
    expect(rings()).toHaveLength(1);
    clock.controlsLocked = true;
    expect(rings()).toEqual([]);
  });

  describe("miss trail", () => {
    const trail = [1_900, 1_950, 2_000, 2_050].map((time) => ({ x: time / 10, y: 60, time }));
    const tap = (time: number, certainty: "attributed" | "ambiguous", label?: string) => ({
      position: { x: time / 10, y: 60 },
      time,
      certainty,
      offsetMs: time - 2_000,
      label,
    });

    // Eight steps, from 15 % of the trail's strength at its oldest sample to all of it at its newest.
    const step = (count: number) => 0.15 + (0.85 * count) / 8;

    it("draws the cursor's recorded path up to now, in the error's colour, fainter the older it is", () => {
      const { clock, paths } = fixture([target({ trail })]);
      // The trail spans 150 ms; at 2000 its newest third is still to come.
      expect(paths()).toEqual([
        { points: [190, 60, 195, 60], width: 1.5, color: MISS_RED, alpha: expect.closeTo(0.75 * step(3), 6) },
        { points: [195, 60, 200, 60], width: 1.5, color: MISS_RED, alpha: expect.closeTo(0.75 * step(6), 6) },
      ]);
      clock.timeElapsedInMs = 2_100;
      expect(paths()).toHaveLength(3);
      expect(paths()[2]).toEqual({ points: [200, 60, 205, 60], width: 1.5, color: MISS_RED, alpha: expect.closeTo(0.75, 6) });
    });

    it("joins the samples of one step into one line", () => {
      const dense = [1_900, 1_905, 1_910, 2_050].map((time) => ({ x: time / 10, y: 60, time }));
      const { clock, paths } = fixture([target({ trail: dense })]);
      clock.timeElapsedInMs = 2_100;
      expect(paths()).toEqual([
        expect.objectContaining({ points: [190, 60, 190.5, 60, 191, 60], alpha: expect.closeTo(0.75 * step(1), 6) }),
        expect.objectContaining({ points: [191, 60, 205, 60], alpha: expect.closeTo(0.75, 6) }),
      ]);
    });

    it("draws no path from a single sample, and none with the ring gone", () => {
      expect(fixture([target({ trail: trail.slice(2) })]).paths()).toEqual([]);
      const gone = fixture([target({ trail })]);
      gone.clock.timeElapsedInMs = 2_900;
      expect(gone.paths()).toEqual([]);
    });

    it("fades the path with the ring and draws a lighter one for an incident's other errors", () => {
      const { clock, paths } = fixture([target({ trail, emphasis: "light" })]);
      clock.timeElapsedInMs = 2_100;
      expect(paths()[2]).toEqual(expect.objectContaining({ width: 1, alpha: expect.closeTo(0.75 * 0.55, 6) }));
      clock.timeElapsedInMs = 2_800;
      expect(paths()[2].alpha).toBeCloseTo(0.75 * 0.55 * 0.5, 6);
    });

    it("marks an attributed tap with a dot in a darker shade of the error's colour and an ambiguous one with a hollow dot", () => {
      const { tapMarks } = fixture([target({ taps: [tap(1_957, "attributed"), tap(1_990, "ambiguous")] })]);
      expect(tapMarks()).toEqual([
        { x: 195.7, y: 60, filled: true, fill: DARK_MISS_RED, line: DARK_MISS_RED, alpha: 1 },
        { x: 199, y: 60, filled: false, fill: undefined, line: DARK_MISS_RED, alpha: 1 },
      ]);
      // A darker shade of each error's own colour, so a dot on the edge stands out from the ring.
      const lilac = fixture([target({ color: BREAK_LILAC, taps: [tap(1_957, "attributed")] })]);
      expect(lilac.tapMarks()).toEqual([expect.objectContaining({ fill: DARK_BREAK_LILAC, line: DARK_BREAK_LILAC })]);
      expect(lilac.rings()).toEqual([expect.objectContaining({ color: BREAK_LILAC })]);
    });

    it("holds back a tap that has not happened yet", () => {
      const { clock, tapMarks } = fixture([target({ appearTime: 1_900, taps: [tap(1_957, "attributed")] })]);
      clock.timeElapsedInMs = 1_950;
      expect(tapMarks()).toEqual([]);
      clock.timeElapsedInMs = 1_957;
      expect(tapMarks()).toHaveLength(1);
    });

    it("writes a tap's label beside its marker and takes it away with the ring", () => {
      const { clock, store, labels } = fixture([
        target({ taps: [tap(1_957, "attributed", "−43 ms"), tap(1_990, "ambiguous")] }),
      ]);
      expect(labels()).toEqual([{ text: "−43 ms", x: 201.7, y: 54, alpha: 1 }]);
      clock.timeElapsedInMs = 2_800;
      expect(labels()).toEqual([expect.objectContaining({ text: "−43 ms", alpha: expect.closeTo(0.5, 6) })]);
      clock.timeElapsedInMs = 2_900;
      expect(labels()).toEqual([]);
      clock.timeElapsedInMs = 2_000;
      store.setTargets([target({ taps: [tap(1_957, "attributed", "+12 ms"), tap(1_960, "attributed", "+15 ms")] })]);
      expect(labels().map((label) => label.text)).toEqual(["+12 ms", "+15 ms"]);
      store.setTargets([]);
      expect(labels()).toEqual([]);
    });

    it("draws no trail, taps or labels while a clip export owns the clock", () => {
      const { clock, paths, tapMarks, labels } = fixture([
        target({ trail, taps: [tap(1_957, "attributed", "−43 ms")] }),
      ]);
      clock.controlsLocked = true;
      expect([paths(), tapMarks(), labels()]).toEqual([[], [], []]);
    });
  });

  describe("when a later error's ring appears", () => {
    const trail = [1_900, 1_950, 2_000].map((time) => ({ x: time / 10, y: 60, time }));
    const tap = { position: { x: 200, y: 60 }, time: 2_000, certainty: "attributed" as const, offsetMs: 0, label: "0 ms" };
    // The next error appears at 2100, long after this one: the hand-over takes its longest, 0.15 s.
    const older = (overrides: Partial<ErrorOutlineTarget> = {}) => target({ trail, taps: [tap], supersededAt: 2_100, ...overrides });

    it("keeps the earlier one as it is until then", () => {
      const { clock, rings, paths, tapMarks } = fixture([older()]);
      clock.timeElapsedInMs = 2_100;
      expect(rings()).toEqual([expect.objectContaining({ width: 3, alpha: 1 })]);
      expect(paths()[1].alpha).toBeCloseTo(0.75, 6);
      expect(tapMarks()).toEqual([expect.objectContaining({ alpha: 1 })]);
    });

    it("lets the earlier one's trail, tap and label go, and leaves its ring thinner and dimmer", () => {
      const { clock, rings, paths, tapMarks, labels } = fixture([older()]);
      clock.timeElapsedInMs = 2_175;
      expect(rings()).toEqual([{ x: 120, y: 80, radius: 30.875, width: 2.25, color: MISS_RED, alpha: expect.closeTo(0.775, 6) }]);
      expect(paths()[1].alpha).toBeCloseTo(0.75 * 0.5, 6);
      expect(tapMarks()).toEqual([expect.objectContaining({ alpha: expect.closeTo(0.5, 6) })]);
      expect(labels()).toEqual([expect.objectContaining({ text: "0 ms", alpha: expect.closeTo(0.5, 6) })]);
      clock.timeElapsedInMs = 2_250;
      expect(rings()).toEqual([{ x: 120, y: 80, radius: 31.25, width: 1.5, color: MISS_RED, alpha: expect.closeTo(0.55, 6) }]);
      expect([paths(), tapMarks(), labels()]).toEqual([[], [], []]);
    });

    it("takes as long as the two errors are apart, between 0.06 s and 0.15 s", () => {
      const apart = (appearTime: number, time: number) => {
        const { clock, rings } = fixture([older({ appearTime, holdFrom: appearTime })]);
        clock.timeElapsedInMs = time;
        return rings()[0].width;
      };
      // 100 ms apart: half way after 50 ms. 40 ms apart: half way after 30 ms.
      expect(apart(2_000, 2_150)).toBeCloseTo(2.25, 6);
      expect(apart(2_060, 2_130)).toBeCloseTo(2.25, 6);
    });

    it("measures those limits in real time, whatever the playback rate", () => {
      const { clock, rings } = fixture([older()]);
      // At half rate 0.15 s on screen is 75 ms of map time.
      clock.playbackRate = 0.5;
      clock.timeElapsedInMs = 2_137.5;
      expect(rings()[0].width).toBeCloseTo(2.25, 6);
    });

    it("leaves the inspected error as it is", () => {
      const { clock, store, rings, paths, tapMarks } = fixture([older()]);
      store.setInspected("miss:c1");
      clock.timeElapsedInMs = 2_250;
      expect(rings()).toEqual([expect.objectContaining({ width: 3, alpha: 1 })]);
      expect(paths()).toHaveLength(2);
      expect(tapMarks()).toHaveLength(1);
    });

    it("keeps an incident's lighter ring as light as it was", () => {
      const { clock, rings, paths } = fixture([older({ emphasis: "light" })]);
      clock.timeElapsedInMs = 2_250;
      expect(rings()).toEqual([expect.objectContaining({ width: 1.5, alpha: expect.closeTo(0.55, 6) })]);
      expect(paths()).toEqual([]);
    });
  });

  it("is built by the app's container around the one shared store", () => {
    const container = new InversifyContainer({ defaultScope: "Singleton" });
    container.bind(GameplayClock).toSelf();
    container.bind(ErrorOutlineStore).toSelf();
    container.bind(ErrorOutlinePreparer).toSelf();
    const preparer = container.get(ErrorOutlinePreparer);
    container.get(GameplayClock).setDuration(10_000);
    container.get(GameplayClock).seekTo(2_000);
    container.get(GameplayClock).start();
    container.get(ErrorOutlineStore).setTargets([target()]);
    preparer.update();
    expect((preparer.container.children[0] as Graphics).geometry.graphicsData).toHaveLength(1);
    expect(preparer.container.children).toHaveLength(2);
  });

  it("follows the inspection: a new target replaces the old ring, and none clears it", () => {
    const { store, rings } = fixture();
    store.setTargets([target({ position: { x: 10, y: 20 } })]);
    expect(rings()).toEqual([expect.objectContaining({ x: 10, y: 20 })]);
    store.setTargets([]);
    expect(rings()).toEqual([]);
  });
});
