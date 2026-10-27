import { inject, injectable, optional } from "inversify";
import { OsuReplay } from "../../../model/OsuReplay";
import { ipcRenderer } from "electron";
import { OsuFolderService } from "./OsuFolderService";
import { DecodedReplaySource, replayFromDecodedSource } from "../../../model/replay-from-source";

export type REPLAY_SOURCES = "OSU_API" | "FILE";

@injectable()
export class ReplayService {
  constructor(@inject(OsuFolderService) @optional() private readonly osuFolderService?: OsuFolderService) {}

  async retrieveReplay(replayId: string, source: REPLAY_SOURCES = "FILE"): Promise<OsuReplay> {
    const filePath = replayId;
    // const res = await readOsr(filePath);
    // Currently using readOsr is bugged, so we need to use it from the main process
    const folder = this.osuFolderService?.getOsuFolder();
    const res: DecodedReplaySource = folder
      ? await ipcRenderer.invoke("readOsr", filePath, folder)
      : await ipcRenderer.invoke("readOsr", filePath);
    return replayFromDecodedSource(res);
  }
}
