import { IconButton, Tooltip } from "@mui/material";
import { useOpenReplayAction } from "../../hooks/open-replay";
import { REWIND_COLORS, REWIND_FOCUS_RING } from "../../styles/tokens";
import { FolderIcon } from "./icons";

export function OpenReplayButton({ disabled }: { disabled: boolean }) {
  const { open, shortcut } = useOpenReplayAction();
  return (
    <Tooltip title={`Open replay · ${shortcut}`} placement="left">
      <span>
        <IconButton
          aria-label="Open replay"
          aria-keyshortcuts={shortcut}
          disabled={disabled}
          onClick={() => void open()}
          onKeyDown={(event) => event.stopPropagation()}
          sx={{
            flex: "none",
            width: 28,
            height: 28,
            borderRadius: "6px",
            color: REWIND_COLORS.textMuted,
            backgroundColor: REWIND_COLORS.control,
            boxShadow: REWIND_COLORS.controlEdge,
            "&:hover": { color: REWIND_COLORS.textPrimary, backgroundColor: REWIND_COLORS.controlHover },
            "&.Mui-disabled": { color: REWIND_COLORS.textQuaternary },
            "&.Mui-focusVisible": REWIND_FOCUS_RING,
          }}
        >
          <FolderIcon />
        </IconButton>
      </span>
    </Tooltip>
  );
}
