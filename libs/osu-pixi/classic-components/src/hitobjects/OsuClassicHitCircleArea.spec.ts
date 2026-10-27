import { OsuClassicHitCircleArea } from "./OsuClassicHitCircleArea";

describe("OsuClassicHitCircleArea", () => {
  it("uses Classic's supplied hit-window fade and retains native delayed fading when disabled", () => {
    const area = new OsuClassicHitCircleArea();
    area.prepare({ time: 125, hitResult: null, idleFadeOut: [100, 150] });
    expect(area.container.alpha).toBeCloseTo(0.5);
    area.prepare({ time: 125, hitResult: null, idleFadeOut: [150, 250] });
    expect(area.container.alpha).toBe(1);
    area.prepare({ time: 200 });
    expect(area.container.alpha).toBeCloseTo(0.5);
  });

  it("keeps Hidden's existing fade independent of Classic's idle fade setting", () => {
    const area = new OsuClassicHitCircleArea();
    area.prepare({ time: 0, hitResult: null, modHidden: true, idleFadeOut: [150, 250] });
    expect(area.container.alpha).toBe(0);
  });

  it("uses the nominal hit-time fade while its hit result is unresolved", () => {
    const area = new OsuClassicHitCircleArea();

    area.prepare({ time: 50, hitResult: null });
    expect(area.container.alpha).toBeCloseTo(0.5);

    area.prepare({ time: 100, hitResult: null });
    expect(area.container.alpha).toBe(0);
  });

  it("keeps resolved misses on the same nominal hit-time fade", () => {
    const area = new OsuClassicHitCircleArea();
    const hitResult = { hit: false, timing: 150 };

    area.prepare({ time: 50, hitResult });
    expect(area.container.alpha).toBeCloseTo(0.5);

    area.prepare({ time: 100, hitResult });
    expect(area.container.alpha).toBe(0);
  });

  it("preserves the successful-hit container fade path", () => {
    const area = new OsuClassicHitCircleArea();
    const hitResult = { hit: true, timing: 0 };

    area.prepare({ time: 240, hitResult });
    expect(area.container.alpha).toBe(1);

    area.prepare({ time: 801, hitResult });
    expect(area.container.alpha).toBe(0);
  });
});
