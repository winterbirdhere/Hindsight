import { ensureRewindFonts, REWIND_FONT_FACES, REWIND_REQUIRED_FACES, rewindFontsReady } from "./fonts";

function loadedFaces() {
  return REWIND_REQUIRED_FACES.map(({ family, weight }) => ({ family: `"${family}"`, weight, status: "loaded" }) as FontFace);
}

function fakeFontSet(available: boolean, faces: FontFace[] = available ? loadedFaces() : []) {
  return {
    load: jest.fn(async () => (available ? [{} as FontFace] : [])),
    check: jest.fn(() => available),
    forEach: (callback: (face: FontFace) => void) => faces.forEach(callback),
  } as unknown as FontFaceSet;
}

describe("Rewind fonts", () => {
  it("loads every bundled face before the first render", async () => {
    const fonts = fakeFontSet(true);
    await expect(ensureRewindFonts(fonts)).resolves.toBe(true);
    expect((fonts.load as jest.Mock).mock.calls.map(([face]) => face)).toEqual([...REWIND_FONT_FACES]);
  });

  it("requires the Geist Mono 600 face the HD toggle draws with", () => {
    expect(REWIND_REQUIRED_FACES).toContainEqual({ family: "Geist Mono", weight: "600" });
    expect(REWIND_FONT_FACES).toContain('600 16px "Geist Mono"');
    // A set that loaded everything except that face is not ready.
    const faces = loadedFaces().filter((face) => !(face.family === '"Geist Mono"' && face.weight === "600"));
    expect(rewindFontsReady(fakeFontSet(true, faces))).toBe(false);
  });

  it("requires the Geist 600 face the stats column draws its judgement labels with", () => {
    expect(REWIND_REQUIRED_FACES).toContainEqual({ family: "Geist", weight: "600" });
    expect(REWIND_FONT_FACES).toContain('600 16px "Geist"');
    // A set that loaded everything except that face is not ready.
    const faces = loadedFaces().filter((face) => !(face.family === '"Geist"' && face.weight === "600"));
    expect(rewindFontsReady(fakeFontSet(true, faces))).toBe(false);
    expect(rewindFontsReady(fakeFontSet(true, loadedFaces()))).toBe(true);
  });

  it("reports missing faces instead of silently falling back", async () => {
    await expect(ensureRewindFonts(fakeFontSet(false))).resolves.toBe(false);
    expect(rewindFontsReady(fakeFontSet(false))).toBe(false);
    expect(rewindFontsReady(undefined)).toBe(false);
    expect(rewindFontsReady(fakeFontSet(true))).toBe(true);
  });

  it("is not fooled by check() answering true when no Geist face is registered", () => {
    // Browsers report check() === true when no face matches, because the text would use a fallback.
    expect(rewindFontsReady(fakeFontSet(true, []))).toBe(false);
  });

  it("requires every weight to have finished loading", () => {
    const faces = loadedFaces();
    faces[1] = { ...faces[1], status: "error" } as FontFace;
    expect(rewindFontsReady(fakeFontSet(true, faces))).toBe(false);
  });
});
