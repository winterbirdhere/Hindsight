import type React from "react";

/** Keep pointer-operated playback buttons from capturing Space, without discarding keyboard focus. */
export function preventPointerFocus(event: React.MouseEvent<HTMLElement>) {
  if (event.button === 0) event.preventDefault();
}

const ACTIVATION_ROLES = new Set(["button", "menuitem"]);

function isActivationControl(element: Element | null): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false;
  if (element instanceof HTMLButtonElement) return true;
  if (element instanceof HTMLInputElement) {
    return ["button", "image", "reset", "submit"].includes(element.type);
  }
  return ACTIVATION_ROLES.has(element.getAttribute("role") ?? "");
}

/**
 * Native dialogs return focus to the DOM element which opened them. Releasing
 * only activation controls prevents Space from clicking that command again,
 * while preserving focus in text inputs and other editing controls.
 */
export function releaseActiveActivationFocus(): void {
  const activeElement = document.activeElement;
  if (isActivationControl(activeElement)) activeElement.blur();
}
