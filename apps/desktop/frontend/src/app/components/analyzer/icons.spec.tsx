import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import { AudioIcon, AudioMutedIcon, FolderIcon, MoreIcon, PauseIcon, PlayIcon } from "./icons";

function svgOf(element: ReactElement) {
  const { container } = render(element);
  return container.querySelector("svg") as SVGSVGElement;
}

describe("3a dock and header icons", () => {
  it.each([
    ["PlayIcon", <PlayIcon key="p" />, "10", "11"],
    ["PauseIcon", <PauseIcon key="pa" />, "10", "11"],
    ["AudioIcon", <AudioIcon key="a" />, "16", "14"],
    ["AudioMutedIcon", <AudioMutedIcon key="am" />, "16", "14"],
    ["MoreIcon", <MoreIcon key="m" />, "4", "14"],
    ["FolderIcon", <FolderIcon key="f" />, "14", "12"],
  ])("%s is a decorative currentColor svg at the mock's size", (_name, element, width, height) => {
    const svg = svgOf(element);
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("width")).toBe(width);
    expect(svg.getAttribute("height")).toBe(height);
    expect(svg.getAttribute("viewBox")).toBe(`0 0 ${width} ${height}`);
    const painted = Array.from(svg.querySelectorAll("polygon, rect, circle, path"));
    expect(painted.length).toBeGreaterThan(0);
    for (const shape of painted) {
      const paint = [shape.getAttribute("fill"), shape.getAttribute("stroke")].filter((value) => value && value !== "none");
      expect(paint.length).toBeGreaterThan(0);
      expect(paint.every((value) => value === "currentColor")).toBe(true);
    }
  });

  it("keeps the mock's geometry", () => {
    expect(svgOf(<PlayIcon />).querySelector("polygon")?.getAttribute("points")).toBe("1.5,0.5 9.5,5.5 1.5,10.5");
    const bars = Array.from(svgOf(<PauseIcon />).querySelectorAll("rect"));
    expect(bars.map((bar) => [bar.getAttribute("width"), bar.getAttribute("height")])).toEqual([["3", "10"], ["3", "10"]]);
    expect(svgOf(<MoreIcon />).querySelectorAll("circle")).toHaveLength(3);
  });

  it("draws the muted speaker with a cross where the arcs were", () => {
    const speaker = svgOf(<AudioIcon />);
    const muted = svgOf(<AudioMutedIcon />);
    expect(muted.querySelector("polygon")?.getAttribute("points")).toBe(speaker.querySelector("polygon")?.getAttribute("points"));
    expect(muted.querySelector("path")?.getAttribute("d")).not.toBe(speaker.querySelector("path")?.getAttribute("d"));
    const cross = muted.querySelector("path") as SVGPathElement;
    const xs = Array.from((cross.getAttribute("d") ?? "").matchAll(/[ML]\s*(-?[\d.]+)\s+-?[\d.]+/g), (m) => Number(m[1]));
    // About 6 px wide and 1.4 thick, inside the 16 x 14 box and clear of the speaker (which ends at x = 8).
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThanOrEqual(5.5);
    expect(Math.min(...xs)).toBeGreaterThan(8);
    expect(Math.max(...xs)).toBeLessThanOrEqual(16);
    expect(cross.getAttribute("stroke-width")).toBe("1.4");
  });

  it("scales by height, keeping the mock's aspect", () => {
    const svg = svgOf(<AudioIcon size={28} />);
    expect(svg.getAttribute("height")).toBe("28");
    expect(svg.getAttribute("width")).toBe("32");
  });
});
