import {
  SHORT_KEY_OVERLAY_WINDOW_MS,
  inputBarGeometry,
  KEY_OVERLAY_GEOMETRY,
  keyCapState,
  KeyPressOverlay,
  KeyPressOverlayRow,
  KeyPressWithNoteSheetPreparer,
} from "./KeyPressOverlay";
import { ErrorOutlineStore, ErrorOutlineTarget } from "../../../common/error-outline";
import { Subject } from "rxjs";
import { GameplayClock } from "../../../common/game/GameplayClock";
import { calculateReplayButtonIntervals, OsuHitObject, ReplayFrame } from "@osujs/core";
import { Rectangle, Texture } from "pixi.js";

describe("zero-duration recorded key presses", () => {
  beforeEach(() => {
    jest.spyOn(Texture, "WHITE", "get").mockReturnValue(Texture.EMPTY as typeof Texture.WHITE);
  });
  afterEach(() => jest.restoreAllMocks());

  it.each([
    { time: 500, x: 0, width: 1 },
    { time: 1_000, x: 194.75, width: 2 },
    { time: 1_500, x: 390.5, width: 1 },
  ])("draws a visible tick clipped to the roll for a press at $time", ({ time, x, width }) => {
    const frames: ReplayFrame[] = [
      { time, position: { x: 100, y: 100 }, actions: [], rawButtonMask: 5 },
      { time, position: { x: 100, y: 100 }, actions: [], rawButtonMask: 0 },
    ];
    const intervals = calculateReplayButtonIntervals(frames).K1;
    const row = new KeyPressOverlayRow(intervals, 500, inputBarGeometry("K1"));
    row.onTintChange(0x00ff00);
    row.update(1_000);
    expect(row.container.children).toHaveLength(1);
    const sprite = row.container.children[0];
    expect(sprite).toMatchObject({ width, height: 25.5, alpha: 1, tint: 0x00ff00 });
    expect(sprite.position.x).toBeCloseTo(x);
  });

  it("does not draw press ticks outside the visible time window", () => {
    const row = new KeyPressOverlayRow([[499, 499], [1_501, 1_501]], 500, inputBarGeometry("K1"));
    row.update(1_000);
    expect(row.container.children).toHaveLength(0);
  });
});

describe("key overlay geometry", () => {
  it("keeps lanes roomy and square, with object marks centred on the lane boundary", () => {
    const g = KEY_OVERLAY_GEOMETRY;
    expect(g.laneHeight).toBe(25.5);
    expect(g.laneGap).toBe(9);
    expect(g.laneTop * 2 + g.laneHeight * 2 + g.laneGap).toBeCloseTo(g.height);
    expect(g.rollX + g.rollWidth).toBeLessThan(g.width);
    expect(g.objectMark.y + g.objectMark.height / 2).toBeCloseTo(g.laneTop + g.laneHeight + g.laneGap / 2);
    expect(SHORT_KEY_OVERLAY_WINDOW_MS).toBe(210);
  });

  it("keeps keyboard bars full height and mouse bars inset", () => {
    expect(inputBarGeometry("K1")).toEqual({ y: 0, height: 25.5 });
    expect(inputBarGeometry("M2")).toEqual({ y: 4.5, height: 16.5 });
  });
});

