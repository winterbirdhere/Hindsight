import { Beatmap, HitCircle, PathType, Slider, SliderPath, Spinner } from "@osujs/core";
import { Container } from "pixi.js";
import { HitObjectsContainer } from "./HitObjectsContainerFactory";
import { BeatmapManager } from "../../../manager/BeatmapManager";

function circle(id: string, hitTime: number) {
  const object = new HitCircle();
  Object.assign(object, { id, hitTime, approachDuration: 100 });
  return object;
}

function longSlider() {
  const object = new Slider(circle("long/HEAD", 1_000));
  object.id = "long";
  object.path = new SliderPath([{ type: PathType.Linear, offset: { x: 0, y: 0 } }, { offset: { x: 100, y: 0 } }]);
  object.velocity = 0.01;
  return object;
}

function fixture(objects: Beatmap["hitObjects"]) {
  const beatmapManager = new BeatmapManager();
  const map = new Beatmap(objects, Beatmap.EMPTY_BEATMAP.difficulty, [], Beatmap.EMPTY_BEATMAP.controlPointInfo);
  beatmapManager.setBeatmap(map);
  const clock = { timeElapsedInMs: 0 };
  const visited: string[] = [];
  const view = (id: string) => {
    visited.push(id);
    const container = new Container();
    container.name = id;
    return container;
  };
  // Factory boundaries avoid WebGL; the real container, map and objects own
  // candidate selection, ordering and seek behavior under test.
  const hitCircles = { createHitCircle: (o: HitCircle) => ({ hitCircleArea: view(o.id) }), freeResources: jest.fn() };
  const sliders = { create: (o: Slider) => view(o.id), postUpdate: jest.fn() };
  const spinners = { create: (o: Spinner) => ({ container: view(o.id) }) };
  const ContainerWithClock = HitObjectsContainer as unknown as new (...args: unknown[]) => HitObjectsContainer;
  const display = new ContainerWithClock(beatmapManager, hitCircles, sliders, spinners, clock);
  const renderAt = (time: number) => {
    visited.length = 0;
    clock.timeElapsedInMs = time;
    display.updateHitObjects();
    return [...visited];
  };
  return { renderAt, beatmapManager, display };
}

describe("visible hitobject candidates", () => {
  it("keeps long overlapping objects and painter order when seeking in either direction", () => {
    const spinner = new Spinner();
    Object.assign(spinner, { id: "spinner", startTime: 2_000, duration: 7_000, fadeInDuration: 400 });
    const { renderAt } = fixture([circle("early", 800), longSlider(), circle("late", 6_000), spinner]);
    expect(renderAt(6_000)).toEqual(["spinner", "late", "long", "long/HEAD"]);
    expect(renderAt(700)).toEqual(["early"]);
    expect(renderAt(1_100)).toEqual(["long", "long/HEAD", "early"]);
    expect(renderAt(11_301)).toEqual([]);
  });

  it("honors inclusive spawn/fade boundaries and spinner fade-in rather than preempt", () => {
    const spinner = new Spinner();
    Object.assign(spinner, {
      id: "spinner",
      startTime: 2_000,
      duration: 1_000,
      approachDuration: 900,
      fadeInDuration: 400,
    });
    const { renderAt } = fixture([circle("circle", 1_000), spinner]);
    expect(renderAt(899)).toEqual([]);
    expect(renderAt(900)).toEqual(["circle"]);
    expect(renderAt(1_300)).toEqual(["circle"]);
    expect(renderAt(1_301)).toEqual([]);
    expect(renderAt(1_599)).toEqual([]);
    expect(renderAt(1_600)).toEqual(["spinner"]);
  });

  it("does not assume spawn order matches map order", () => {
    const later = circle("later", 3_000);
    later.approachDuration = 2_800;
    expect(fixture([circle("first", 1_000), later]).renderAt(300)).toEqual(["later"]);
  });

  it("drops old candidates on beatmap reset and handles replay IDs reused by a new map", () => {
    const { renderAt, beatmapManager, display } = fixture([circle("same-id", 1_000)]);
    expect(renderAt(1_000)).toEqual(["same-id"]);
    beatmapManager.setBeatmap(Beatmap.EMPTY_BEATMAP);
    expect(renderAt(1_000)).toEqual([]);
    expect(display.hitObjectContainer.children).toHaveLength(0);
    const replacement = new Beatmap(
      [circle("same-id", 3_000)],
      Beatmap.EMPTY_BEATMAP.difficulty,
      [],
      Beatmap.EMPTY_BEATMAP.controlPointInfo,
    );
    beatmapManager.setBeatmap(replacement);
    expect(renderAt(1_000)).toEqual([]);
    expect(renderAt(3_000)).toEqual(["same-id"]);
  });

  it("does not send offscreen objects through the factories on unchanged frames", () => {
    const { renderAt } = fixture(Array.from({ length: 20_000 }, (_, i) => circle(String(i), i * 1_000)));
    expect(renderAt(10_000_000)).toEqual(["10000"]);
    expect(renderAt(10_000_000)).toEqual(["10000"]);
  });
});
