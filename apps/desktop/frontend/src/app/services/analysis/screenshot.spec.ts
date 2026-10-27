import { frontendAPI } from "../../api";
import { ScreenshotTaker } from "./screenshot";

jest.mock("../../api", () => ({ frontendAPI: { captureScreenshot: jest.fn() } }));

describe("composited screenshot download", () => {
  let frames: FrameRequestCallback[];
  let clicked: { filename: string; href: string; attached: boolean }[];
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    frames = [];
    clicked = [];
    jest.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => frames.push(callback));
    URL.createObjectURL = jest.fn(() => "blob:screenshot");
    URL.revokeObjectURL = jest.fn();
    jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ filename: this.download, href: this.href, attached: this.isConnected });
    });
    (frontendAPI.captureScreenshot as jest.Mock).mockResolvedValue(new Uint8Array([137, 80, 78, 71]));
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.restoreAllMocks();
    jest.useRealTimers();
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  });

  function paint() {
    frames.shift()!(0);
  }

  it("waits for the next paint, downloads a safe PNG filename, then releases the image URL", async () => {
    const capture = new ScreenshotTaker().takeScreenshot();
    expect(frontendAPI.captureScreenshot).not.toHaveBeenCalled();
    paint();
    await Promise.resolve();
    expect(frontendAPI.captureScreenshot).not.toHaveBeenCalled();
    paint();
    await capture;

    expect(frontendAPI.captureScreenshot).toHaveBeenCalledTimes(1);
    expect(clicked).toEqual([
      {
        filename: expect.stringMatching(/^Hindsight Screenshot [^<>:"/\\|?*]+\.png$/),
        href: "blob:screenshot",
        attached: true,
      },
    ]);
    const blob = (URL.createObjectURL as jest.Mock).mock.calls[0][0] as Blob;
    expect(blob.type).toBe("image/png");
    expect(blob.size).toBe(4);
    expect(document.querySelector("a[download]")).toBeNull();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    jest.runOnlyPendingTimers();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:screenshot");
  });

  it("propagates capture failures without creating a download", async () => {
    (frontendAPI.captureScreenshot as jest.Mock).mockRejectedValue(new Error("Capture failed"));
    const capture = new ScreenshotTaker().takeScreenshot();
    const failure = expect(capture).rejects.toThrow("Capture failed");
    paint();
    paint();
    await failure;
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(clicked).toHaveLength(0);
  });

  it("still releases the object URL and anchor if initiating the download fails", async () => {
    (HTMLAnchorElement.prototype.click as jest.Mock).mockImplementation(() => {
      throw new Error("Download failed");
    });
    const capture = new ScreenshotTaker().takeScreenshot();
    const failure = expect(capture).rejects.toThrow("Download failed");
    paint();
    paint();
    await failure;
    expect(document.querySelector("a[download]")).toBeNull();
    jest.runOnlyPendingTimers();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:screenshot");
  });
});