describe("key overlay length", () => {
  beforeEach(() => {
    jest.spyOn(Texture, "WHITE", "get").mockReturnValue(Texture.EMPTY as typeof Texture.WHITE);
    // jsdom has no 2D canvas; the key caps' text is never measured or drawn here.
    jest.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  });
  afterEach(() => jest.restoreAllMocks());

  const NOW = 5_000;
  type Drawn = { width: number; position: { x: number } };
  const bars = (overlay: KeyPressOverlay, input: "K1" | "K2") =>
    (overlay as unknown as { rows: Map<string, { container: { children: Drawn[] } }> }).rows.get(input)?.container
      .children ?? [];
  const marks = (overlay: KeyPressOverlay) =>
    (overlay as unknown as { hitObjectContainer: { children: Drawn[] } }).hitObjectContainer.children;
  const circleAt = (hitTime: number) => ({ type: "HIT_CIRCLE", hitTime }) as unknown as OsuHitObject;

  it("starts at the medium length", () => {
    const overlay = new KeyPressOverlay(new GameplayClock());
    expect(overlay.length).toBe("medium");
    expect(overlay.bounds).toEqual({ x: 0, y: 0, width: 705.75, height: 75 });
  });

  // K2 is a 105 ms press ending now: 97.875 units in every length, because the time scale never changes.
  it.each([
    { length: "short", width: 510, roll: 391.5, windowMs: 210, k2Left: 97.875 },
    { length: "medium", width: 705.75, roll: 587.25, windowMs: 315, k2Left: 195.75 },
    { length: "long", width: 901.5, roll: 783, windowMs: 420, k2Left: 293.625 },
  ] as const)(
    "$length is $width wide and shows ±$windowMs ms at today's time scale",
    ({ length, width, roll, windowMs, k2Left }) => {
      const overlay = new KeyPressOverlay(new GameplayClock());
      overlay.setLength(length);
      overlay.onKeyPressesChange({ K1: [[0, 10_000]], K2: [[NOW - 105, NOW]], M1: [], M2: [] });
      overlay.onHitObjectsChange([circleAt(NOW), circleAt(NOW + windowMs), circleAt(NOW + windowMs + 1)]);
      overlay.update(NOW);

      expect(overlay.length).toBe(length);
      expect(overlay.windowDuration).toBe(windowMs);
      expect(overlay.bounds).toEqual({ x: 0, y: 0, width, height: 75 });
      expect((overlay.container.hitArea as Rectangle).width).toBe(width);
      // A press held through the whole window fills the roll exactly.
      expect(bars(overlay, "K1")).toHaveLength(1);
      expect(bars(overlay, "K1")[0].position.x).toBeCloseTo(0);
      expect(bars(overlay, "K1")[0].width).toBeCloseTo(roll);
      expect(bars(overlay, "K2")[0].position.x).toBeCloseTo(k2Left);
      expect(bars(overlay, "K2")[0].width).toBeCloseTo(97.875);
      // Marks are drawn last-first: the object at the window's edge sits on the roll's end, the one at "now" on its
      // centre, and the one a millisecond further out is not drawn.
      expect(marks(overlay).map((mark) => mark.position.x + 2.25)).toEqual([
        expect.closeTo(roll, 6),
        expect.closeTo(roll / 2, 6),
      ]);
    },
  );

  it("drops a wheel zoom when a length is chosen, and can put one back", () => {
    const overlay = new KeyPressOverlay(new GameplayClock());
    overlay.onKeyPressesChange({ K1: [[NOW - 420, NOW + 420]], K2: [], M1: [], M2: [] });
    overlay.onWindowDurationChange(1_000);
    overlay.setLength("long");
    overlay.update(NOW);
    expect(overlay.windowDuration).toBe(420);
    expect(bars(overlay, "K1")[0].width).toBeCloseTo(783);

    overlay.setLength("short", 1_000);
    overlay.update(NOW);
    expect(overlay.windowDuration).toBe(1_000);
    // 840 ms of a 2000 ms window on the 391.5 roll.
    expect(bars(overlay, "K1")[0].width).toBeCloseTo(164.43);
  });
});

describe("outlined objects in the key overlay", () => {
  beforeEach(() => {
    jest.spyOn(Texture, "WHITE", "get").mockReturnValue(Texture.EMPTY as typeof Texture.WHITE);
    // jsdom has no 2D canvas; the key caps' text is never measured or drawn here.
    jest.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  });
  afterEach(() => jest.restoreAllMocks());

  const NOW = 5_000;
  const GREY = 0xececec;
  const MISS_RED = 0xff7082;
  const BREAK_LILAC = 0xc7b3ff;
  const circle = (id: string, hitTime: number) => ({ type: "HIT_CIRCLE", id, hitTime }) as unknown as OsuHitObject;
  const slider = (id: string, startTime: number, duration: number) =>
    ({ type: "SLIDER", id, startTime, duration }) as unknown as OsuHitObject;
  type Mark = { tint: number; alpha: number; width: number };
  // Drawn last object first; a slider draws its band, then its start mark.
  const drawn = (overlay: KeyPressOverlay) => {
    overlay.update(NOW);
    return (overlay as unknown as { hitObjectContainer: { children: Mark[] } }).hitObjectContainer.children.map(
      ({ tint, alpha, width }) => ({ tint, alpha, band: width > 4.5 }),
    );
  };

  it("draws an outlined object's mark in its error colour at full strength and leaves the others grey", () => {
    const overlay = new KeyPressOverlay(new GameplayClock());
    overlay.onHitObjectsChange([circle("c1", NOW), circle("c2", NOW + 50)]);
    expect(drawn(overlay)).toEqual([
      { tint: GREY, alpha: 0.62, band: false },
      { tint: GREY, alpha: 0.62, band: false },
    ]);
    overlay.onMarkedObjectsChange(new Map([["c1", MISS_RED]]));
    expect(drawn(overlay)).toEqual([
      { tint: GREY, alpha: 0.62, band: false },
      { tint: MISS_RED, alpha: 1, band: false },
    ]);
  });

  it("colours a slider's band and its start mark", () => {
    const overlay = new KeyPressOverlay(new GameplayClock());
    overlay.onHitObjectsChange([slider("s1", NOW - 20, 100)]);
    overlay.onMarkedObjectsChange(new Map([["s1", BREAK_LILAC]]));
    expect(drawn(overlay)).toEqual([
      { tint: BREAK_LILAC, alpha: 0.45, band: true },
      { tint: BREAK_LILAC, alpha: 1, band: false },
    ]);
  });

  it("goes back to grey when the marks are cleared", () => {
    const overlay = new KeyPressOverlay(new GameplayClock());
    overlay.onHitObjectsChange([slider("s1", NOW - 20, 100)]);
    overlay.onMarkedObjectsChange(new Map([["s1", BREAK_LILAC]]));
    overlay.onMarkedObjectsChange(new Map());
    expect(drawn(overlay)).toEqual([
      { tint: GREY, alpha: 0.3, band: true },
      { tint: GREY, alpha: 0.62, band: false },
    ]);
  });

  describe("fed from the outline store", () => {
    function preparer() {
      const clock = new GameplayClock();
      jest.spyOn(console, "debug").mockImplementation(() => undefined);
      clock.setDuration(10_000);
      clock.seekTo(NOW);
      const beatmap$ = new Subject<{ hitObjects: OsuHitObject[] }>();
      const store = new ErrorOutlineStore();
      const prepared = new KeyPressWithNoteSheetPreparer(
        clock,
        { mainReplay$: new Subject() } as never,
        { beatmap$ } as never,
        store,
      );
      beatmap$.next({ hitObjects: [circle("c1", NOW)] });
      const tints = () => {
        prepared.update();
        return (
          prepared.keyPressOverlay as unknown as { hitObjectContainer: { children: Mark[] } }
        ).hitObjectContainer.children.map((mark) => mark.tint);
      };
      return { clock, store, tints };
    }
    const missTarget = { errorId: "miss:c1", emphasis: "full", color: MISS_RED, markObjectId: "c1" } as ErrorOutlineTarget;
    const missMark = new Map([["c1", MISS_RED]]);

    it("takes the colours of the store's marks, and drops them when the marks go", () => {
      const { store, tints } = preparer();
      expect(tints()).toEqual([GREY]);
      store.setMarks(missMark);
      expect(tints()).toEqual([MISS_RED]);
      store.setMarks(new Map());
      expect(tints()).toEqual([GREY]);
    });

    it("does not follow the rings on the playfield: the marks have a setting of their own", () => {
      const { store, tints } = preparer();
      store.setTargets([missTarget]);
      expect(tints()).toEqual([GREY]);
      store.setMarks(missMark);
      store.setTargets([]);
      expect(tints()).toEqual([MISS_RED]);
    });

    it("stays grey while a clip export owns the clock, so a clip never carries the colour", () => {
      const { clock, store, tints } = preparer();
      store.setMarks(missMark);
      clock.controlsLocked = true;
      expect(tints()).toEqual([GREY]);
      clock.controlsLocked = false;
      expect(tints()).toEqual([MISS_RED]);
    });
  });
});

