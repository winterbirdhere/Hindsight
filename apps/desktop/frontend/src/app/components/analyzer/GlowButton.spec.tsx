import { fireEvent, render, screen } from "@testing-library/react";
import { GhostButton, GlowButton } from "./GlowButton";

describe("GlowButton", () => {
  it("renders a button that reports clicks", () => {
    const onClick = jest.fn();
    render(<GlowButton onClick={onClick}>Open replay</GlowButton>);
    fireEvent.click(screen.getByRole("button", { name: "Open replay" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("renders an anchor that opens in a new tab with noopener when given an href", () => {
    render(<GlowButton href="https://osu.ppy.sh/beatmapsets/1#osu/2">Find beatmap</GlowButton>);
    const link = screen.getByRole("link", { name: "Find beatmap" });
    expect(link.getAttribute("href")).toBe("https://osu.ppy.sh/beatmapsets/1#osu/2");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("cannot be clicked while disabled", () => {
    const onClick = jest.fn();
    render(
      <GlowButton disabled onClick={onClick}>
        Open replay
      </GlowButton>,
    );
    const button = screen.getByRole("button", { name: "Open replay" }) as HTMLButtonElement;
    fireEvent.click(button);
    expect(button.disabled).toBe(true);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("GhostButton", () => {
  it("renders a button that reports clicks and cannot be clicked while disabled", () => {
    const onClick = jest.fn();
    const { rerender } = render(<GhostButton onClick={onClick}>Open another replay</GhostButton>);
    fireEvent.click(screen.getByRole("button", { name: "Open another replay" }));
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(
      <GhostButton disabled onClick={onClick}>
        Open another replay
      </GhostButton>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open another replay" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
