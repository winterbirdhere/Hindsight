import { Box } from "@mui/material";
import { REWIND_COLORS, REWIND_FONTS } from "../../styles/tokens";

/** Offline guidance for the Stable installation layout that setup currently accepts. */
export function SetupHelp() {
  return (
    <Box
      id="setup-help"
      component="section"
      role="region"
      aria-labelledby="setup-help-title"
      sx={{
        pt: "18px",
        boxShadow: `inset 0 1px 0 ${REWIND_COLORS.hairline}`,
        color: REWIND_COLORS.textSecondary,
        fontSize: 13,
        lineHeight: 1.5,
        userSelect: "text",
        "& h2": { m: "0 0 14px", color: REWIND_COLORS.textPrimary, fontSize: 15.5, fontWeight: 600 },
        "& h3": { m: "16px 0 6px", color: REWIND_COLORS.textBright, fontSize: 13, fontWeight: 600 },
        "& p": { m: "6px 0 0" },
        "& code": { fontFamily: REWIND_FONTS.mono, fontSize: "0.95em", overflowWrap: "anywhere" },
        "& strong": { color: REWIND_COLORS.textBright, fontWeight: 500 },
      }}
    >
      <h2 id="setup-help-title">Find your osu! folder</h2>
      <h3>Usual Windows location</h3>
      <Box component="code" sx={{ display: "block", p: "8px 12px", borderRadius: "6px", bgcolor: REWIND_COLORS.inset }}>
        {"%LOCALAPPDATA%\\osu!"}
      </Box>
      <p>Paste this into File Explorer’s address bar. If the folder opens, copy its full path into the field above.</p>
      <h3>Installed somewhere else?</h3>
      <Box component="ul" sx={{ m: 0, pl: "18px", "& li + li": { mt: "6px" } }}>
        <li>
          In osu!stable, open <strong>Options</strong> and choose <strong>Open osu! folder</strong>.
        </li>
        <li>
          Or right-click your osu! shortcut, open <strong>Properties</strong>, then choose{" "}
          <strong>Open file location</strong>.
        </li>
      </Box>
      <h3>Which folder should I choose?</h3>
      <p>
        Choose the installation folder containing <code>osu!.db</code>, <code>scores.db</code> and <code>Skins</code>.
        Select the parent folder, not <code>Songs</code> or <code>Replays</code> inside it.
      </p>
      <p>
        Hindsight also checks for your beatmaps. A custom Songs location is read from your osu! settings; a Replays
        folder is optional.
      </p>
      <p>
        This setup currently needs an <strong>osu!stable installation</strong>. osu!lazer’s data folder uses a different
        layout and cannot be selected here.
      </p>
    </Box>
  );
}
