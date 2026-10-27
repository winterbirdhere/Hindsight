import { LibraryReplayWorkerServer } from "./library-replay-worker";

const scope = globalThis as unknown as { onmessage(event: MessageEvent<unknown>): void; postMessage(value: unknown): void };
const server = new LibraryReplayWorkerServer(value => scope.postMessage(value));
scope.onmessage = event => { void server.receive(event.data); };
