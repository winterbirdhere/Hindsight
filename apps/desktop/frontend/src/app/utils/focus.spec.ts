import { preventPointerFocus, releaseActiveActivationFocus } from "./focus";
import type React from "react";

describe("native-dialog focus release", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it.each([
    ["button", () => document.createElement("button")],
    [
      "menu item",
      () => {
        const item = document.createElement("div");
        item.setAttribute("role", "menuitem");
        item.tabIndex = 0;
        return item;
      },
    ],
  ])("releases a focused %s so Space cannot activate it again", (_label, createElement) => {
    const control = createElement();
    document.body.appendChild(control);
    control.focus();

    releaseActiveActivationFocus();

    expect(document.activeElement).toBe(document.body);
  });

  it.each(["text", "range"])("preserves focus in a %s input", (type) => {
    const input = document.createElement("input");
    input.type = type;
    document.body.appendChild(input);
    input.focus();

    releaseActiveActivationFocus();

    expect(document.activeElement).toBe(input);
  });
});

describe("pointer focus prevention", () => {
  afterEach(() => document.body.replaceChildren());

  it("cancels pointer focus without blurring a keyboard-focused control", () => {
    const button = document.createElement("button");
    document.body.appendChild(button);
    button.focus();
    button.addEventListener("mousedown", (event) => preventPointerFocus(event as unknown as React.MouseEvent<HTMLElement>));
    const primaryPress = new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true });
    button.dispatchEvent(primaryPress);

    expect(primaryPress.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(button);

    const secondaryPress = new MouseEvent("mousedown", { button: 2, bubbles: true, cancelable: true });
    button.dispatchEvent(secondaryPress);
    expect(secondaryPress.defaultPrevented).toBe(false);
  });
});
