import { Box, Button, IconButton, Popover, Tooltip, useMediaQuery, useTheme } from "@mui/material";
import { SettingsOutlined } from "@mui/icons-material";
import { useCallback, useState, type ReactNode } from "react";
import { BaseAudioSettingsPanel } from "./BaseAudioSettingsPanel";
import { useAudioSettings, useAudioSettingsService } from "../../hooks/audio";
import { useModControls } from "../../hooks/mods";
import { useInspector } from "../../providers/InspectorProvider";
import { preventPointerFocus } from "../../utils/focus";
import { FULL_MAP_MOD_ICONS } from "../../../assets/full-map-mod-icons";
import { REWIND_COLORS } from "../../styles/tokens";
import { AudioIcon, AudioMutedIcon } from "./icons";

export const centerUp = {
  anchorOrigin: {
    vertical: "top" as const,
    horizontal: "center" as const,
  },
  transformOrigin: {
    vertical: "bottom" as const,
    horizontal: "center" as const,
  },
};

/** Shared 28 px icon-button look for the transport row (matches the step, speed and text buttons). */
export const dockIconButton = {
  width: 28,
  height: 28,
  p: 0,
  borderRadius: "6px",
  color: REWIND_COLORS.textBright,
  "&:hover": { color: REWIND_COLORS.white, backgroundColor: "rgba(255,255,255,0.07)" },
  "&.Mui-disabled": { color: REWIND_COLORS.textQuaternary },
} as const;

/**
 * The dock's text actions (Analysis, Settings): a 16 px Material icon, 6 px before the label.
 * The icon is quieter than the label until hover; a disabled button greys both alike.
 */
export const dockTextButton = {
  minHeight: 28,
  height: 28,
  minWidth: 0,
  px: "8px",
  borderRadius: "6px",
  fontSize: 13,
  fontWeight: 400,
  color: REWIND_COLORS.textBright,
  "&:hover": { color: REWIND_COLORS.white, backgroundColor: "rgba(255,255,255,0.07)" },
  "&.Mui-disabled": { color: REWIND_COLORS.textQuaternary },
  // Without the label (narrow window) the icon needs no gap after it.
  "& .MuiButton-startIcon": {
    m: 0,
    mr: { xs: 0, md: "6px" },
    color: REWIND_COLORS.textSecondary,
    "& svg": { fontSize: 16 },
  },
  "&:hover .MuiButton-startIcon": { color: REWIND_COLORS.white },
  "&.Mui-disabled .MuiButton-startIcon": { color: "inherit" },
};

/** True below the `md` breakpoint, where `DockButtonLabel` is hidden and only the icon remains. */
export function useDockLabelsHidden(): boolean {
  return useMediaQuery(useTheme().breakpoints.down("md"));
}

/** The label of a dock text button: hidden below the `md` breakpoint, where only the icon (and its title) remains. */
export function DockButtonLabel({ children }: { children: ReactNode }) {
  return <Box component="span" sx={{ display: { xs: "none", md: "inline" } }}>{children}</Box>;
}

/** The open mode's button (Settings): a quiet filled state, never a box around a box. */
export const dockActiveButton = {
  color: REWIND_COLORS.textPrimary,
  backgroundColor: "rgba(255,255,255,0.12)",
  boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.14)",
  // Keep the filled state on hover; only the text brightens.
  "&:hover": { color: "#fff", backgroundColor: "rgba(255,255,255,0.12)" },
} as const;

export function AudioButton() {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const { volume, muted } = useAudioSettings();
  const service = useAudioSettingsService();

  return (
    <>
      <Tooltip title={muted ? "Audio muted" : "Audio settings"}>
        <IconButton
          size="small"
          aria-label="Audio settings"
          onClick={(event) => setAnchorEl(event.currentTarget)}
          sx={dockIconButton}
        >
          {muted ? <AudioMutedIcon /> : <AudioIcon />}
        </IconButton>
      </Tooltip>
      <Popover open={Boolean(anchorEl)} anchorEl={anchorEl} onClose={() => setAnchorEl(null)} {...centerUp}>
        <Box width={280}>
          <BaseAudioSettingsPanel
            muted={muted}
            master={volume.master}
            music={volume.music}
            effects={volume.effects}
            onMutedChange={(value) => service.setMuted(value)}
            onMasterChange={(value) => service.setMasterVolume(value)}
            onMusicChange={(value) => service.setMusicVolume(value)}
            onEffectsChange={(value) => service.setEffectsVolume(value)}
          />
        </Box>
      </Popover>
    </>
  );
}

export function HiddenButton() {
  const { setHidden, hidden } = useModControls();
  const handleClick = useCallback(() => setHidden(!hidden), [hidden, setHidden]);

  return (
    <Tooltip title={hidden ? "Hidden on (F)" : "Hidden off (F)"}>
      <IconButton
        size="small"
        aria-label="Toggle Hidden visualization"
        aria-pressed={hidden}
        onMouseDown={preventPointerFocus}
        onClick={handleClick}
        // The mod icon is wider than it is tall: a wider button (same 28 px row height) keeps it uncropped.
        sx={{ ...dockIconButton, width: 36 }}
      >
        <Box
          component="img"
          src={FULL_MAP_MOD_ICONS.HIDDEN}
          alt=""
          aria-hidden="true"
          sx={{
            width: 30,
            height: "auto",
            display: "block",
            opacity: hidden ? 1 : 0.7,
            filter: hidden ? "none" : "grayscale(0.6) brightness(0.95)",
          }}
        />
      </IconButton>
    </Tooltip>
  );
}

/** Settings: shows Settings in the inspector, or returns to the incidents. It is off while a clip is exporting. */
export function SettingsButton() {
  const { mode, locked, toggleSettings } = useInspector();
  const open = mode === "settings";
  const labelHidden = useDockLabelsHidden();
  return (
    <Button
      size="small"
      aria-label="Settings"
      // The label is its own explanation; with only the icon showing, the title is.
      title={labelHidden ? "Settings" : undefined}
      startIcon={<SettingsOutlined />}
      disabled={locked}
      onClick={toggleSettings}
      onMouseDown={preventPointerFocus}
      aria-pressed={open}
      sx={{ ...dockTextButton, ...(open ? dockActiveButton : {}) }}
    >
      <DockButtonLabel>Settings</DockButtonLabel>
    </Button>
  );
}
