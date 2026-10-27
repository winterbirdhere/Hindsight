import { calculateAnalysisStageLayout } from "./AnalysisStageLayout";
import { EXPORT_STAGE_FRAME, liveStageFrame, sameStageFrame } from "./stage-frame";

// The one-pixel Graphics stroke expands the 800x72 background by half a pixel
// on every side in Pixi's local bounds.
const overlayBounds = { x: -0.5, y: -0.5, width: 801, height: 73 };

describe("calculateAnalysisStageLayout", () => {
  it("keeps the osu! playfield centered at its conventional 4:3 scale", () => {
    const { playfield } = calculateAnalysisStageLayout(overlayBounds);

    // The default frame is the export frame, which is the live stage at 16:9 (playfield at 81.5 % of the height).
    expect(playfield.scale).toBe(1.91015625);
    expect(playfield.width).toBe(978);
    expect(playfield.height).toBe(733.5);
    expect(playfield.width / playfield.height).toBeCloseTo(4 / 3);
    expect(playfield.left).toBe(311);
    expect(playfield.top).toBe(83.25);
    expect(playfield.left + playfield.width / 2).toBe(800);
    expect(playfield.top + playfield.height / 2).toBe(450);
  });

  it("centers the key overlay inside the HUD-safe top band without touching the playfield", () => {
    const { playfield, keyPressOverlay } = calculateAnalysisStageLayout(overlayBounds);

    expect(keyPressOverlay).toBeDefined();
    if (!keyPressOverlay) throw new Error("Expected the key overlay to have a layout");

    // The 74.25-unit band (83.25 − 6 − 3) limits the overlay's height, not its width.
    expect(keyPressOverlay.scale).toBeCloseTo(74.25 / 73);
    expect(keyPressOverlay.left + keyPressOverlay.right).toBeCloseTo(1600);
    expect(keyPressOverlay.top).toBe(6);
    expect(keyPressOverlay.bottom).toBeCloseTo(80.25);
    expect(playfield.top - keyPressOverlay.bottom).toBeGreaterThanOrEqual(3 - 1e-9);
  });
});

const newOverlay = { x: 0, y: 0, width: 510, height: 75 };

describe("stage frames", () => {
  it("keeps the export frame's HUD anchors identical to today's constants", () => {
    const { hud } = calculateAnalysisStageLayout(newOverlay, EXPORT_STAGE_FRAME);
    expect(hud).toEqual({ accuracy: { x: 1585, y: 25 }, combo: { x: 0, y: 850 }, hitErrorBar: { x: 800, y: 880 } });
  });

  it("fills a live centre cell without letterboxing (1200 × 675 reference window, geometry without the stats reserve)", () => {
    const frame = { ...liveStageFrame(790, 605), regionLeft: 0 };
    expect(frame.width).toBeCloseTo(1175.2066, 3);
    const { playfield, keyPressOverlay, hud } = calculateAnalysisStageLayout(newOverlay, frame);
    expect(playfield.scale).toBeCloseTo(1.91015625);
    expect(playfield.height).toBeCloseTo(733.5);
    expect(playfield.width).toBeCloseTo(978);
    expect(playfield.left).toBeCloseTo(98.6033, 3);
    expect(playfield.top).toBeCloseTo(83.25);
    expect(keyPressOverlay?.scale).toBeCloseTo(0.99);
    expect(keyPressOverlay?.top).toBe(6);
    expect(keyPressOverlay?.bottom).toBeCloseTo(80.25);
    expect(playfield.top - (keyPressOverlay?.bottom ?? 0)).toBeGreaterThanOrEqual(3 - 1e-9);
    expect(hud.accuracy.x).toBeCloseTo(frame.width - 15);
    expect(hud.hitErrorBar.x).toBeCloseTo(frame.width / 2);
  });

  it("shifts the same 790 × 605 cell's region by the deficit and shrinks the playfield to it", () => {
    const frame = liveStageFrame(790, 605);
    expect(frame.regionLeft).toBeCloseTo(219.3223, 3);
    const { playfield, hud } = calculateAnalysisStageLayout(newOverlay, frame);
    expect(playfield.scale).toBeCloseTo(1.7732, 4);
    expect(playfield.width).toBeCloseTo(907.9, 1);
    expect(playfield.left).toBeCloseTo(243.3223, 3);
    expect(playfield.left).toBeCloseTo(frame.regionLeft + 24);
    expect(hud.combo.x).toBeCloseTo(frame.regionLeft);
    expect(hud.hitErrorBar.x).toBeCloseTo(frame.regionLeft + (frame.width - frame.regionLeft) / 2);
  });

  it("never lets the playfield exceed a narrow centre cell", () => {
    // 400 × 400 px: too narrow for the stats reserve, so the cell is a 1:1 frame centred as before.
    const { playfield } = calculateAnalysisStageLayout(newOverlay, liveStageFrame(400, 400));
    expect(playfield.scale).toBeCloseTo(1.6640625);
    expect(playfield.left).toBeCloseTo(24);
    expect(playfield.width + 48).toBeCloseTo(900);
  });

  it("centres the playfield in the export frame and clears the stats column at every output size", () => {
    const { playfield } = calculateAnalysisStageLayout({ x: 0, y: 0, width: 0, height: 0 }, EXPORT_STAGE_FRAME);
    expect(playfield.left + playfield.width / 2).toBeCloseTo(800);
    expect(playfield.height).toBeCloseTo(733.5);
    // The column is 140 px wide on a 696 px stage; at output width w the frame is w x 9/16 high.
    for (const width of [1920, 2560, 3840])
      expect(playfield.left * (width / 1600)).toBeGreaterThan(140 * ((width * 9) / 16 / 696));
  });

  it("compares frames by value and tolerates invalid aspects", () => {
    expect(sameStageFrame(liveStageFrame(900, 600), liveStageFrame(900, 600))).toBe(true);
    expect(sameStageFrame(liveStageFrame(900, 600), liveStageFrame(900, 601))).toBe(false);
    expect(sameStageFrame(undefined, EXPORT_STAGE_FRAME)).toBe(false);
    expect(liveStageFrame(Number.NaN, 600).width).toBeCloseTo(1600);
  });
});
