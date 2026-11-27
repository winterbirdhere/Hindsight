/**
 * Structural subset used by Rewind's audio services. Keeping this as an
 * interface also lets non-browser unit tests import the services without
 * evaluating the browser-only AudioContext global through decorator metadata.
 */
export abstract class AudioContextLike {
  abstract readonly destination: AudioDestinationNode;
  abstract readonly currentTime: number;
  abstract readonly state?: AudioContextState;
  abstract readonly baseLatency?: number;
  abstract readonly outputLatency?: number;
  abstract getOutputTimestamp?(): AudioTimestamp;
  abstract createGain(): GainNode;
  abstract createMediaStreamDestination?(): MediaStreamAudioDestinationNode;
  abstract createMediaElementSource(mediaElement: HTMLMediaElement): MediaElementAudioSourceNode;
  abstract createBufferSource(): AudioBufferSourceNode;
  abstract decodeAudioData(audioData: ArrayBuffer): Promise<AudioBuffer>;
  abstract resume(): Promise<void>;
}
