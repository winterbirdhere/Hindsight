import { Box, ButtonBase } from "@mui/material";
import { memo, type KeyboardEvent, useEffect, useRef } from "react";
import type { ComponentMechanism } from "../../../../../../../libs/osu/core/src/gameplay/error-analysis/ComponentMechanisms";
import type { ErrorNavigationState } from "../../hooks/error-navigation";
import type { Incident } from "../../services/analysis/incidents";
import type { ReplayError } from "../../services/analysis/replay-events";
import { REWIND_COLORS, REWIND_FONTS } from "../../styles/tokens";
import { preventPointerFocus } from "../../utils/focus";
import { ChainedGlyph } from "./ChainedGlyph";
import { presentCause } from "./error-cause-presentation";
import { chainMessage, EMPTY_CAUSES, ERROR_TYPE_COLOR, errorTypeLabel, splitErrorTime } from "./incident-format";

/** Keys pressed on a row button stay here: they are not playback shortcuts. */
const stopKey = (event: KeyboardEvent) => event.stopPropagation();

interface IncidentMembersProps {
  incident: Incident;
  errors: readonly ReplayError[];
  causes: ReadonlyMap<string, readonly ComponentMechanism[]>;
  displayMode: ErrorNavigationState["displayMode"];
  /** The inspected error index. */
  selectedIndex: number;
  /** False while Follow is on: a followed incident is shown silently. */
  announce: boolean;
  baseRate: number;
  onSelect(errorIndex: number): void;
}

/**
 * Every member of an incident (the lead included), shown on demand. Each keeps its own cause, type and time
 * and is individually selectable; selecting one keeps the incident. The list has no scroller of its own: it
 * scrolls with the incident block's fixed-height body.
 */
export const IncidentMembers = memo(function IncidentMembers({
  incident,
  errors,
  causes,
  displayMode,
  selectedIndex,
  announce,
  baseRate,
  onSelect,
}: IncidentMembersProps) {
  // A newly selected member stays in view inside the body, also when the list mounts with one selected (the
  // inspector shown again). Not for the lead, whose full entry is at the top of the body, so showing the members
  // by themselves scrolls nothing.
  const selectedRow = useRef<HTMLButtonElement | null>(null);
  const shownFor = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (shownFor.current === selectedIndex) return;
    shownFor.current = selectedIndex;
    if (selectedIndex !== incident.leadIndex) selectedRow.current?.scrollIntoView?.({ block: "nearest" });
  }, [selectedIndex, incident.leadIndex]);
  return (
    <Box
      component="ul"
      aria-label="Incident members"
      onKeyDown={stopKey}
      sx={{
        listStyle: "none",
        m: 0,
        // The rows' highlight bleeds 8 px into the body's side padding, so their text lines up with the entry.
        mx: "-8px",
        p: 0,
        flex: "none",
      }}
    >
      {incident.errorIndices.map((errorIndex) => {
        const error = errors[errorIndex];
        const presentation = presentCause(causes.get(error.id) ?? EMPTY_CAUSES, displayMode);
        const selected = errorIndex === selectedIndex;
        const isLead = errorIndex === incident.leadIndex;
        // A member locked by a proven notelock link shows no timing, like a locked follow-up entry.
        const locked = incident.links.some((link) => link.kind === "notelock" && link.to === errorIndex);
        // A chained member's cause, and so its timing, is an earlier mistake's.
        const chainNote =
          presentation?.chainStartMs !== undefined ? chainMessage(presentation.chainStartMs, presentation.chainCause, baseRate) : undefined;
        // The lead's timing is already in its full entry above.
        const timing = selected && !isLead && !locked && !chainNote ? presentation?.timing : undefined;
        // The lead is announced by its entry; a selected member is announced here.
        const status = announce && selected && !isLead && Boolean(presentation);
        const type = errorTypeLabel(error);
        return (
          <Box component="li" key={error.id}>
            <ButtonBase
              ref={selected ? selectedRow : undefined}
              aria-current={selected ? "true" : undefined}
              onClick={() => onSelect(errorIndex)}
              onMouseDown={preventPointerFocus}
              sx={{
                width: "100%",
                minHeight: 28,
                display: "flex",
                alignItems: "baseline",
                justifyContent: "flex-start",
                gap: "8px",
                px: "8px",
                py: "5px",
                borderRadius: "4px",
                textAlign: "left",
                fontSize: 13,
                lineHeight: 1.35,
                backgroundColor: selected ? "rgba(255,255,255,0.07)" : "transparent",
                "&:hover": { backgroundColor: selected ? "rgba(255,255,255,0.07)" : "rgba(255,255,255,0.05)" },
                "&.Mui-focusVisible": { outline: `2px solid ${REWIND_COLORS.focus}`, outlineOffset: -2 },
              }}
            >
              <Box component="span" sx={{ flex: 1, minWidth: 0, display: "flex", alignItems: "baseline", gap: "8px" }}>
                <Box
                  component="span"
                  role={status ? "status" : undefined}
                  aria-label={status ? "Error cause" : undefined}
                  sx={{
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontWeight: selected ? 600 : 500,
                    color: selected ? REWIND_COLORS.textPrimary : REWIND_COLORS.textMuted,
                  }}
                >
                  {chainNote && (
                    <Box component="span" data-chained sx={{ display: "inline-flex", verticalAlign: "-2px", mr: "4px" }}>
                      <ChainedGlyph size={13} label={chainNote} />
                    </Box>
                  )}
                  {presentation ? presentation.labels.join(" · ") : type}
                </Box>
                {timing && (
                  <Box component="span" sx={{ flex: "none", fontSize: 12, color: REWIND_COLORS.textSecondary }}>
                    {timing.text}
                  </Box>
                )}
              </Box>
              {presentation && (
                <Box component="span" sx={{ flex: "none", fontSize: 12, fontWeight: 600, color: ERROR_TYPE_COLOR[error.type] }}>
                  {type}
                </Box>
              )}
              <Box
                component="span"
                sx={{ flex: "none", fontFamily: REWIND_FONTS.mono, fontSize: 12, color: selected ? REWIND_COLORS.textPrimary : REWIND_COLORS.textSoft }}
              >
                {splitErrorTime(error.time / baseRate).join("")}
              </Box>
            </ButtonBase>
          </Box>
        );
      })}
    </Box>
  );
});
