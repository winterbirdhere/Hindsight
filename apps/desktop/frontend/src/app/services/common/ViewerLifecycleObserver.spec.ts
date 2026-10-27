import { Container, inject, injectable, optional } from "inversify";
import { NOOP_VIEWER_LIFECYCLE, VIEWER_LIFECYCLE_OBSERVER, ViewerLifecycleObserver } from "./ViewerLifecycleObserver";
import { createViewerLifecycleObserver } from "./ViewerLifecycleObserverFactory";

it("keeps ordinary construction inert without inspecting supplied objects or fields", () => {
  const value = new Proxy({}, { get() { throw new Error("Must not inspect objects"); }, ownKeys() { throw new Error("Must not enumerate fields"); } });
  const observer = createViewerLifecycleObserver();
  expect(observer).toBe(NOOP_VIEWER_LIFECYCLE);
  expect(observer.enabled).toBe(false);
  expect(observer.id(value)).toBe(0);
  expect(() => { observer.record("unused", value, value); observer.count("unused", value); }).not.toThrow();
});

it("contains sink exceptions and marks evidence invalid without interrupting an owner", () => {
  const invalid: string[] = [];
  const observer = new ViewerLifecycleObserver({
    id() { throw new Error("broken ID sink"); },
    record() { throw new Error("broken event sink"); },
    count() { throw new Error("broken counter sink"); },
    invalidate(reason) { invalid.push(reason); throw new Error("broken failure transport"); },
  });
  expect(() => { observer.record("test", {}); observer.count("test", {}); }).not.toThrow();
  expect(invalid.length).toBeGreaterThan(0);
  expect(invalid.every(reason => reason === "observer-error")).toBe(true);
});

it("inherits the explicit observer from the parent container and permits ordinary absent bindings", () => {
  @injectable()
  class Owner {
    constructor(@inject(VIEWER_LIFECYCLE_OBSERVER) @optional() readonly lifecycle: ViewerLifecycleObserver = NOOP_VIEWER_LIFECYCLE) {}
  }
  const plain = new Container(); plain.bind(Owner).toSelf();
  expect(plain.get(Owner).lifecycle.enabled).toBe(false);
  const parent = new Container(), child = new Container(); child.parent = parent;
  const supplied = new ViewerLifecycleObserver();
  parent.bind(VIEWER_LIFECYCLE_OBSERVER).toConstantValue(supplied); child.bind(Owner).toSelf();
  expect(child.get(Owner).lifecycle).toBe(supplied);
});
