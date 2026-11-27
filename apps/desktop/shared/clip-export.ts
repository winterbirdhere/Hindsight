export type ClipExportExtension = "mp4" | "webm";

export interface ClipExportVideo {
  width: 1920 | 2560 | 3840;
  height: number;
  fps: 60 | 120 | 144 | 240;
  frameCount: number;
  audio: boolean;
}

export const MAX_CLIP_FRAME_CHUNK_BYTES = 8 * 1024 * 1024;
export const MAX_CLIP_VIDEO_FRAMES = 1_000_000;

export interface ClipExportRequest {
  fileName: string;
  extension: ClipExportExtension;
  /** The folder the save dialog should open in; the main process falls back to the Videos folder if it is unusable. */
  directory?: string;
  /** Native fixed-cadence export; appendClipExport carries only the optional audio track. */
  video?: ClipExportVideo;
}

export interface ClipExportSession {
  id: string;
  path: string;
}

export interface ClipExportResult {
  path: string;
}
