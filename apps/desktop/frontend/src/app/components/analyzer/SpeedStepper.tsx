import { Box, ButtonBase, Menu, MenuItem, Tooltip } from "@mui/material";
import { useState } from "react";
import { useGameClockControls } from "../../hooks/game-clock";
import { ALLOWED_SPEEDS } from "../../utils/constants";
import { preventPointerFocus } from "../../utils/focus";
import { REWIND_COLORS, REWIND_FONTS } from "../../styles/tokens";

const stepSx = {
  width: 26,
  height: 28,
  color: REWIND_COLORS.textSecondary,
  "&:hover": { color: REWIND_COLORS.textPrimary },
  "&.Mui-disabled": { color: REWIND_COLORS.textQuaternary },
};

/**
 * `subject` says whose speed the stepper sets: the viewer's (the dock, the default) or the exported clip's (the Export
 * panel; during an export session the clock's speed is the clip's). Only the names and the tooltip change with it.
 */
export function SpeedStepper({ subject = "viewer" }: { subject?: "viewer" | "clip" } = {}) {
  const { speed, setSpeed, baseRate } = useGameClockControls();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const index = ALLOWED_SPEEDS.indexOf(speed);
  const baseRateLabel = baseRate === 1 ? "Original replay rate" : `Original modded rate: ${baseRate.toFixed(2)}x`;
  return (
    <Box sx={{ display: "flex", alignItems: "center", borderRadius: "6px", boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.16)", fontFamily: REWIND_FONTS.mono, fontSize: 12.5 }}>
      <ButtonBase aria-label={`Decrease ${subject} speed`} disabled={index <= 0} onClick={() => setSpeed(ALLOWED_SPEEDS[index - 1])} onMouseDown={preventPointerFocus} sx={stepSx}>
        −
      </ButtonBase>
      <Tooltip title={`${baseRateLabel}. The selected ${subject === "clip" ? "clip speed" : "viewer multiplier"} is applied on top.`}>
        <ButtonBase
          aria-label={subject === "clip" ? `Clip speed: ${speed.toFixed(2)}×` : `Viewer playback speed: ${speed.toFixed(2)}×`}
          aria-haspopup="menu"
          onClick={(event) => setAnchor(event.currentTarget)}
          onMouseDown={preventPointerFocus}
          sx={{ px: "4px", height: 28, color: REWIND_COLORS.textPrimary, fontVariantNumeric: "tabular-nums" }}
        >
          {`${speed.toFixed(2)}×`}
        </ButtonBase>
      </Tooltip>
      <ButtonBase aria-label={`Increase ${subject} speed`} disabled={index < 0 || index >= ALLOWED_SPEEDS.length - 1} onClick={() => setSpeed(ALLOWED_SPEEDS[index + 1])} onMouseDown={preventPointerFocus} sx={stepSx}>
        +
      </ButtonBase>
      <Menu open={Boolean(anchor)} anchorEl={anchor} onClose={() => setAnchor(null)}>
        {ALLOWED_SPEEDS.map((value) => (
          <MenuItem key={value} selected={value === speed} onClick={() => { setSpeed(value); setAnchor(null); }}>
            {`${value.toFixed(2)}×`}
          </MenuItem>
        ))}
      </Menu>
    </Box>
  );
}
