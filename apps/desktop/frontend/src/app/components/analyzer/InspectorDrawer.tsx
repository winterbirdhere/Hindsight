import { Box, ButtonBase } from "@mui/material";
import { ChevronLeft, ChevronRight } from "@mui/icons-material";
import { REWIND_COLORS, REWIND_FOCUS_RING, REWIND_LAYOUT } from "../../styles/tokens";
import { preventPointerFocus } from "../../utils/focus";
import { Inspector } from "./Inspector";
import { InspectorBoundary } from "./InspectorBoundary";

/**
 * The handle on the stage's right edge that shows and hides the inspector, in the column and in the drawer alike.
 * `offset` moves it left by the width of an open overlay that sits inside the same stage.
 */
export function InspectorToggle({ open, onToggle, offset = 0 }: { open: boolean; onToggle(): void; offset?: number }) {
  return (
    <ButtonBase
      aria-label={open ? "Hide inspector" : "Show inspector"}
      aria-expanded={open}
      onClick={onToggle}
      // A pointer press must not leave the focus here: the arrow-key playback shortcuts skip focused buttons.
      onMouseDown={preventPointerFocus}
      sx={{
        position: "absolute",
        top: "50%",
        right: offset,
        transform: "translateY(-50%)",
        width: 16,
        height: 80,
        zIndex: 6,
        borderRadius: "4px 0 0 4px",
        backgroundColor: REWIND_COLORS.handle,
        // The dimmed beatmap art is dark too; an edge and a real chevron keep the handle findable.
        boxShadow: "inset 1px 0 0 rgba(255,255,255,0.14), inset 0 1px 0 rgba(255,255,255,0.08), -4px 0 14px rgba(0,0,0,0.35)",
        color: REWIND_COLORS.textSecondary,
        "&:hover": { color: REWIND_COLORS.textPrimary, backgroundColor: REWIND_COLORS.controlActive },
        "&.Mui-focusVisible": REWIND_FOCUS_RING,
      }}
    >
      {open ? <ChevronRight sx={{ fontSize: 16 }} /> : <ChevronLeft sx={{ fontSize: 16 }} />}
    </ButtonBase>
  );
}

/** On a narrow window the inspector folds into this drawer over the stage; the handle sits above the stats overlay. */
export function InspectorDrawer({
  open,
  onToggle,
  width = REWIND_LAYOUT.inspectorWidth,
}: {
  open: boolean;
  onToggle(): void;
  /** Overlay width, already limited to the window. */
  width?: number;
}) {
  return (
    <>
      <InspectorBoundary
        active={open}
        frameSx={{ position: "absolute", top: 0, right: 0, width, zIndex: 5, boxShadow: "-16px 0 40px rgba(0,0,0,0.45)" }}
      >
        {open && (
          <Box sx={{ position: "absolute", top: 0, right: 0, bottom: 0, width, zIndex: 5, boxShadow: "-16px 0 40px rgba(0,0,0,0.45)" }}>
            <Inspector />
          </Box>
        )}
      </InspectorBoundary>
      <InspectorToggle open={open} onToggle={onToggle} offset={open ? width : 0} />
    </>
  );
}
