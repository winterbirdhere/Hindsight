import { Vec2 } from "@osujs/math";
import { PathType, SliderPath } from "../src";

describe("SliderPath distance lookup", () => {
  it("interpolates the correct segment at boundaries and clamps progress", () => {
    const path = new SliderPath([
      { type: PathType.Linear, offset: { x: 0, y: 0 } },
      { offset: { x: 10, y: 0 } },
      { offset: { x: 10, y: 20 } },
      { offset: { x: 40, y: 20 } },
    ]);

    expect(path.distance).toBe(60);
    expect(path.positionAt(-1)).toEqual(new Vec2(0, 0));
    expect(path.positionAt(1 / 6)).toEqual(new Vec2(10, 0));
    expect(path.positionAt(1 / 3)).toEqual(new Vec2(10, 10));
    expect(path.positionAt(1 / 2)).toEqual(new Vec2(10, 20));
    expect(path.positionAt(3 / 4)).toEqual(new Vec2(25, 20));
    expect(path.positionAt(2)).toEqual(new Vec2(40, 20));
  });

  it("preserves empty, degenerate, and non-finite progress behavior", () => {
    expect(new SliderPath([]).positionAt(0.5)).toEqual(Vec2.Zero);
    const path = new SliderPath([{ type: PathType.Linear, offset: { x: 3, y: 4 } }, { offset: { x: 3, y: 4 } }], 20);
    expect(path.cumulativeLengths).toEqual([0, 0]);
    expect(path.positionAt(0.5)).toEqual(new Vec2(3, 4));
    expect(path.positionAt(NaN)).toEqual(new Vec2(3, 4));
  });

  it("keeps shortened and extended slider endpoints", () => {
    const points = [
      { type: PathType.Linear, offset: { x: 0, y: 0 } },
      { offset: { x: 10, y: 0 } },
      { offset: { x: 20, y: 0 } },
    ];
    expect(new SliderPath(points, 15).positionAt(1)).toEqual(new Vec2(15, 0));
    expect(new SliderPath(points, 30).positionAt(1)).toEqual(new Vec2(30, 0));
  });

  it("finds late segments in long paths", () => {
    const path = new SliderPath(
      Array.from({ length: 10_001 }, (_, x) => ({
        type: x === 0 ? PathType.Linear : undefined,
        offset: { x, y: 0 },
      })),
    );
    expect(path.positionAt(0.99995)).toEqual(new Vec2(9_999.5, 0));
  });
});
