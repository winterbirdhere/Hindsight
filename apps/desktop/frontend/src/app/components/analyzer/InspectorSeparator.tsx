import { Box } from "@mui/material";
import { useCallback, useEffect, useRef } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { REWIND_COLORS, REWIND_FOCUS_RING, REWIND_LAYOUT } from "../../styles/tokens";

const KEY_STEP = 16;
const KEY_STEP_LARGE = 64;
/** Wide enough to grab, narrow enough to leave the inspector's content alone; half of it lies over the stage. */
const HIT_WIDTH = 6;

interface Drag {
  pointerId: number;
  startX: number;
  startWidth: number;
  /** The strip the press started on; released and un-focused when the drag ends. */
  target: HTMLElement;
  /** Undoes what the drag did to the page (selection lock, window listeners). */
  release(): void;
  /** The width reached by the pointer so far; undefined until it has moved. */
  width?: number;
}

/**
 * While a drag runs the page must not select text. Cancelling `pointerdown` does not stop Chromium's default press
 * handling (it still starts a selection and focuses the strip), so the page is made unselectable and any selection
 * start is cancelled until the drag ends. Restores exactly what it changed.
 */
function lockTextSelection(): () => void {
  const root = document.documentElement;
  const previous = root.style.userSelect;
  root.style.userSelect = "none";
  const cancel = (event: Event) => event.preventDefault();
  document.addEventListener("selectstart", cancel, true);
  return () => {
    root.style.userSelect = previous;
    document.removeEventListener("selectstart", cancel, true);
  };
}

export interface InspectorSeparatorProps {
  /** Current effective width. */
  width: number;
  min: number;
  max: number;
  /** Live width while the pointer drags; nothing is saved. */
  onResize(width: number): void;
  /** A finished change (pointer release, key step, double-click); the parent saves it. */
  onCommit(width: number): void;
}

/**
 * Resize handle on the inspector column's left edge: drag it, or use the arrow keys. It only reports widths;
 * it never touches playback.
 */
export function InspectorSeparator({ width, min, max, onResize, onCommit }: InspectorSeparatorProps) {
  const drag = useRef<Drag | null>(null);
  const limit = useCallback((value: number) => Math.min(max, Math.max(min, Math.round(value))), [min, max]);
  const callbacks = useRef({ onCommit });
  callbacks.current = { onCommit };

  // Removed in the middle of a drag (the window shrank and the column folded): keep what the user reached, and give
  // the page its text selection back.
  useEffect(
    () => () => {
      const active = drag.current;
      drag.current = null;
      active?.release();
      if (active?.width !== undefined) callbacks.current.onCommit(active.width);
    },
    [],
  );

  /** Ends the drag of this pointer, wherever the release arrived; a no-op for any other pointer or no drag. */
  const finish = useCallback((pointerId: number) => {
    const active = drag.current;
    if (!active || active.pointerId !== pointerId) return;
    drag.current = null;
    active.release();
    try {
      active.target.releasePointerCapture?.(pointerId);
    } catch {
      // Capture may already be gone (cancelled or removed pointer).
    }
    // A press can leave the focus on the strip; the arrow keys must go on stepping the replay after a drag.
    if (document.activeElement === active.target) active.target.blur();
    if (active.width !== undefined) callbacks.current.onCommit(active.width);
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    let next: number;
    // The separator sits on the column's left edge, so Left moves the edge left and widens the column.
    if (event.key === "ArrowLeft") next = width + step;
    else if (event.key === "ArrowRight") next = width - step;
    else if (event.key === "Home") next = max;
    else if (event.key === "End") next = min;
    else return;
    // The page-wide playback shortcuts also listen to the arrow keys.
    event.preventDefault();
    event.stopPropagation();
    onCommit(limit(next));
  };

  return (
    // A focusable separator is a widget and exposes its value (ARIA 1.2); the lint rule's table predates that.
    // eslint-disable-next-line jsx-a11y/role-supports-aria-props
    <Box
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize inspector"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      tabIndex={0}
      // The press' own default (text selection, focus) belongs to `mousedown`; keyboard users reach the strip with Tab.
      onMouseDown={(event) => {
        if (event.button === 0) event.preventDefault();
      }}
      onPointerDown={(event: PointerEvent<HTMLElement>) => {
        if (event.button !== 0) return;
        // Not enough on its own in Chromium (see `lockTextSelection`); it still suppresses the compatibility mouse events.
        event.preventDefault();
        drag.current?.release();
        const { pointerId, currentTarget: target } = event;
        // The release can go elsewhere when the capture below fails or is lost: the window ends the drag then.
        const stop = (up: globalThis.PointerEvent | Event) => finish("pointerId" in up ? (up as globalThis.PointerEvent).pointerId : pointerId);
        window.addEventListener("pointerup", stop, true);
        window.addEventListener("pointercancel", stop, true);
        window.addEventListener("blur", stop);
        const unlock = lockTextSelection();
        drag.current = {
          pointerId,
          startX: event.clientX,
          startWidth: width,
          target,
          release: () => {
            unlock();
            window.removeEventListener("pointerup", stop, true);
            window.removeEventListener("pointercancel", stop, true);
            window.removeEventListener("blur", stop);
          },
        };
        try {
          target.setPointerCapture?.(pointerId);
        } catch {
          // Unsupported or already released pointer: the drag still works while the pointer stays over the strip.
        }
      }}
      onPointerMove={(event: PointerEvent<HTMLElement>) => {
        const active = drag.current;
        if (!active || active.pointerId !== event.pointerId) return;
        const next = limit(active.startWidth + (active.startX - event.clientX));
        active.width = next;
        onResize(next);
      }}
      onPointerUp={(event: PointerEvent<HTMLElement>) => finish(event.pointerId)}
      onPointerCancel={(event: PointerEvent<HTMLElement>) => finish(event.pointerId)}
      onLostPointerCapture={(event: PointerEvent<HTMLElement>) => finish(event.pointerId)}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onCommit(limit(REWIND_LAYOUT.inspectorWidth))}
      sx={{
        position: "absolute",
        top: 0,
        bottom: 0,
        left: -HIT_WIDTH / 2,
        width: HIT_WIDTH,
        // Above the inspector, below the stage-edge toggle (6), and only this strip.
        zIndex: 5,
        cursor: "col-resize",
        touchAction: "none",
        userSelect: "none",
        outline: "none",
        // A hairline in the middle shows where the edge can be grabbed.
        "&::after": {
          content: '""',
          position: "absolute",
          top: 0,
          bottom: 0,
          left: HIT_WIDTH / 2 - 1,
          width: 2,
          backgroundColor: "transparent",
          transition: "background-color 120ms",
        },
        "&:hover::after": { backgroundColor: REWIND_COLORS.hairline },
        "&:focus-visible": { ...REWIND_FOCUS_RING, outlineOffset: -2 },
        "&:focus-visible::after": { backgroundColor: REWIND_COLORS.hairline },
      }}
    />
  );
}
