import { ipcRenderer } from "electron";
import type { BeatmapLookupResult } from "../../../shared/beatmap-lookup";
import type { ClipExportRequest, ClipExportResult, ClipExportSession } from "../../../shared/clip-export";
import { LIBRARY_REQUEST_CHANNEL, LIBRARY_DEMAND_CHANNEL, LIBRARY_CHANGED_CHANNEL, LibraryRequest, LibraryChangedEvent } from "../../../shared/replay-library";
import { LIBRARY_RESOURCE_CHANNEL, LibraryResourceRequest } from "../../../shared/library-resources";
import { LIBRARY_PASSIVE_RESOURCE_CHANNEL, LibraryPassiveResourceRequest } from "../../../shared/library-passive-resources";

type Listener = (...args: any) => any;

export const frontendAPI = {
  libraryPassiveResource: (request: LibraryPassiveResourceRequest): Promise<unknown> => ipcRenderer.invoke(LIBRARY_PASSIVE_RESOURCE_CHANNEL, request),
  library: {
    request: (request: LibraryRequest): Promise<unknown> => ipcRenderer.invoke(LIBRARY_REQUEST_CHANNEL, request),
    demand: (active: boolean): Promise<void> => ipcRenderer.invoke(LIBRARY_DEMAND_CHANNEL, active),
    resource: (request: LibraryResourceRequest): Promise<unknown> => ipcRenderer.invoke(LIBRARY_RESOURCE_CHANNEL, request),
    onChanged: (listener:(event:LibraryChangedEvent)=>void):(()=>void) => {
      const receive=(_event:Electron.IpcRendererEvent,value:LibraryChangedEvent)=>listener(value);
      ipcRenderer.on(LIBRARY_CHANGED_CHANNEL,receive);
      return()=>{ipcRenderer.removeListener(LIBRARY_CHANGED_CHANNEL,receive);};
    },
  },
  beginClipExport: (request: ClipExportRequest): Promise<ClipExportSession | null> =>
    ipcRenderer.invoke("beginClipExport", request),
  appendClipExport: (id: string, sequence: number, data: ArrayBuffer): Promise<void> =>
    ipcRenderer.invoke("appendClipExport", id, sequence, data),
  appendClipExportFrame: (id: string, frameIndex: number, offset: number, data: ArrayBuffer): Promise<void> =>
    ipcRenderer.invoke("appendClipExportFrame", id, frameIndex, offset, data),
  finishClipExport: (id: string): Promise<ClipExportResult> => ipcRenderer.invoke("finishClipExport", id),
  abortClipExport: (id: string): Promise<void> => ipcRenderer.invoke("abortClipExport", id),
  openExportedClip: (path: string): Promise<void> => ipcRenderer.invoke("openExportedClip", path),
  showExportedClip: (path: string): Promise<void> => ipcRenderer.invoke("showExportedClip", path),
  captureScreenshot: (): Promise<Uint8Array> => ipcRenderer.invoke("captureScreenshot"),
  lookupBeatmap: (checksum: string): Promise<BeatmapLookupResult> => ipcRenderer.invoke("lookupBeatmap", checksum),
  getPath: (type: string) => ipcRenderer.invoke("getPath", type),
  selectDirectory: (defaultPath: string) => ipcRenderer.invoke("selectDirectory", defaultPath),
  selectFile: (defaultPath: string) => ipcRenderer.invoke("selectFile", defaultPath),
  selectReplayFile: (defaultPath: string) => ipcRenderer.invoke("selectReplayFile", defaultPath),
  reboot: () => ipcRenderer.invoke("reboot"),
  getAppVersion: () => ipcRenderer.invoke("getAppVersion"),
  getPlatform: () => ipcRenderer.invoke("getPlatform"),
  onManualReplayOpen: (listener: Listener) => ipcRenderer.on("onManualReplayOpen", (event, file) => listener(file)),
  runAppMenuAction: (action: "openReplay") => ipcRenderer.invoke("runAppMenuAction", action),
};
