import { Box } from "@mui/material";
import { type KeyboardEvent, useState } from "react";
import { parseTimeEntry } from "../../services/analysis/incident-summary";
import { REWIND_COLORS, REWIND_FONTS } from "../../styles/tokens";

/** Nothing typed here is a playback shortcut. */
const stopKey = (event: KeyboardEvent) => event.stopPropagation();

/**
 * A small time field: Enter inspects the incident nearest the typed time (`m:ss`, `m:ss.mmm` or seconds, in
 * displayed playback time). Typing never seeks; an entry that cannot be read is flagged until it is edited.
 */
export function GoToTime({ onGo }: { onGo(displayedMs: number): boolean }) {
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState(false);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      setValue("");
      setInvalid(false);
      event.currentTarget.blur();
    } else if (event.key === "Enter") {
      if (!value.trim()) return;
      const displayedMs = parseTimeEntry(value);
      if (displayedMs === undefined || !onGo(displayedMs)) {
        setInvalid(true);
        return;
      }
      setValue("");
      // Back to the viewer: Space plays again.
      event.currentTarget.blur();
    }
  };
  return (
    <Box
      component="input"
      type="text"
      aria-label="Go to time"
      aria-invalid={invalid ? "true" : undefined}
      title="Jump to the incident nearest this time (m:ss)"
      placeholder="Go to 0:00"
      autoComplete="off"
      spellCheck={false}
      value={value}
      onChange={(event) => {
        setValue(event.target.value);
        setInvalid(false);
      }}
      onKeyDown={onKeyDown}
      onKeyUp={stopKey}
      sx={{
        flex: "none",
        width: 96,
        height: 24,
        boxSizing: "border-box",
        px: "7px",
        border: 0,
        borderRadius: "4px",
        outline: "none",
        fontFamily: REWIND_FONTS.mono,
        fontSize: 12,
        color: REWIND_COLORS.textPrimary,
        backgroundColor: REWIND_COLORS.inset,
        boxShadow: `inset 0 0 0 1px ${invalid ? REWIND_COLORS.judgementMiss : "rgba(255,255,255,0.08)"}`,
        "&::placeholder": { color: REWIND_COLORS.textDim, opacity: 1 },
        "&:focus-visible": { boxShadow: `inset 0 0 0 1px ${invalid ? REWIND_COLORS.judgementMiss : REWIND_COLORS.focus}` },
      }}
    />
  );
}
