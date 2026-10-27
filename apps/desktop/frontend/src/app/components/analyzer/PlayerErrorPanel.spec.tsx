import { render, screen } from "@testing-library/react";
import { PlayerErrorCause as CauseView } from "./PlayerErrorPanel";
import type { ComponentMechanism } from "../../../../../../../libs/osu/core/src/gameplay/error-analysis/ComponentMechanisms";

function mechanism(
  headline = "Aim late",
  codes = ["aim-late"],
  status: ComponentMechanism["status"] = "supported",
): ComponentMechanism {
  return {
    status,
    headline,
    codes,
    description: "A paragraph that must never appear.",
    metric: { value: 4.51, unit: "ms" },
    eventIds: ["r1"],
    limitations: ["reconstructed-path"],
  };
}
const renderCause = (mechanisms: readonly ComponentMechanism[] = [mechanism()]) =>
  render(<CauseView mechanisms={mechanisms} />);

describe("immediate inline player error cause", () => {
  it("changes detail immediately while preserving the exact diagnosis and source mechanism", () => {
    const value = {
      ...mechanism("Early tap", ["early-tap"]),
      briefDetail: { phrase: "before arrival", metric: { value: 24.6, unit: "ms" } },
    };
    const before = JSON.stringify(value);
    const { container, rerender } = render(<CauseView mechanisms={[value]} />);
    expect(container.textContent).toBe("Early tap");
    rerender(<CauseView mechanisms={[value]} displayMode="brief" />);
    expect(container.textContent).toBe("Early tap · before arrival · 25 ms");
    expect(screen.getByRole("status", { name: "Error cause" }).tagName).toBe("SPAN");
    expect(container.querySelectorAll("p,button,details,[role=dialog]")).toHaveLength(0);
    rerender(<CauseView mechanisms={[value]} displayMode="concise" />);
    expect(container.textContent).toBe("Early tap");
    expect(JSON.stringify(value)).toBe(before);
  });

  it("adds no filler or legacy diagnostic description when no brief detail is supplied", () => {
    const { container } = render(<CauseView mechanisms={[mechanism("Notelock", ["notelock"])]} displayMode="brief" />);
    expect(container.textContent).toBe("Notelock");
  });

  it("renders a supplied metric alone without adding a filler phrase or empty separator", () => {
    const value = {
      ...mechanism("Early tap", ["early-tap"]),
      briefDetail: { phrase: "", metric: { value: 49.8, unit: "ms early" } },
    };
    const { container, rerender } = render(<CauseView mechanisms={[value]} />);
    expect(container.textContent).toBe("Early tap");
    rerender(<CauseView mechanisms={[value]} displayMode="brief" />);
    expect(container.textContent).toBe("Early tap · 50 ms early");
  });

  it("omits a wholly empty detail with an invalid number", () => {
    const value = {
      ...mechanism("Notelock", ["notelock"]),
      briefDetail: { phrase: " ", metric: { value: NaN, unit: "ms" } },
    };
    const { container } = render(<CauseView mechanisms={[value]} displayMode="brief" />);
    expect(container.textContent).toBe("Notelock");
  });

  it("does not choose one competing brief observation or show multiple numbers", () => {
    const a = {
      ...mechanism("Misaim", ["misaim"]),
      briefDetail: { phrase: "wide landing", metric: { value: 4, unit: "px" } },
    };
    const b = {
      ...mechanism("Early tap", ["early-tap"]),
      briefDetail: { phrase: "before arrival", metric: { value: 24, unit: "ms" } },
    };
    const { container } = render(<CauseView mechanisms={[a, b]} displayMode="brief" />);
    expect(container.textContent).toBe("Misaim · Early tap");
  });

  it("omits non-finite optional numbers while retaining the supplied phrase", () => {
    const value = {
      ...mechanism("Misaim", ["misaim"]),
      briefDetail: { phrase: "wide landing", metric: { value: NaN, unit: "px" } },
    };
    const { container } = render(<CauseView mechanisms={[value]} displayMode="brief" />);
    expect(container.textContent).toBe("Misaim · wide landing");
  });

  it("shows only the recognizable cause immediately, without interaction, paragraphs or numbers", () => {
    const { container } = renderCause();
    const cause = screen.getByRole("status", { name: "Error cause" });
    expect(cause.tagName).toBe("SPAN");
    expect(cause.textContent).toBe("Late entry");
    expect(container.textContent).toBe("Late entry");
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("heading")).toBeNull();
    expect(container.querySelector("p")).toBeNull();
    expect(container.textContent).not.toMatch(/paragraph|\d|r1|reconstruct|predicate|coverage|profile|event|evidence/i);
  });

  it.each([
    ["aim-late", "Aim late", "Late entry"],
    ["left-early", "Left early", "Early exit"],
    ["released-early", "Released early", "Early release"],
  ])("uses the supported %s presentation wording", (code, headline, expected) => {
    renderCause([mechanism(headline, [code])]);
    expect(screen.getByRole("status").textContent).toBe(expected);
  });

  it.each([
    ["overshoot", "Overshoot", "Overaim"],
    ["undershoot", "Undershoot", "Underaim"],
  ])("shows the %s cause (%s) as %s", (code, headline, expected) => {
    const { container } = renderCause([mechanism(headline, [code])]);
    expect(container.textContent).toBe(expected);
  });

  it.each([
    ["wide-aim", "Wide aim"],
    ["early-tap", "Early tap"],
    ["late-tap", "Late tap"],
    ["notelock", "Notelock"],
    ["no-tap", "No tap"],
    ["off-track", "Off track"],
    ["no-hold", "No hold"],
    ["wrong-hold", "Wrong hold"],
    ["slow-spin", "Slow spin"],
  ])("preserves a specific %s cause", (code, headline) => {
    const { container } = renderCause([mechanism(headline, [code])]);
    expect(container.textContent).toBe(headline);
  });

  it("refuses more than two unranked contributors without picking their first labels", () => {
    const { container } = renderCause([
      mechanism("Notelock · Aim late", ["notelock", "aim-late"]),
      mechanism("Released early · Off track", ["released-early", "off-track"]),
      mechanism("Off track", ["off-track"]),
    ]);
    expect(container.innerHTML).toBe("");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("retains and deduplicates two independent causes across every supported contributor", () => {
    const { container } = renderCause([
      mechanism("Early tap · Off track", ["early-tap", "off-track"]),
      mechanism("Off track", ["off-track"]),
    ]);
    expect(container.textContent).toBe("Early tap · Off track");
  });

  it.each([
    mechanism("Late, stopped, reversed", ["started-late", "stopped-early", "reversed-spin"]),
    mechanism("Early tap · Off track · Early release", ["legacy-composite"]),
    mechanism("Early tap, Off track, Early release", ["legacy-composite"]),
  ])("rejects an unranked three-cause composite even when its encoding is abbreviated", (value) => {
    const before = JSON.stringify(value);
    const { container } = renderCause([value]);
    expect(container.innerHTML).toBe("");
    expect(JSON.stringify(value)).toBe(before);
  });

  it.each([
    mechanism("No re-tap", ["no-retap"]),
    mechanism("Tap taken", ["tap-taken"]),
    mechanism("Hit taken", ["tap-taken"]),
    mechanism("Changed words", ["tap-taken"]),
    mechanism("Changed words", ["no-retap"]),
    mechanism("No re-tap", ["old-cache-code"]),
    mechanism("Notelock · Hit taken", ["notelock", "old-cache-code"]),
  ])("does not expose a rejected cached player category or pick a remaining contributor", (value) => {
    const before = JSON.stringify(value);
    const { container, rerender } = renderCause([value, mechanism("Off track", ["off-track"])]);
    expect(container.innerHTML).toBe("");
    rerender(<CauseView mechanisms={[value]} displayMode="brief" />);
    expect(container.innerHTML).toBe("");
    expect(JSON.stringify(value)).toBe(before);
  });

  it("keeps opposing morphology rather than choosing one cause", () => {
    const { container } = renderCause([mechanism("Overshoot", ["overshoot"]), mechanism("Undershoot", ["undershoot"])]);
    expect(container.textContent).toBe("Overaim · Underaim");
  });

  it("does not reinterpret a headline without its corresponding presentation code", () => {
    const { container } = renderCause([mechanism("Aim late", ["other-specific-mechanism"])]);
    expect(container.textContent).toBe("Aim late");
  });

  it("disappears immediately when the parent invalidates the scoped selection", () => {
    const { container, rerender } = renderCause();
    expect(container.textContent).toBe("Late entry");
    rerender(<CauseView mechanisms={[]} />);
    expect(container.innerHTML).toBe("");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("does not cherry-pick a supported contributor when another is unavailable", () => {
    const { container } = renderCause([
      mechanism("Notelock", ["notelock"]),
      mechanism("Off track", ["off-track"], "unavailable"),
    ]);
    expect(container.innerHTML).toBe("");
  });

  it("does not substitute a cause or fallback for unavailable or conflicting evidence", () => {
    const { container } = renderCause([mechanism("Notelock", ["notelock"], "unavailable")]);
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing with no scoped mechanisms", () => {
    const { container } = renderCause([]);
    expect(container.innerHTML).toBe("");
  });

  it.each([mechanism("No tap", []), mechanism("No tap", [""]), mechanism("  ", ["no-tap"])])(
    "requires nonempty supported codes and a headline",
    (value) => {
      const { container } = renderCause([value]);
      expect(container.innerHTML).toBe("");
    },
  );

  it("renders a quiet row variant that only announces when asked", () => {
    const mechanisms = [mechanism("Late tap", ["late-tap"])];
    const { rerender } = render(<CauseView mechanisms={mechanisms} variant="row" />);
    expect(screen.getByText("Late tap")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    rerender(<CauseView mechanisms={mechanisms} variant="row" announce />);
    expect(screen.getByRole("status", { name: "Error cause" })).toBeTruthy();
  });
});
