import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
  type RefObject,
} from "react";

const paths = {
  close: "M4 4l12 12M16 4 4 16",
  plus: "M10 3v14M3 10h14",
  chevron: "m7 4 6 6-6 6",
  down: "m4 7 6 6 6-6",
  sidebar: "M7 3v14M4 3h12a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z",
  grid: "M3 3h5v5H3zM12 3h5v5h-5zM3 12h5v5H3zM12 12h5v5h-5z",
  list: "M3 5h14M3 10h14M3 15h14",
  search: "M9 3a6 6 0 1 0 0 12A6 6 0 0 0 9 3Zm4.5 10.5L18 18",
  filter: "M3 5h14M6 10h8M8 15h4",
  folder: "M2 5h6l2 2h8v10H2z",
  bookmark: "M5 3h10v14l-5-3-5 3z",
  play: "m6 3 11 7-11 7z",
  heart: "M10 17 3 10C-1 3 7 1 10 6c3-5 11-3 7 4Z",
  clock: "M10 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16Zm0 3v5l4 2",
  more: "M4 10h.01M10 10h.01M16 10h.01",
  sort: "M6 3v14m-4-4 4 4 4-4M14 3v14m-4-10 4-4 4 4",
  star: "m10 2 2.4 5 5.5.8-4 3.9.9 5.5-4.8-2.6-4.9 2.6.9-5.5-4-3.9L7.6 7Z",
} as const;
export function LibraryIcon({ name, filled = false }: { name: keyof typeof paths; filled?: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 20 20"
      aria-hidden="true"
      focusable="false"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={name === "more" ? 3 : 1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[name]} />
    </svg>
  );
}
export function LibraryButton({ children, className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={`lib-button ${className}`} {...props}>
      {children}
    </button>
  );
}
export function useLibraryWidth() {
  const [width, setWidth] = useState(() => (typeof window === "undefined" ? 1680 : window.innerWidth));
  useEffect(() => {
    const resize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  return width;
}
export function useLibraryMediaQuery(query: string, fallback: boolean) {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(query).matches
      : fallback,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      setMatches(fallback);
      return;
    }
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query, fallback]);
  return matches;
}
function focusSurfaceVisible(element: HTMLElement) {
  if (!element.isConnected || element.closest("[hidden],[inert]")) return false;
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const style = node.ownerDocument.defaultView?.getComputedStyle(node);
    if (style?.display === "none" || style?.visibility === "hidden" || style?.visibility === "collapse") return false;
  }
  return true;
}
export function useLibraryFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    if (!active || !ref.current) return;
    const element = ref.current;
    const ownerDocument = element.ownerDocument;
    // Library modal surfaces share a stacking level and render in paint order:
    // sidebar, replay details, then dialogs. Popovers own their existing trap.
    const topmost = () =>
      Array.from(ownerDocument.querySelectorAll<HTMLElement>('[aria-modal="true"]'))
        .filter(focusSurfaceVisible)
        .at(-1);
    const popoverOpen = () =>
      Array.from(ownerDocument.querySelectorAll<HTMLElement>(".lib-popover")).some(focusSurfaceVisible);
    const candidates = () =>
      Array.from(
        element.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary:not([tabindex="-1"]),[tabindex="0"]',
        ),
      ).filter((node) => !node.matches(":disabled") && focusSurfaceVisible(node));
    // A row bookmark can open its popover before selected details mount.
    // Keep the innermost surface's focus when the parent trap activates.
    if (topmost() === element && !popoverOpen()) {
      (element.querySelector<HTMLElement>("[data-initial-focus]") ?? candidates()[0])?.focus();
    }
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || event.defaultPrevented || topmost() !== element || popoverOpen()) return;
      const targets = candidates(),
        first = targets[0],
        last = targets[targets.length - 1];
      if (!first) {
        event.preventDefault();
        return;
      }
      if (event.shiftKey && (ownerDocument.activeElement === first || !element.contains(ownerDocument.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (ownerDocument.activeElement === last || !element.contains(ownerDocument.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    // Popover dismissal can restore a connected row bookmark outside the panel.
    // Its real keydown cannot bubble through the panel itself.
    ownerDocument.addEventListener("keydown", key);
    return () => ownerDocument.removeEventListener("keydown", key);
  }, [active, ref]);
}
export function LibraryPopover({
  title,
  anchor,
  onClose,
  children,
}: {
  title: string;
  anchor: HTMLElement | null;
  onClose(): void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 90, left: 24, maxHeight: 0 });
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useLayoutEffect(() => {
    const place = () => {
      const rect = anchor?.getBoundingClientRect();
      const top = Math.max(8, Math.min((rect?.bottom ?? 84) + 7, window.innerHeight - 160));
      setPosition({
        top,
        left: Math.max(16, Math.min(rect?.left ?? 24, window.innerWidth - 368)),
        maxHeight: Math.max(0, window.innerHeight - top - 8),
      });
    };
    place();
    window.addEventListener("resize", place);
    (
      ref.current?.querySelector<HTMLElement>("[data-initial-focus]") ??
      ref.current?.querySelector<HTMLElement>("input,button,select,textarea")
    )?.focus();
    return () => {
      window.removeEventListener("resize", place);
      if (anchor?.isConnected) anchor.focus();
    };
  }, [anchor, title]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node) && !anchor?.contains(event.target as Node)) closeRef.current();
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [anchor]);
  return (
    <div
      className="lib-popover"
      ref={ref}
      role="dialog"
      aria-label={title}
      style={position}
      onKeyDown={(e) => {
        if (e.key === "Tab" && document.querySelector('[aria-modal="true"]')) {
          const targets = Array.from(
            ref.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary:not([tabindex="-1"]),[tabindex="0"]',
            ) ?? [],
          ).filter((node) => !node.hidden);
          const first = targets[0],
            last = targets[targets.length - 1];
          if (
            first &&
            ((e.shiftKey && document.activeElement === first) || (!e.shiftKey && document.activeElement === last))
          ) {
            e.preventDefault();
            e.stopPropagation();
            (e.shiftKey ? last : first).focus();
          }
        }
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="lib-row">
        <strong className="lib-spacer">{title}</strong>
        <LibraryButton aria-label={`Close ${title}`} onClick={onClose}>
          <LibraryIcon name="close" />
        </LibraryButton>
      </div>
      {children}
    </div>
  );
}
export function LibraryDialog({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLibraryFocusTrap(ref, true);
  return (
    <>
      <button type="button" className="lib-scrim" aria-label={`Close ${title}`} tabIndex={-1} onClick={onClose} />
      <div
        ref={ref}
        className="lib-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !document.querySelector(".lib-popover")) {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="lib-row" style={{ marginBottom: 20 }}>
          <strong className="lib-spacer" style={{ fontSize: 16 }}>
            {title}
          </strong>
          <LibraryButton data-initial-focus aria-label={`Close ${title}`} onClick={onClose}>
            <LibraryIcon name="close" />
          </LibraryButton>
        </div>
        {children}
      </div>
    </>
  );
}
