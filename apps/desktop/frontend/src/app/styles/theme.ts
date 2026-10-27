import { createTheme } from "@mui/material";
import { REWIND_COLORS, REWIND_FONTS } from "./tokens";

export const rewindTheme = createTheme({
  palette: {
    mode: "dark",
    primary: { main: REWIND_COLORS.accent },
    secondary: { main: REWIND_COLORS.judgement300 },
    background: { default: REWIND_COLORS.bg, paper: REWIND_COLORS.surface },
    text: { primary: REWIND_COLORS.textPrimary, secondary: REWIND_COLORS.textSecondary },
    divider: REWIND_COLORS.hairline,
  },
  typography: {
    fontFamily: REWIND_FONTS.ui,
    fontSize: 14,
    button: { fontSize: "0.8125rem", fontWeight: 500, letterSpacing: 0, textTransform: "none" },
    caption: { fontSize: "0.75rem" },
  },
  shape: { borderRadius: 6 },
  components: {
    MuiButtonBase: { defaultProps: { disableRipple: true } },
    MuiTooltip: { defaultProps: { arrow: true } },
  },
});
