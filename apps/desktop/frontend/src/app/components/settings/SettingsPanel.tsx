import { Box, ButtonBase } from "@mui/material";
import { KeyboardEvent, useId, useRef } from "react";
import { SettingsTab, useInspector } from "../../providers/InspectorProvider";
import { preventPointerFocus } from "../../utils/focus";
import { thinScrollbar } from "../../styles/scrollbar";
import { REWIND_COLORS, REWIND_FOCUS_RING, REWIND_FONTS } from "../../styles/tokens";
import { DisplayTab } from "./DisplayTab";
import { GeneralTab } from "./GeneralTab";
import { PlaybackTab } from "./PlaybackTab";
import { SkinTab } from "./SkinTab";

const TABS: ReadonlyArray<{ value: SettingsTab; label: string }> = [
  { value: "playback", label: "Playback" },
  { value: "display", label: "Display" },
  { value: "skin", label: "Skin" },
  { value: "general", label: "General" },
];

function CloseGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false" style={{ display: "block" }}>
      <path
        d="M1.5 1.5 L8.5 8.5 M8.5 1.5 L1.5 8.5"
        style={{ fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" }}
      />
    </svg>
  );
}

function TabContent({ tab }: { tab: SettingsTab }) {
  switch (tab) {
    case "playback":
      return <PlaybackTab />;
    case "display":
      return <DisplayTab />;
    case "skin":
      return <SkinTab />;
    case "general":
      return <GeneralTab />;
  }
}

/** Below this panel width (the inspector is 240 to 440 px, 260 by default) the tab strip and header tighten up. */
const NARROW = "@container (max-width: 299px)";

/**
 * The settings mode of the inspector: a header, four tabs and the selected tab's content. It reads which tab is
 * open from `useInspector()` and fills the height its parent gives it; the content scrolls vertically, never the
 * frame and never sideways. The panel is a size container: below 300 px the tab gap and the side padding shrink so
 * all four tabs stay on one row, and `Changes apply live` is hidden; from 300 px it stays on one line.
 */
export function SettingsPanel() {
  const { settingsTab, setSettingsTab, closeSettings, locked } = useInspector();
  const baseId = useId();
  const tabRefs = useRef(new Map<SettingsTab, HTMLElement>());
  const tabId = (tab: SettingsTab) => `${baseId}-tab-${tab}`;
  const panelId = `${baseId}-panel`;

  const onTabKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const index = TABS.findIndex((tab) => tab.value === settingsTab);
    let next: number;
    switch (event.key) {
      case "ArrowRight":
        next = (index + 1) % TABS.length;
        break;
      case "ArrowLeft":
        next = (index - 1 + TABS.length) % TABS.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = TABS.length - 1;
        break;
      default:
        return;
    }
    // The arrows move between tabs here; they must not also seek the replay.
    event.preventDefault();
    event.stopPropagation();
    const target = TABS[next].value;
    setSettingsTab(target);
    tabRefs.current.get(target)?.focus();
  };

  return (
    <Box
      component="section"
      aria-label="Settings"
      sx={{
        height: "100%",
        minHeight: 0,
        containerType: "inline-size",
        display: "flex",
        flexDirection: "column",
        backgroundColor: REWIND_COLORS.surface,
        color: REWIND_COLORS.textBright,
        fontFamily: REWIND_FONTS.ui,
      }}
    >
      <Box sx={{ height: 52, flex: "none", display: "flex", alignItems: "center", gap: "10px", p: "0 12px 0 20px" }}>
        <Box
          component="h2"
          sx={{
            flex: 1,
            m: 0,
            whiteSpace: "nowrap",
            fontFamily: REWIND_FONTS.ui,
            fontWeight: 600,
            fontSize: 15.5,
            color: REWIND_COLORS.textPrimary,
          }}
        >
          Settings
        </Box>
        <Box
          component="span"
          sx={{
            fontFamily: REWIND_FONTS.mono,
            fontSize: 11.5,
            textAlign: "right",
            whiteSpace: "nowrap",
            color: REWIND_COLORS.textTertiary,
            [NARROW]: { display: "none" },
          }}
        >
          Changes apply live
        </Box>
        <ButtonBase
          aria-label="Close settings"
          title="Close (Esc)"
          disabled={locked}
          onClick={closeSettings}
          onMouseDown={preventPointerFocus}
          sx={{
            flex: "none",
            width: 28,
            height: 28,
            borderRadius: "6px",
            color: REWIND_COLORS.textBright,
            "&:hover": { color: REWIND_COLORS.white, backgroundColor: "rgba(255,255,255,0.08)" },
            "&.Mui-disabled": { color: REWIND_COLORS.textQuaternary },
            "&.Mui-focusVisible": REWIND_FOCUS_RING,
          }}
        >
          <CloseGlyph />
        </ButtonBase>
      </Box>
      <Box
        role="tablist"
        aria-label="Settings categories"
        sx={{
          flex: "none",
          display: "flex",
          gap: "18px",
          p: "0 20px",
          boxShadow: `inset 0 -1px 0 ${REWIND_COLORS.hairline}`,
          [NARROW]: { gap: "8px", p: "0 12px", justifyContent: "space-between" },
        }}
      >
        {TABS.map(({ value, label }) => {
          const selected = value === settingsTab;
          return (
            <ButtonBase
              key={value}
              ref={(element: HTMLElement | null) => {
                if (element) tabRefs.current.set(value, element);
                else tabRefs.current.delete(value);
              }}
              role="tab"
              id={tabId(value)}
              aria-selected={selected}
              aria-controls={panelId}
              tabIndex={selected ? 0 : -1}
              onClick={() => setSettingsTab(value)}
              onMouseDown={preventPointerFocus}
              onKeyDown={onTabKeyDown}
              sx={{
                height: 38,
                flex: "none",
                whiteSpace: "nowrap",
                fontFamily: REWIND_FONTS.ui,
                fontSize: 13,
                fontWeight: selected ? 600 : 500,
                color: selected ? REWIND_COLORS.textPrimary : REWIND_COLORS.textSoft,
                boxShadow: `inset 0 -2px 0 ${selected ? REWIND_COLORS.textPrimary : "transparent"}`,
                "&:hover": { color: REWIND_COLORS.textPrimary },
                // Inset: the underline sits on the tab's bottom edge, so an outside ring would clip under the hairline.
                "&.Mui-focusVisible": { ...REWIND_FOCUS_RING, outlineOffset: -2 },
              }}
            >
              {label}
            </ButtonBase>
          );
        })}
      </Box>
      <Box
        role="tabpanel"
        id={panelId}
        aria-labelledby={tabId(settingsTab)}
        sx={{ flex: 1, minHeight: 0, overflow: "auto", display: "flex", flexDirection: "column", ...thinScrollbar }}
      >
        <TabContent tab={settingsTab} />
      </Box>
    </Box>
  );
}
