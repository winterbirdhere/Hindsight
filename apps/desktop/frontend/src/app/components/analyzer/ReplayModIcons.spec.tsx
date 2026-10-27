import { render, screen, within } from "@testing-library/react";
import { FULL_MAP_MOD_ICONS } from "../../../assets/full-map-mod-icons";
import { buildFullMapReplayMods } from "../../services/analysis/full-map-analysis-view-model";
import { ReplayModIcons, replayModsFromAcronyms } from "./ReplayModIcons";

const alts = (mods: ReturnType<typeof replayModsFromAcronyms>) => mods.map((mod) => `${mod.name} (${mod.acronym})`);

describe("ReplayModIcons", () => {
  it("lists one badge per mod, named by the mod and its acronym, with no title", () => {
    render(<ReplayModIcons mods={buildFullMapReplayMods(["HD", "DT"])} />);
    const list = screen.getByRole("list", { name: "Replay mods" });
    const images = within(list).getAllByRole("img");
    expect(images.map((image) => image.getAttribute("alt"))).toEqual(["Hidden (HD)", "Double Time (DT)"]);
    expect(images[0].getAttribute("src")).toBe(FULL_MAP_MOD_ICONS.HIDDEN);
    expect(images.every((image) => !image.hasAttribute("title"))).toBe(true);
  });

  it("draws 30 x 23 badges 4 px apart by default and keeps the 30 : 23 ratio at another height", () => {
    const { unmount } = render(<ReplayModIcons mods={buildFullMapReplayMods(["HD", "DT"])} />);
    let image = screen.getAllByRole("img")[0];
    expect([getComputedStyle(image).width, getComputedStyle(image).height]).toEqual(["30px", "23px"]);
    const list = screen.getByRole("list", { name: "Replay mods" });
    expect([getComputedStyle(list).gap, getComputedStyle(list).flexShrink]).toEqual(["4px", "0"]);
    unmount();

    render(<ReplayModIcons mods={buildFullMapReplayMods(["HD"])} height={16} />);
    image = screen.getByRole("img");
    expect(getComputedStyle(image).height).toBe("16px");
    expect(parseFloat(getComputedStyle(image).width)).toBeCloseTo((16 * 30) / 23, 2);
  });

  it("shows the rate label next to a mod that has one", () => {
    render(<ReplayModIcons mods={buildFullMapReplayMods([], [{ acronym: "DT", settings: { speed_change: 1.3 } }])} />);
    expect(within(screen.getByRole("list", { name: "Replay mods" })).getByText("1.30×")).toBeTruthy();
  });

  it("renders nothing for no mods", () => {
    const { container } = render(<ReplayModIcons mods={[]} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("replayModsFromAcronyms", () => {
  it("splits the concatenated acronyms into the mods, in the order given", () => {
    expect(alts(replayModsFromAcronyms("HDDT"))).toEqual(["Hidden (HD)", "Double Time (DT)"]);
    expect(alts(replayModsFromAcronyms("HDDTHR"))).toEqual(["Hidden (HD)", "Double Time (DT)", "Hard Rock (HR)"]);
    expect(alts(replayModsFromAcronyms("V2"))).toEqual(["Score V2 (V2)"]);
  });

  it("gives no mods for No Mod, an empty or a missing string", () => {
    expect(replayModsFromAcronyms("NM")).toEqual([]);
    expect(replayModsFromAcronyms("")).toEqual([]);
    expect(replayModsFromAcronyms(undefined)).toEqual([]);
  });

  it("gives no mods for an odd-length or unknown string, and never throws", () => {
    expect(replayModsFromAcronyms("HDD")).toEqual([]);
    expect(replayModsFromAcronyms("H")).toEqual([]);
    expect(replayModsFromAcronyms("ZZ")).toEqual([]);
    expect(replayModsFromAcronyms("ZZYY")).toEqual([]);
    expect(replayModsFromAcronyms("  ")).toEqual([]);
  });
});
