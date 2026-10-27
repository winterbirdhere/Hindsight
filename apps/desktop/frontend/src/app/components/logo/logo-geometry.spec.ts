import { LOGO_STATIC, logoFrame, trailPath } from "./logo-geometry";

describe("logoFrame", () => {
  it("starts collapsed and faded", () => {
    const f = logoFrame(0);
    expect(f.spanDeg).toBe(1);
    expect(f.discScale).toBeCloseTo(0.94);
    expect(f.discOpacity).toBe(0);
    expect(f.approachRadius).toBe(38);
    expect(f.approachOpacity).toBeCloseTo(0.2);
  });

  it("has fully opened the trail when the intro ends", () => {
    const f = logoFrame(1100);
    expect(f.spanDeg).toBe(290);
    expect(f.headDeg).toBeCloseTo(-150);
    expect(f.glowOpacity).toBeCloseTo(1);
  });

  it("pulses the label once, between 1000 ms and 1260 ms", () => {
    expect(logoFrame(1130).labelScale).toBeCloseTo(1.08);
    expect(logoFrame(999).labelScale).toBe(1);
    expect(logoFrame(1000).labelScale).toBe(1);
    expect(logoFrame(1260).labelScale).toBe(1);
  });

  it("ends the approach circle at the label radius", () => {
    const f = logoFrame(1000);
    expect(f.approachOpacity).toBe(0);
    expect(f.approachRadius).toBe(16);
  });

  it("turns the cursor one full revolution per 3.6 s", () => {
    expect(logoFrame(1100 + 3600).headDeg - logoFrame(1100).headDeg).toBeCloseTo(-360);
  });

  it("clamps negative time to the first frame", () => {
    expect(logoFrame(-50)).toEqual(logoFrame(0));
  });
});

describe("trailPath", () => {
  it("draws the full 290 degree trail with the large-arc flag", () => {
    const t = trailPath(-40, 290);
    expect(t.d).toBe("M38.37 18.05 A34 34 0 1 0 76.05 28.15");
    expect(t.head[0]).toBeCloseTo(76.05, 1);
    expect(t.head[1]).toBeCloseTo(28.15, 1);
    expect(t.tail[0]).toBeCloseTo(38.37, 1);
    expect(t.tail[1]).toBeCloseTo(18.05, 1);
  });

  it("uses the small-arc flag for a short trail", () => {
    expect(trailPath(-40, 120).d).toContain(" 0 0 0 ");
  });
});

describe("LOGO_STATIC", () => {
  it("is the settled resting frame", () => {
    expect(LOGO_STATIC).toEqual({
      headDeg: -40,
      spanDeg: 290,
      discScale: 1,
      discOpacity: 1,
      labelOpacity: 1,
      labelScale: 1,
      glowOpacity: 1,
      approachRadius: 16,
      approachOpacity: 0,
    });
  });
});
