/** An internal construction dependency. Ordinary builds use the inert instance below. */
export type ViewerLifecycleScalar = string | number | boolean | null;
export type ViewerLifecycleFields = Readonly<Record<string, ViewerLifecycleScalar>>;
export interface ViewerLifecycleSink {
  id(owner: object): number;
  record(kind: string, ownerId: number, fields: ViewerLifecycleFields): void;
  count(kind: string, ownerId: number, amount: number): void;
  invalidate(reason: "observer-error"): void;
}

export const VIEWER_LIFECYCLE_OBSERVER = Symbol("ViewerLifecycleObserver");

/** Never lets a diagnostic sink change application return, exception or cleanup behavior. */
export class ViewerLifecycleObserver {
  constructor(private readonly sink?: ViewerLifecycleSink) {}

  get enabled(): boolean { return this.sink !== undefined; }

  id(owner: object | null | undefined): number {
    if (!this.sink || !owner) return 0;
    try { return this.sink.id(owner); }
    catch { this.invalidate(); return 0; }
  }

  record(kind: string, owner: object, fields: ViewerLifecycleFields = {}): void {
    if (!this.sink) return;
    try { this.sink.record(kind, this.id(owner), fields); }
    catch { this.invalidate(); }
  }

  count(kind: string, owner: object, amount = 1): void {
    if (!this.sink) return;
    try { this.sink.count(kind, this.id(owner), amount); }
    catch { this.invalidate(); }
  }

  private invalidate(): void {
    try { this.sink?.invalidate("observer-error"); }
    catch { /* A broken diagnostic transport must not interrupt the application. */ }
  }
}

export const NOOP_VIEWER_LIFECYCLE = new ViewerLifecycleObserver();
Object.freeze(NOOP_VIEWER_LIFECYCLE);
