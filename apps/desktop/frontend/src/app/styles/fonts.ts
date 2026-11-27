/** Weights the analyzer and the exported clip's stats column draw with. Loaded before first render. */
export const REWIND_REQUIRED_FACES = [
  { family: "Geist", weight: "300" },
  { family: "Geist", weight: "400" },
  { family: "Geist", weight: "500" },
  { family: "Geist", weight: "600" },
  { family: "Geist Mono", weight: "400" },
  { family: "Geist Mono", weight: "500" },
  { family: "Geist Mono", weight: "600" },
] as const;

/** CSS font shorthands for `FontFaceSet.load`/`check`. */
export const REWIND_FONT_FACES = REWIND_REQUIRED_FACES.map(({ family, weight }) => `${weight} 16px "${family}"`);

const defaultFontSet = (): FontFaceSet | undefined => (typeof document === "undefined" ? undefined : document.fonts);
const unquote = (family: string) => family.replace(/^["']|["']$/g, "");

export async function ensureRewindFonts(fontSet: FontFaceSet | undefined = defaultFontSet()): Promise<boolean> {
  if (!fontSet) return false;
  const loaded = await Promise.all(REWIND_FONT_FACES.map((face) => fontSet.load(face)));
  return loaded.every((faces) => faces.length > 0);
}

/**
 * True only when every required face is registered and actually loaded.
 * `FontFaceSet.check` alone also answers true when no matching face exists
 * (the text would render in a fallback), so it cannot prove the bundle loaded.
 */
export function rewindFontsReady(fontSet: FontFaceSet | undefined = defaultFontSet()): boolean {
  if (!fontSet) return false;
  const loaded: FontFace[] = [];
  fontSet.forEach((face) => {
    if (face.status === "loaded") loaded.push(face);
  });
  return REWIND_REQUIRED_FACES.every(
    ({ family, weight }, index) =>
      fontSet.check(REWIND_FONT_FACES[index]) &&
      loaded.some((face) => unquote(face.family) === family && face.weight === weight),
  );
}
