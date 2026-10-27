interface NavigationEvent {
  url?: string;
  preventDefault(): void;
}

interface NavigationContents {
  on(
    event: "will-navigate" | "will-redirect" | "will-frame-navigate",
    listener: (event: NavigationEvent, url?: string) => void,
  ): unknown;
  setWindowOpenHandler(handler: (details: { url: string }) => { action: "deny" }): void;
}

/** Only ordinary credential-free web links may leave the application. */
export function externalWebURL(value: string): string | null {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Keep the privileged renderer on its own document (or its development server). */
export function isRendererNavigationAllowed(value: string, frontendURL: string): boolean {
  try {
    const target = new URL(value);
    const frontend = new URL(frontendURL);
    if (target.username || target.password) return false;
    if (frontend.protocol === "file:") {
      return target.protocol === "file:" && target.host === frontend.host && target.pathname === frontend.pathname;
    }
    return ["http:", "https:"].includes(frontend.protocol) && target.origin === frontend.origin;
  } catch {
    return false;
  }
}

export function installNavigationGuards(
  contents: NavigationContents,
  frontendURL: string,
  openExternal: (url: string) => Promise<unknown>,
): void {
  contents.setWindowOpenHandler(({ url }) => {
    const external = externalWebURL(url);
    if (external) void openExternal(external).catch(() => undefined);
    return { action: "deny" };
  });
  const guard = (event: NavigationEvent, legacyURL?: string) => {
    if (!isRendererNavigationAllowed(event.url ?? legacyURL ?? "", frontendURL)) event.preventDefault();
  };
  contents.on("will-navigate", guard);
  contents.on("will-redirect", guard);
  contents.on("will-frame-navigate", guard);
}
