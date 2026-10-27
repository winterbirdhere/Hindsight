import { cleanup, act, fireEvent, render, screen } from "@testing-library/react";
import { Segmented, SettingsSection, SliderRow, Stepper, SwitchRow, TextToggle, ToggleRow, ValueRow } from "./controls";

/** Space as a user types it. In the app it reaches a control only while no replay is loaded (play/pause owns it). */
function pressSpace(element: HTMLElement) {
  fireEvent.keyDown(element, { key: " " });
  fireEvent.keyUp(element, { key: " " });
}

/** Enter always activates a control. */
function pressEnter(element: HTMLElement) {
  fireEvent.keyDown(element, { key: "Enter" });
  fireEvent.keyUp(element, { key: "Enter" });
}

const style = (element: Element) => getComputedStyle(element);

describe("TextToggle", () => {
  it("reports the opposite state on click, on Enter and on Space", () => {
    const onChange = jest.fn();
    const { rerender } = render(<TextToggle label="UR" checked={false} onChange={onChange} />);
    const toggle = screen.getByRole("checkbox", { name: "UR" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(true);
    pressEnter(toggle);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith(true);
    pressSpace(toggle);
    expect(onChange).toHaveBeenCalledTimes(3);
    expect(onChange).toHaveBeenLastCalledWith(true);

    rerender(<TextToggle label="UR" checked onChange={onChange} />);
    expect(screen.getByRole("checkbox", { name: "UR" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("checkbox", { name: "UR" }));
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it("a disabled toggle does not change, and dims as a whole", () => {
    const onChange = jest.fn();
    render(<TextToggle label="UR" checked={false} onChange={onChange} disabled />);
    const toggle = screen.getByRole("checkbox", { name: "UR" });
    fireEvent.click(toggle);
    pressEnter(toggle);
    pressSpace(toggle);
    expect(onChange).not.toHaveBeenCalled();
    expect(toggle.getAttribute("aria-disabled")).toBe("true");
    expect(style(toggle).opacity).toBe("0.4");
  });

  it("draws a check when on, a hollow dot when off, and a colour bar when given a colour", () => {
    const { rerender } = render(<TextToggle label="UR" checked onChange={jest.fn()} />);
    expect(screen.getByRole("checkbox", { name: "UR" }).querySelector("polyline")).not.toBeNull();
    rerender(<TextToggle label="UR" checked={false} onChange={jest.fn()} />);
    expect(screen.getByRole("checkbox", { name: "UR" }).querySelector("polyline")).toBeNull();
    expect(screen.getByRole("checkbox", { name: "UR" }).querySelector("[data-mark='dot']")).not.toBeNull();

    rerender(<TextToggle label="100" checked={false} onChange={jest.fn()} color="#8fe8af" />);
    const bar = screen.getByRole("checkbox", { name: "100" }).querySelector("[data-mark='bar']") as HTMLElement;
    expect(style(bar).width).toBe("3px");
    expect(style(bar).height).toBe("12px");
    expect(style(bar).opacity).toBe("0.3");
    rerender(<TextToggle label="100" checked onChange={jest.fn()} color="#8fe8af" />);
    expect(style(screen.getByRole("checkbox", { name: "100" }).querySelector("[data-mark='bar']") as HTMLElement).opacity).toBe("1");
  });

  it("is 28 px high and never wider than its row, clipping a long label rather than overflowing", () => {
    render(<TextToggle label="A very long label that cannot fit" checked onChange={jest.fn()} />);
    const toggle = screen.getByRole("checkbox");
    expect(style(toggle).height).toBe("28px");
    expect(style(toggle).maxWidth).toBe("100%");
    const text = Array.from(toggle.querySelectorAll("span")).find((span) => span.textContent === "A very long label that cannot fit");
    expect(style(text as Element).overflow).toBe("hidden");
    expect(style(text as Element).textOverflow).toBe("ellipsis");
  });
});

describe("SwitchRow", () => {
  it("is a switch that reports the opposite state on click", () => {
    const onChange = jest.fn();
    render(<SwitchRow label="Show cursor" checked onChange={onChange} />);
    const control = screen.getByRole("switch", { name: "Show cursor" });
    expect(control.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(control);
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it("changes on Enter, and on Space while no replay is loaded", () => {
    const onChange = jest.fn();
    render(<SwitchRow label="Show cursor" checked={false} onChange={onChange} />);
    const control = screen.getByRole("switch", { name: "Show cursor" });
    pressEnter(control);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(true);
    pressSpace(control);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("exposes its hint as the description", () => {
    render(<SwitchRow label="Show analysis cursor" hint="Marks where each press landed." checked={false} onChange={jest.fn()} />);
    const control = screen.getByRole("switch", { name: "Show analysis cursor" });
    const describedBy = control.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)?.textContent).toBe("Marks where each press landed.");
  });

  it("keeps the mock's natural line heights, so a row with a hint is not taller than in the design", () => {
    render(<SwitchRow label="Show analysis cursor" hint="Marks where each press landed." checked={false} onChange={jest.fn()} />);
    // Both lines say `normal` themselves: left unset they would inherit the app's 1.5 from CssBaseline (an 18 px
    // hint where the design has about 15 px).
    expect(style(screen.getByText("Show analysis cursor")).lineHeight).toBe("normal");
    expect(style(screen.getByText("Marks where each press landed.")).lineHeight).toBe("normal");
  });

  it("wraps a long label and hint beside the switch instead of overflowing", () => {
    render(<SwitchRow label="Show analysis cursor" hint="A long hint that runs on" checked onChange={jest.fn()} />);
    const text = screen.getByText("A long hint that runs on");
    expect(style(text).overflowWrap).toBe("anywhere");
    expect(["0", "0px"]).toContain(style(text.parentElement as Element).minWidth);
    const track = screen.getByRole("switch").querySelector("[data-switch-track]") as HTMLElement;
    expect(style(track).width).toBe("30px");
    expect(style(track).height).toBe("18px");
    expect(style(track).flexShrink).toBe("0");
  });

  it("has no description when there is no hint, and does not change while disabled", () => {
    const onChange = jest.fn();
    render(<SwitchRow label="Smooth trail" checked disabled onChange={onChange} />);
    const control = screen.getByRole("switch", { name: "Smooth trail" });
    expect(control.hasAttribute("aria-describedby")).toBe(false);
    fireEvent.click(control);
    pressEnter(control);
    pressSpace(control);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("SliderRow", () => {
  it("shows the value with a percent sign", () => {
    render(<SliderRow label="Size" value={100} min={10} max={200} onChange={jest.fn()} />);
    const slider = screen.getByRole("slider", { name: "Size" }) as HTMLInputElement;
    expect(screen.getByText("100%")).toBeTruthy();
    expect(slider.min).toBe("10");
    expect(slider.max).toBe("200");
    expect(slider.getAttribute("aria-valuetext")).toBe("100%");
  });

  it("reports keyboard steps", () => {
    const onChange = jest.fn();
    render(<SliderRow label="Size" value={100} min={10} max={200} onChange={onChange} />);
    const slider = screen.getByRole("slider", { name: "Size" });
    // MUI steps by ten on Shift+Arrow and PageUp/PageDown. A plain arrow is the browser's own range-input step.
    fireEvent.keyDown(slider, { key: "ArrowRight", shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith(110);
    fireEvent.keyDown(slider, { key: "PageDown" });
    expect(onChange).toHaveBeenLastCalledWith(90);
    fireEvent.change(slider, { target: { value: "101" } });
    expect(onChange).toHaveBeenLastCalledWith(101);
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it("never reports a change while disabled", () => {
    const onChange = jest.fn();
    render(<SliderRow label="Size" value={100} min={10} max={200} disabled onChange={onChange} />);
    const slider = screen.getByRole("slider", { name: "Size" }) as HTMLInputElement;
    expect(slider.disabled).toBe(true);
    const root = slider.closest(".MuiSlider-root") as HTMLElement;
    fireEvent.mouseDown(root, { button: 0, clientX: 10 });
    fireEvent.mouseUp(document, { button: 0, clientX: 10 });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps the mock's geometry: a 120 px track and a 40 px value", () => {
    render(<SliderRow label="Size" value={100} min={10} max={200} onChange={jest.fn()} />);
    const slider = screen.getByRole("slider", { name: "Size" });
    expect(style(slider.closest(".MuiSlider-root") as Element).width).toBe("120px");
    expect(style(screen.getByText("100%")).width).toBe("40px");
  });

  it("wraps its control under the label when they do not fit, and never lets the label collapse", () => {
    render(<SliderRow label="Size" value={100} min={10} max={200} onChange={jest.fn()} />);
    const label = screen.getByText("Size");
    const row = label.parentElement as HTMLElement;
    const control = (screen.getByText("100%").parentElement as HTMLElement);
    expect(style(row).flexWrap).toBe("wrap");
    expect(style(label).flexGrow).toBe("1");
    expect(style(label).flexShrink).toBe("1");
    expect(style(label).flexBasis).toBe("auto");
    expect(style(label).minWidth).not.toBe("0px");
    expect(style(control).marginLeft).toBe("auto");
    expect(style(control).flexGrow).toBe("0");
    expect(style(control).flexShrink).toBe("0");
  });

  it("is a 38 px row, or 32 px when dense", () => {
    const { rerender } = render(<SliderRow label="Size" value={100} min={10} max={200} onChange={jest.fn()} />);
    expect(style(screen.getByText("Size").parentElement as Element).minHeight).toBe("38px");
    rerender(<SliderRow label="Size" value={100} min={10} max={200} dense onChange={jest.fn()} />);
    expect(style(screen.getByText("Size").parentElement as Element).minHeight).toBe("32px");
  });

  it("releases focus after a pointer drag but not after a key", () => {
    render(<SliderRow label="Dim" value={50} min={0} max={100} onChange={jest.fn()} />);
    const slider = screen.getByRole("slider", { name: "Dim" }) as HTMLInputElement;
    const root = slider.closest(".MuiSlider-root") as HTMLElement;
    act(() => slider.focus());
    expect(document.activeElement).toBe(slider);
    fireEvent.keyDown(slider, { key: "ArrowRight", shiftKey: true });
    fireEvent.change(slider, { target: { value: "51" } });
    expect(document.activeElement).toBe(slider);

    // A pointer press moves focus to the thumb; letting go must give it back.
    fireEvent.mouseDown(root, { button: 0, clientX: 10 });
    expect(document.activeElement).toBe(slider);
    fireEvent.mouseUp(document, { button: 0, clientX: 10 });
    expect(document.activeElement).not.toBe(slider);
  });
});

describe("Segmented", () => {
  const options = [
    { value: "concise", label: "Concise" },
    { value: "brief", label: "Brief" },
  ] as const;

  it("opts Library choices into accent selection without changing the viewer default", () => {
    const onChange = jest.fn();
    const rendered = render(<Segmented label="Detail" value="concise" options={options} onChange={onChange} />);
    const concise = screen.getByRole("button", { name: "Concise" });
    const brief = screen.getByRole("button", { name: "Brief" });
    const neutralFace = style(concise).boxShadow;
    expect(neutralFace).not.toContain("#ff7aa0");
    expect(fireEvent.mouseDown(brief, { button: 0 })).toBe(false);
    rendered.rerender(<Segmented label="Detail" value="concise" options={options} onChange={onChange}
      selectionAppearance="accent" focusOnPointer />);
    expect(style(concise).boxShadow).toContain("#ff7aa0");
    expect(style(brief).boxShadow).toBe("none");
    expect(fireEvent.mouseDown(brief, { button: 0 })).toBe(true);
    act(() => brief.focus());
    pressSpace(brief);
    // Native buttons synthesize click from Space in Chromium; jsdom does not.
    expect(document.activeElement).toBe(brief);
    fireEvent.click(brief);
    expect(onChange).toHaveBeenLastCalledWith("brief");
    rendered.rerender(<Segmented label="Detail" value="brief" options={options} onChange={onChange}
      selectionAppearance="accent" focusOnPointer />);
    expect(style(concise).boxShadow).toBe("none");
    expect(style(brief).boxShadow).toContain("#ff7aa0");
    expect(document.activeElement).toBe(brief);
    rendered.rerender(<Segmented label="Detail" value="brief" options={options} onChange={onChange}
      selectionAppearance="accent" disabled />);
    onChange.mockClear();
    fireEvent.click(concise);
    expect(onChange).not.toHaveBeenCalled();
    expect(style(brief).boxShadow).toContain("#ff7aa0");
    rendered.rerender(<Segmented label="Detail" value="brief" options={options} onChange={onChange} />);
    expect(style(brief).boxShadow).toBe(neutralFace);
  });

  it("marks the selected option pressed and reports the other", () => {
    const onChange = jest.fn();
    render(<Segmented label="Error cause detail" value="concise" options={options} onChange={onChange} />);
    expect(screen.getByRole("group", { name: "Error cause detail" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Concise" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Brief" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Concise" }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Brief" }));
    expect(onChange).toHaveBeenCalledWith("brief");
  });

  it("never reports a change while disabled, and its row dims as a whole", () => {
    const onChange = jest.fn();
    render(
      <ValueRow label="Detail" disabled>
        <Segmented label="Detail" value="concise" options={options} onChange={onChange} disabled />
      </ValueRow>,
    );
    const brief = screen.getByRole("button", { name: "Brief" }) as HTMLButtonElement;
    expect(brief.disabled).toBe(true);
    fireEvent.click(brief);
    expect(onChange).not.toHaveBeenCalled();
    // The choice stays readable.
    expect(screen.getByRole("button", { name: "Concise" }).getAttribute("aria-pressed")).toBe("true");
    const row = screen.getByText("Detail").parentElement as HTMLElement;
    expect(row.contains(brief)).toBe(true);
    expect(style(row).opacity).toBe("0.4");
  });

  it("a row that is not disabled is not dimmed", () => {
    render(
      <ValueRow label="Detail">
        <Segmented label="Detail" value="concise" options={options} onChange={jest.fn()} />
      </ValueRow>,
    );
    expect(style(screen.getByText("Detail").parentElement as HTMLElement).opacity).toBe("1");
    expect((screen.getByRole("button", { name: "Brief" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("fills a fixed width with equal segments, but never more than its row", () => {
    render(<Segmented label="Settings for" value="concise" options={options} onChange={jest.fn()} width={190} />);
    const group = screen.getByRole("group", { name: "Settings for" });
    expect(style(group).width).toBe("190px");
    expect(style(group).maxWidth).toBe("100%");
  });
});

describe("layout helpers", () => {
  it("renders a section label and its children, and a value row with a label and a control", () => {
    render(
      <SettingsSection label="Timing">
        <ToggleRow>
          <TextToggle label="UR" checked onChange={jest.fn()} />
        </ToggleRow>
        <ValueRow label="Error cause detail">
          <span>control</span>
        </ValueRow>
      </SettingsSection>,
    );
    expect(screen.getByText("Timing")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Timing" })).toBeTruthy();
    expect(screen.getByText("Error cause detail")).toBeTruthy();
    expect(screen.getByText("control")).toBeTruthy();
  });

  it("pads a rows section 14/20/10 and a toggles section 10/20/8, with a hairline unless last", () => {
    render(
      <div>
        <SettingsSection label="Rows">
          <span>a</span>
        </SettingsSection>
        <SettingsSection label="Toggles" variant="toggles" last>
          <span>b</span>
        </SettingsSection>
      </div>,
    );
    const rows = screen.getByRole("group", { name: "Rows" });
    const toggles = screen.getByRole("group", { name: "Toggles" });
    expect([style(rows).paddingTop, style(rows).paddingRight, style(rows).paddingBottom]).toEqual(["14px", "20px", "10px"]);
    expect([style(toggles).paddingTop, style(toggles).paddingRight, style(toggles).paddingBottom]).toEqual(["10px", "20px", "8px"]);
    expect(style(rows).boxShadow).toContain("rgba(255,255,255,0.08)");
    expect(style(toggles).boxShadow).toBe("none");
    expect(style(toggles).gap).toBe("4px");
    expect(style(screen.getByText("Toggles")).textTransform).toBe("uppercase");
  });

  it("wraps toggles and value rows instead of overflowing", () => {
    render(
      <div>
        <ToggleRow>
          <TextToggle label="UR" checked onChange={jest.fn()} />
        </ToggleRow>
        <ValueRow label="Settings for">
          <span>control</span>
        </ValueRow>
      </div>,
    );
    expect(style(screen.getByRole("checkbox").parentElement as Element).flexWrap).toBe("wrap");
    const label = screen.getByText("Settings for");
    expect(style(label.parentElement as Element).flexWrap).toBe("wrap");
    expect(style(label.parentElement as Element).minHeight).toBe("32px");
    expect(style(label).minWidth).not.toBe("0px");
    expect(style(screen.getByText("control").parentElement as Element).marginLeft).toBe("auto");
  });
});

describe("pointer focus", () => {
  it("can opt switches and segments into native pointer focus without changing keyboard activation", () => {
    const switchChange = jest.fn();
    const segmentChange = jest.fn();
    render(<>
      <SwitchRow label="Background option" checked={false} onChange={switchChange} focusOnPointer />
      <Segmented label="Workers" value="1" options={[{ value: "1", label: "1" }, { value: "2", label: "2" }]}
        onChange={segmentChange} focusOnPointer />
    </>);
    const control = screen.getByRole("switch", { name: "Background option" });
    const segment = screen.getByRole("button", { name: "2" });
    expect(fireEvent.mouseDown(control, { button: 0 })).toBe(true);
    expect(fireEvent.mouseDown(segment, { button: 0 })).toBe(true);
    fireEvent.click(segment);
    expect(segmentChange).toHaveBeenLastCalledWith("2");
    act(() => control.focus());
    pressEnter(control);
    pressSpace(control);
    expect(switchChange.mock.calls).toEqual([[true], [true]]);
    expect(document.activeElement).toBe(control);
  });
  it("no toggle, switch or segment keeps focus after a pointer press", () => {
    render(
      <div>
        <TextToggle label="UR" checked onChange={jest.fn()} />
        <SwitchRow label="Show cursor" checked onChange={jest.fn()} />
        <Segmented
          label="Detail"
          value="a"
          options={[
            { value: "a", label: "A" },
            { value: "b", label: "B" },
          ]}
          onChange={jest.fn()}
        />
      </div>,
    );
    for (const element of [
      screen.getByRole("checkbox", { name: "UR" }),
      screen.getByRole("switch", { name: "Show cursor" }),
      screen.getByRole("button", { name: "A" }),
      screen.getByRole("button", { name: "B" }),
    ]) {
      // fireEvent returns false when the default action (taking focus) was prevented. Only our own handler
      // prevents it on these controls. The slider is covered by "releases focus after a pointer drag" above:
      // MUI prevents the default itself, so a mouseDown check there would pass without our code.
      expect(fireEvent.mouseDown(element, { button: 0 })).toBe(false);
    }
  });
});

describe("Stepper", () => {
  const options = ["Auto", "1/1", "1/2", "1/3", "1/4", "1/6", "1/8"].map((label) => ({ value: label.toLowerCase(), label }));
  function mount(value: string, extra: { disabled?: boolean } = {}) {
    const onChange = jest.fn();
    render(<Stepper label="Scroll step" value={value} options={options} onChange={onChange} {...extra} />);
    const group = screen.getByRole("group", { name: "Scroll step" });
    const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
    return { onChange, group, button };
  }

  it("is three buttons however many values there are: one down, the value, one up", () => {
    const { group, button } = mount("1/2");
    expect(group.querySelectorAll("button")).toHaveLength(3);
    expect(button("Scroll step: 1/2").textContent).toBe("1/2");
    expect(button("Scroll step: previous").textContent).toBe("−");
    expect(button("Scroll step: next").textContent).toBe("+");
  });

  it("steps to the neighbouring value", () => {
    const { onChange, button } = mount("1/2");
    fireEvent.click(button("Scroll step: next"));
    fireEvent.click(button("Scroll step: previous"));
    expect(onChange.mock.calls).toEqual([["1/3"], ["1/1"]]);
  });

  it("stops at its ends", () => {
    const first = mount("auto");
    expect(first.button("Scroll step: previous").disabled).toBe(true);
    expect(first.button("Scroll step: next").disabled).toBe(false);
    cleanup();
    const last = mount("1/8");
    expect(last.button("Scroll step: next").disabled).toBe(true);
    expect(last.button("Scroll step: previous").disabled).toBe(false);
  });

  it("opens the whole list from the value, with the chosen one marked, and takes a choice from it", () => {
    const { onChange, button } = mount("1/2");
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(button("Scroll step: 1/2"));
    const items = screen.getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual(["Auto", "1/1", "1/2", "1/3", "1/4", "1/6", "1/8"]);
    expect(items.map((item) => item.classList.contains("Mui-selected"))).toEqual([false, false, true, false, false, false, false]);
    fireEvent.click(items[5]);
    expect(onChange).toHaveBeenCalledWith("1/6");
  });

  it("takes no input while disabled", () => {
    const { onChange, group } = mount("1/2", { disabled: true });
    for (const control of Array.from(group.querySelectorAll("button"))) {
      expect(control.disabled).toBe(true);
      fireEvent.click(control);
    }
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("does not grow or shrink with its value: the value has a width of its own", () => {
    const { button } = mount("auto");
    expect(getComputedStyle(button("Scroll step: Auto")).minWidth).toBe("52px");
    expect(getComputedStyle(button("Scroll step: previous")).width).toBe("26px");
  });
});

describe("ValueRow in a section of switch and slider rows", () => {
  it("takes the height and the breathing room of the rows around it when roomy", () => {
    render(
      <>
        <ValueRow label="Tight">x</ValueRow>
        <ValueRow label="Roomy" roomy>
          y
        </ValueRow>
      </>,
    );
    const row = (label: string) => screen.getByText(label).parentElement as HTMLElement;
    expect([getComputedStyle(row("Tight")).minHeight, getComputedStyle(row("Tight")).paddingTop]).toEqual(["32px", ""]);
    // As a slider row: 38 px with 4 px above and below, so a wrapped control belongs to its own label.
    expect([getComputedStyle(row("Roomy")).minHeight, getComputedStyle(row("Roomy")).paddingTop, getComputedStyle(row("Roomy")).paddingBottom]).toEqual(["38px", "4px", "4px"]);
  });
});
