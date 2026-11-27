import { frontendAPI } from "../api";
import { useAnalysisApp } from "../providers/TheaterProvider";
import { releaseActiveActivationFocus } from "../utils/focus";

export interface OpenReplayAction {
  open: () => Promise<void>;
  /** True while no osu! folder is set. */
  disabled: boolean;
  /** The shortcut shown in replay buttons and their accessibility labels. */
  shortcut: string;
}

/** The picker handler and shortcut label alone; needs no osu! folder lookup (the inspector button is told `disabled`). */
export function useOpenReplayAction(): Pick<OpenReplayAction, "open" | "shortcut"> {
  const open = async () => {
    releaseActiveActivationFocus();
    try {
      await frontendAPI.runAppMenuAction("openReplay");
    } finally {
      // The native picker can restore focus; release it so Space controls playback.
      releaseActiveActivationFocus();
    }
  };
  return { open, shortcut: "F2" };
}

/** The native open-replay picker for the stage buttons, disabled while no osu! folder is set. */
export function useOpenReplay(): OpenReplayAction {
  const { osuFolderService } = useAnalysisApp();
  const action = useOpenReplayAction();
  return { ...action, disabled: !osuFolderService.getOsuFolder() };
}
