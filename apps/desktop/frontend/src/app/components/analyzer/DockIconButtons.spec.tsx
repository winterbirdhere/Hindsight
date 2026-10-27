import { act, fireEvent, render, screen } from "@testing-library/react";
import { useModControls } from "../../hooks/mods";
import { useAudioSettings, useAudioSettingsService } from "../../hooks/audio";
import { InspectorProvider, useInspector, type InspectorState } from "../../providers/InspectorProvider";
import { AudioButton, HiddenButton, SettingsButton } from "./DockIconButtons";

jest.mock("../../hooks/mods", () => ({ useModControls: jest.fn() }));
jest.mock("../../hooks/audio", () => ({ useAudioSettings: jest.fn(), useAudioSettingsService: jest.fn() }));

function mount(hidden: boolean) {
  const setHidden = jest.fn();
  (useModControls as jest.Mock).mockReturnValue({ hidden, setHidden });
  render(<HiddenButton />);
  const button = screen.getByRole("button", { name: "Toggle Hidden visualization" });
  return { button, image: button.querySelector("img") as HTMLImageElement, setHidden };
}

describe("HiddenButton", () => {
  it("shows a 30 px icon in a 36 × 28 button, so the icon is not cropped and the row keeps its height", () => {
    const { button, image } = mount(false);
    expect(getComputedStyle(button).width).toBe("36px");
    expect(getComputedStyle(button).height).toBe("28px");
    expect(getComputedStyle(image).width).toBe("30px");
    expect(getComputedStyle(image).height).toBe("auto");
  });

  it("is a little more legible when off, and full strength when on", () => {
    const off = mount(false);
    expect(getComputedStyle(off.image).opacity).toBe("0.7");
    expect(getComputedStyle(off.image).filter).toBe("grayscale(0.6) brightness(0.95)");
    expect(off.button.getAttribute("aria-pressed")).toBe("false");
  });

  it("keeps its accessible name, pressed state and click behaviour", () => {
    const on = mount(true);
    expect(on.button.getAttribute("aria-pressed")).toBe("true");
    expect(on.image.getAttribute("alt")).toBe("");
    expect(on.image.getAttribute("aria-hidden")).toBe("true");
    expect(getComputedStyle(on.image).opacity).toBe("1");
    fireEvent.click(on.button);
    expect(on.setHidden).toHaveBeenCalledWith(false);
  });
});

function glyphOf(button: HTMLElement) {
  const svgs = button.querySelectorAll("svg");
  expect(svgs).toHaveLength(1);
  return svgs[0] as SVGSVGElement;
}

describe("AudioButton and SettingsButton glyphs", () => {
  function mockAudio(muted: boolean) {
    (useAudioSettings as jest.Mock).mockReturnValue({ muted, volume: { master: 0.5, music: 0.5, effects: 0.5 } });
    (useAudioSettingsService as jest.Mock).mockReturnValue({});
  }

  it("shows the 3a speaker with its two arcs, keeping the name Audio settings", () => {
    mockAudio(false);
    render(<AudioButton />);
    const svg = glyphOf(screen.getByRole("button", { name: "Audio settings" }));
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("viewBox")).toBe("0 0 16 14");
    expect(svg.querySelector("path")?.getAttribute("d")).toContain("Q12.5 7");
    expect(svg.getAttribute("data-testid")).toBeNull();
  });

  it("shows the muted speaker (a cross, no arcs) while muted, with the same accessible name", () => {
    mockAudio(true);
    render(<AudioButton />);
    const svg = glyphOf(screen.getByRole("button", { name: "Audio settings" }));
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.querySelector("path")?.getAttribute("d")).toBe("M10 4.2 L15.6 9.8 M15.6 4.2 L10 9.8");
  });

  it("shows the outlined gear and the label in Settings, like the other dock text buttons", () => {
    mountGear();
    const button = screen.getByRole("button", { name: "Settings" });
    const svg = glyphOf(button);
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("data-testid")).toBe("SettingsOutlinedIcon");
    // jsdom's computed style ignores selector specificity, so look for the 16 px rule that targets the glyph.
    const sizedTo16 = Array.from(document.styleSheets)
      .flatMap((sheet) => Array.from(sheet.cssRules))
      .some((rule) => rule instanceof CSSStyleRule && rule.style.getPropertyValue("font-size") === "16px" && svg.matches(rule.selectorText));
    expect(sizedTo16).toBe(true);
    expect(button.textContent).toBe("Settings");
    // Its label is displayed, so there is no title repeating it.
    expect(button.hasAttribute("title")).toBe(false);
    // 28 px tall text button with 8 px side padding, not the 28 px square icon button.
    expect(getComputedStyle(button).height).toBe("28px");
    expect(getComputedStyle(button).paddingLeft).toBe("8px");
    expect(getComputedStyle(button).width).not.toBe("28px");
  });
});

let inspector: InspectorState;
function Capture() {
  inspector = useInspector();
  return null;
}

function mountGear(options: { locked?: boolean; initialMode?: "incidents" | "settings" } = {}) {
  return render(
    <InspectorProvider locked={options.locked} initialMode={options.initialMode}>
      <Capture />
      <SettingsButton />
    </InspectorProvider>,
  );
}

describe("SettingsButton", () => {
  it("the gear opens and closes Settings and shows its pressed state", () => {
    mountGear();
    const button = screen.getByRole("button", { name: "Settings" });
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(inspector.mode).toBe("incidents");
    const idle = getComputedStyle(button).backgroundColor;

    fireEvent.click(button);
    expect(inspector.mode).toBe("settings");
    expect(button.getAttribute("aria-pressed")).toBe("true");
    // The open mode's quiet filled state (the same as Export while its dialog is open).
    expect(getComputedStyle(button).backgroundColor).not.toBe(idle);

    fireEvent.click(button);
    expect(inspector.mode).toBe("incidents");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(getComputedStyle(button).backgroundColor).toBe(idle);

    // Esc closes Settings, and the gear follows.
    fireEvent.click(button);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });

  it("is named Settings, and does not keep focus after a pointer press", () => {
    mountGear();
    const button = screen.getByRole("button", { name: "Settings" });
    expect(screen.queryByRole("button", { name: "Viewer settings" })).toBeNull();
    expect(fireEvent.mouseDown(button, { button: 0 })).toBe(false);
  });

  it("the gear does nothing while a clip is exporting", () => {
    mountGear({ locked: true });
    const button = screen.getByRole("button", { name: "Settings" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(inspector.mode).toBe("incidents");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    act(() => inspector.toggleSettings());
    expect(inspector.mode).toBe("incidents");
  });

  it("shows pressed while Settings is open at the start", () => {
    mountGear({ initialMode: "settings" });
    expect(screen.getByRole("button", { name: "Settings" }).getAttribute("aria-pressed")).toBe("true");
  });
});