describe("keyCapState", () => {
  const intervals: [number, number][] = [[100, 150], [300, 400], [500, 500]];
  it.each([
    [50, { count: 0, held: false }],
    [120, { count: 1, held: true }],
    [200, { count: 1, held: false }],
    [350, { count: 2, held: true }],
    [500, { count: 3, held: true }],
    [1_000, { count: 3, held: false }],
  ])("at %i ms", (time, expected) => {
    expect(keyCapState(intervals, time)).toEqual(expected);
  });
});

describe("wheel input", () => {
  it("zooms with Alt and the wheel, never seeks, and does neither while an export owns transport", () => {
    const clock = new GameplayClock();
    clock.setDuration(10_000);
    clock.seekTo(1_000);
    const zoom = jest.fn();
    const overlay = Object.assign(Object.create(KeyPressOverlay.prototype), {
      gameplayClock: clock,
      hovered: true,
      windowDuration: 500,
      onWindowDurationChange: zoom,
    }) as KeyPressOverlay;
    clock.controlsLocked = true;
    overlay.onWheelEvent(new WheelEvent("wheel", { deltaY: 100 }));
    overlay.onWheelEvent(new WheelEvent("wheel", { deltaY: 100, altKey: true }));
    expect(clock.timeElapsedInMs).toBe(1_000);
    expect(zoom).not.toHaveBeenCalled();
    clock.controlsLocked = false;
    // The wheel alone steps the playhead through the stage's own handler, not here.
    overlay.onWheelEvent(new WheelEvent("wheel", { deltaY: 100 }));
    expect(clock.timeElapsedInMs).toBe(1_000);
    expect(zoom).not.toHaveBeenCalled();
    overlay.onWheelEvent(new WheelEvent("wheel", { deltaY: 100, altKey: true }));
    expect(zoom).toHaveBeenCalledWith(550);
  });

  it("leaves Alt and the wheel alone over a dialog, which is in front of the overlay", () => {
    const zoom = jest.fn();
    const overlay = Object.assign(Object.create(KeyPressOverlay.prototype), {
      gameplayClock: new GameplayClock(),
      // The pointer was over the overlay when the dialog opened, and the stage never heard it leave.
      hovered: true,
      windowDuration: 500,
      onWindowDurationChange: zoom,
    }) as KeyPressOverlay;
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const inside = document.createElement("span");
    dialog.append(inside);
    document.body.append(dialog);
    inside.addEventListener("wheel", (event) => overlay.onWheelEvent(event));
    inside.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, altKey: true, bubbles: true }));
    expect(zoom).not.toHaveBeenCalled();
    dialog.remove();
  });
});
