import type { ReactNode, SVGProps } from "react";

/**
 * Dock and header glyphs copied from the 3a mock card (docs/design/rewind-3a/mockups/Rewind.dc.html, "3a" card).
 * They paint with `currentColor`, so the buttons' own colour, hover and disabled states keep working, and they are
 * decorative (`aria-hidden`): the button carries the accessible name. `size` is the rendered height in px; the width
 * follows the mock's aspect. Without it the glyph has the mock's own size.
 */
interface IconProps extends Omit<SVGProps<SVGSVGElement>, "width" | "height" | "viewBox" | "children"> {
  size?: number;
}

function Glyph({
  box,
  size,
  children,
  ...rest
}: IconProps & { box: readonly [number, number]; children: ReactNode }) {
  const [boxWidth, boxHeight] = box;
  const height = size ?? boxHeight;
  return (
    <svg
      {...rest}
      width={(height * boxWidth) / boxHeight}
      height={height}
      viewBox={`0 0 ${boxWidth} ${boxHeight}`}
      aria-hidden="true"
      focusable="false"
      style={{ display: "block", flex: "none", ...rest.style }}
    >
      {children}
    </svg>
  );
}

const PLAY_BOX = [10, 11] as const;
const AUDIO_BOX = [16, 14] as const;
const MORE_BOX = [4, 14] as const;
const FOLDER_BOX = [14, 12] as const;

export function PlayIcon(props: IconProps) {
  return (
    <Glyph box={PLAY_BOX} {...props}>
      <polygon points="1.5,0.5 9.5,5.5 1.5,10.5" fill="currentColor" />
    </Glyph>
  );
}

/** Two 3 × 10 bars in the play glyph's 10 × 11 box. */
export function PauseIcon(props: IconProps) {
  return (
    <Glyph box={PLAY_BOX} {...props}>
      <rect x="1.5" y="0.5" width="3" height="10" fill="currentColor" />
      <rect x="5.5" y="0.5" width="3" height="10" fill="currentColor" />
    </Glyph>
  );
}

const SPEAKER = "1,5 4,5 8,1.5 8,12.5 4,9 1,9";

export function AudioIcon(props: IconProps) {
  return (
    <Glyph box={AUDIO_BOX} {...props}>
      <polygon points={SPEAKER} fill="currentColor" />
      <path
        d="M10.5 4.5 Q12.5 7 10.5 9.5 M12.5 2.5 Q16 7 12.5 11.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </Glyph>
  );
}

/** The same speaker with a small × (about 6 px wide) where the arcs were. */
export function AudioMutedIcon(props: IconProps) {
  return (
    <Glyph box={AUDIO_BOX} {...props}>
      <polygon points={SPEAKER} fill="currentColor" />
      <path
        d="M10 4.2 L15.6 9.8 M15.6 4.2 L10 9.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </Glyph>
  );
}

export function MoreIcon(props: IconProps) {
  return (
    <Glyph box={MORE_BOX} {...props}>
      <circle cx="2" cy="2" r="1.5" fill="currentColor" />
      <circle cx="2" cy="7" r="1.5" fill="currentColor" />
      <circle cx="2" cy="12" r="1.5" fill="currentColor" />
    </Glyph>
  );
}

export function FolderIcon(props: IconProps) {
  return (
    <Glyph box={FOLDER_BOX} {...props}>
      <rect x="1" y="1" width="5" height="3" rx="0.8" fill="currentColor" />
      <rect x="1" y="3" width="12" height="8" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </Glyph>
  );
}
