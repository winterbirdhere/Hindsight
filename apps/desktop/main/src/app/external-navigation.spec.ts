import { externalWebURL, isRendererNavigationAllowed, installNavigationGuards } from "./external-navigation";

describe("external links", () => {
  it.each(["https://osu.ppy.sh/beatmapsets/1#osu/2", "http://example.org/path?q=a"])("accepts web link %s", (url) =>
    expect(externalWebURL(url)).toBe(url),
  );
  it.each([
    "file:///C:/secret",
    "javascript:alert(1)",
    "data:text/html,a",
    "osu://123",
    "https://user:pass@example.org",
    "//example.org",
    "https://",
    "not a url",
  ])("rejects %s", (url) => expect(externalWebURL(url)).toBeNull());
});

describe("renderer document boundary", () => {
  const production = "file:///D:/Hindsight/frontend/index.html";
  it.each([production, production + "#/library", production + "?reload=1#viewer"])(
    "allows the current local document %s",
    (url) => expect(isRendererNavigationAllowed(url, production)).toBe(true),
  );
  it.each([
    "file:///D:/Hindsight/frontend/other.html",
    "file:///D:/Hindsight/frontend/index.html/other",
    "file://server/Hindsight/frontend/index.html",
    "https://osu.ppy.sh/",
    "javascript:void(0)",
  ])("rejects another document %s", (url) => expect(isRendererNavigationAllowed(url, production)).toBe(false));
  it.each(["http://localhost:4200/", "http://localhost:4200/library#recent"])(
    "preserves development navigation %s",
    (url) => expect(isRendererNavigationAllowed(url, "http://localhost:4200")).toBe(true),
  );
  it.each([
    "http://localhost:4201/",
    "http://localhost:4200.evil.test/",
    "https://localhost:4200/",
    "http://user@localhost:4200/",
  ])("rejects a different development authority %s", (url) =>
    expect(isRendererNavigationAllowed(url, "http://localhost:4200")).toBe(false),
  );
  it("denies popups and guards frame/redirect navigations without launching a browser for unsafe input", async () => {
    type Listener = (event: { url?: string; preventDefault(): void }, url?: string) => void;
    const listeners = new Map<string, Listener>();
    let popup: (details: { url: string }) => { action: string } = () => ({ action: "unset" });
    const contents = {
      on: (name: string, handler: Listener) => {
        listeners.set(name, handler);
      },
      setWindowOpenHandler: (handler: typeof popup) => {
        popup = handler;
      },
    };
    const open = jest.fn().mockResolvedValue(undefined);
    installNavigationGuards(contents, production, open);
    expect(popup({ url: "javascript:alert(1)" })).toEqual({ action: "deny" });
    expect(open).not.toHaveBeenCalled();
    expect(popup({ url: "https://osu.ppy.sh/" })).toEqual({ action: "deny" });
    expect(open).toHaveBeenCalledWith("https://osu.ppy.sh/");
    for (const name of ["will-navigate", "will-redirect", "will-frame-navigate"]) {
      const preventDefault = jest.fn();
      listeners.get(name)?.({ url: "https://example.org", preventDefault }, "https://example.org");
      expect(preventDefault).toHaveBeenCalledTimes(1);
      const allowed = jest.fn();
      listeners.get(name)?.({ url: production + "#viewer", preventDefault: allowed }, production + "#viewer");
      expect(allowed).not.toHaveBeenCalled();
    }
    open.mockRejectedValueOnce(new Error("No browser"));
    popup({ url: "https://osu.ppy.sh/" });
    await Promise.resolve();
  });
});
