import { injectable } from "inversify";
import { frontendAPI } from "../../api";

@injectable()
export class ScreenshotTaker {
  async takeScreenshot(): Promise<void> {
    // The caller closes transient menus first; let React's commit reach the compositor.
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const png = await frontendAPI.captureScreenshot();
    const url = URL.createObjectURL(new Blob([png], { type: "image/png" }));
    const link = document.createElement("a");
    link.download = `Hindsight Screenshot ${new Date().toISOString().replace(/:/g, "-")}.png`;
    link.href = url;
    link.hidden = true;
    document.body.appendChild(link);
    try {
      link.click();
    } finally {
      link.remove();
      // Allow Chromium to consume the download before releasing its image bytes.
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }
}
