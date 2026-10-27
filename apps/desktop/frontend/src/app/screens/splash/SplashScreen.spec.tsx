import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { SplashScreen } from "./SplashScreen";

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

describe("SplashScreen", () => {
  let root: Root | undefined;
  let container: HTMLElement;

  async function render(stepIndex: number) {
    await act(async () => {
      root?.render(<SplashScreen progress={{ stepIndex }} />);
    });
  }

  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    // Keep the logo's animation loop out of these tests.
    jest.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    jest.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = undefined;
    document.body.innerHTML = "";
    delete actEnvironment.IS_REACT_ACT_ENVIRONMENT;
    jest.restoreAllMocks();
  });

  it("shows the logo, the wordmark and the first step", async () => {
    await render(0);
    const logo = container.querySelector('[role="img"]');
    expect(logo?.getAttribute("aria-label")).toBe("Hindsight");
    expect(logo?.getAttribute("width")).toBe("220");
    expect(container.textContent).toContain("Hindsight");
    expect(container.textContent).toContain("Reading osu! folder");
    expect(container.textContent).toContain("1 / 2");
    const bar = container.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute("aria-label")).toBe("Starting Hindsight");
    expect(bar?.getAttribute("aria-valuemin")).toBe("0");
    expect(bar?.getAttribute("aria-valuemax")).toBe("2");
    expect(bar?.getAttribute("aria-valuenow")).toBe("0");
  });

  it("shows the skin step", async () => {
    await render(1);
    expect(container.textContent).toContain("Loading skin");
    expect(container.textContent).toContain("2 / 2");
    expect(container.textContent).not.toContain("Reading osu! folder");
    expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("1");
  });

  it("never shows the mock's invented steps", async () => {
    await render(0);
    expect(container.textContent).not.toContain("Starting services");
    expect(container.textContent).not.toContain("Indexing Songs");
    await render(1);
    expect(container.textContent).not.toContain("Starting services");
    expect(container.textContent).not.toContain("Indexing Songs");
  });

  it("caps the progress bar at the last step once finished", async () => {
    await render(2);
    expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("2");
  });
});
