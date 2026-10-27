import { DEFAULT_OSU_SKIN_ID, DEFAULT_REWIND_SKIN_ID } from "../../model/SkinId";
import { buildSkinOptions, filterSkinOptions } from "./skin-options";

const labels = (options: ReturnType<typeof buildSkinOptions>) => options.map((option) => option.label);

describe("buildSkinOptions", () => {
  it("pins the skin used in osu! first", () => {
    const options = buildSkinOptions(["Zeta", "- WhiteCat 2.1 -", "Alpha"], "- WhiteCat 2.1 -");
    expect(options[0]).toEqual({ id: { source: "osu", name: "- WhiteCat 2.1 -" }, label: "- WhiteCat 2.1 -", usedInOsu: true });
    expect(labels(options)).toEqual(["- WhiteCat 2.1 -", "Hindsight", "osu! default", "Alpha", "Zeta"]);
    expect(options.filter((option) => option.usedInOsu)).toHaveLength(1);
  });

  it("does not pin a skin that is not in the folder", () => {
    const options = buildSkinOptions(["Alpha"], "Gone");
    expect(labels(options)).toEqual(["Hindsight", "osu! default", "Alpha"]);
    expect(options.some((option) => option.usedInOsu)).toBe(false);
  });

  it("matches the cfg name without case", () => {
    const options = buildSkinOptions(["Alpha", "Cookiezi 32"], "cookiezi 32");
    expect(options[0]).toEqual({ id: { source: "osu", name: "Cookiezi 32" }, label: "Cookiezi 32", usedInOsu: true });
  });

  it("lists the two built-ins before the rest", () => {
    const options = buildSkinOptions(["B", "A"], undefined);
    expect(options.slice(0, 2)).toEqual([
      { id: DEFAULT_REWIND_SKIN_ID, label: "Hindsight", note: "built in" },
      { id: DEFAULT_OSU_SKIN_ID, label: "osu! default", note: "built in" },
    ]);
    expect(labels(options)).toEqual(["Hindsight", "osu! default", "A", "B"]);
  });

  it("sorts the rest A–Z with numbers in order", () => {
    const options = buildSkinOptions(["Skin 10", "skin 2", "Banana", "apple", "Skin 1"], undefined);
    expect(labels(options).slice(2)).toEqual(["apple", "Banana", "Skin 1", "skin 2", "Skin 10"]);
  });

  it("never lists a skin twice", () => {
    const options = buildSkinOptions(["Lain", "Lain", "Mocha"], "Lain");
    expect(labels(options)).toEqual(["Lain", "Hindsight", "osu! default", "Mocha"]);
    const keys = options.map((option) => `${option.id.source}:${option.id.name}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("handles no folder skins", () => {
    expect(labels(buildSkinOptions([], undefined))).toEqual(["Hindsight", "osu! default"]);
    expect(labels(buildSkinOptions([], "Lain"))).toEqual(["Hindsight", "osu! default"]);
  });
});

describe("filterSkinOptions", () => {
  const options = buildSkinOptions(["Cookiezi 32", "Lain", "Rafis 2020"], undefined);

  it("filters by a case-insensitive part of the name, including the built-ins", () => {
    expect(labels(filterSkinOptions(options, "AI"))).toEqual(["Lain"]);
    expect(labels(filterSkinOptions(options, "  rafis "))).toEqual(["Rafis 2020"]);
    expect(labels(filterSkinOptions(options, "default"))).toEqual(["osu! default"]);
    expect(labels(filterSkinOptions(options, "hind"))).toEqual(["Hindsight"]);
    expect(filterSkinOptions(options, "zzz")).toEqual([]);
  });

  it("returns everything for an empty query", () => {
    expect(filterSkinOptions(options, "")).toEqual(options);
    expect(filterSkinOptions(options, "   ")).toEqual(options);
  });
});
