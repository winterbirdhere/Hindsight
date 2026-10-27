import { fireEvent, render, screen } from "@testing-library/react";
import { BehaviorSubject } from "rxjs";
import { useAnalysisApp } from "../../providers/TheaterProvider";
import { RulesetSwitch } from "./RulesetSwitch";

jest.mock("../../providers/TheaterProvider", () => ({ useAnalysisApp: jest.fn() }));

function setup(lazerAvailable: boolean) {
  const setRulesetFocus = jest.fn();
  (useAnalysisApp as jest.Mock).mockReturnValue({
    gameSimulator: {
      rulesetFocus$: new BehaviorSubject("stable"),
      lazerAvailable$: new BehaviorSubject(lazerAvailable),
      getPrimaryReplay: () => ({ mods: [], lazerMods: [] }),
      setRulesetFocus,
    },
  });
  return { setRulesetFocus };
}

it("switches rulesets and marks the active one", () => {
  const { setRulesetFocus } = setup(true);
  render(<RulesetSwitch />);
  expect(screen.getByRole("button", { name: /^Stable/ }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: /^Lazer/ }));
  expect(setRulesetFocus).toHaveBeenCalledWith("lazer");
});

it("disables Lazer when it is unavailable", () => {
  setup(false);
  render(<RulesetSwitch />);
  expect((screen.getByRole("button", { name: /^Lazer/ }) as HTMLButtonElement).disabled).toBe(true);
});

it("keeps its size in a narrow row: it never shrinks, wraps or is squeezed", () => {
  setup(true);
  render(<RulesetSwitch />);
  const group = screen.getByRole("group", { name: "Analysis ruleset" });
  expect(getComputedStyle(group).flexShrink).toBe("0");
  expect(getComputedStyle(group).display).toBe("grid");
});

describe("preview", () => {
  it("renders both segments disabled with the previewed ruleset selected, and never calls the simulator", () => {
    const { setRulesetFocus } = setup(true);
    render(<RulesetSwitch preview="Lazer" />);
    const stable = screen.getByRole("button", { name: /^Stable/ }) as HTMLButtonElement;
    const lazer = screen.getByRole("button", { name: /^Lazer/ }) as HTMLButtonElement;
    expect([stable.disabled, lazer.disabled]).toEqual([true, true]);
    expect([stable.getAttribute("aria-pressed"), lazer.getAttribute("aria-pressed")]).toEqual(["false", "true"]);
    fireEvent.click(stable);
    fireEvent.click(lazer);
    expect(setRulesetFocus).not.toHaveBeenCalled();
  });

  it("makes no original-mode claim about a replay that is still loading", () => {
    setup(true);
    render(<RulesetSwitch preview="Stable" />);
    expect(screen.getByRole("button", { name: "Stable" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Lazer" }).getAttribute("aria-pressed")).toBe("false");
  });
});
