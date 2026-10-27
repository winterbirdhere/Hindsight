import "reflect-metadata";
import { CommonManagers } from "./CommonManagers";

jest.mock("../analysis/createRewindAnalysisApp", () => ({ createRewindAnalysisApp: jest.fn() }));
jest.mock("../../api", () => ({ frontendAPI: {} }));
jest.mock("./local/SkinLoader", () => ({ SkinLoader: class SkinLoader {} }));

function createManagers(loadPreferredSkin: jest.Mock) {
  return new CommonManagers(
    { loadPreferredSkin } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

describe("CommonManagers initialization", () => {
  it("shares one skin load between concurrent callers and does not reload after success", async () => {
    let finishLoading!: () => void;
    const loadPreferredSkin = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finishLoading = resolve;
        }),
    );
    const managers = createManagers(loadPreferredSkin);

    const first = managers.initialize();
    const second = managers.initialize();
    expect(loadPreferredSkin).toHaveBeenCalledTimes(1);
    finishLoading();
    await Promise.all([first, second]);
    await managers.initialize();

    expect(loadPreferredSkin).toHaveBeenCalledTimes(1);
  });

  it("allows a later call to retry a failed skin load", async () => {
    const failure = new Error("Skin temporarily unavailable");
    const loadPreferredSkin = jest.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
    const managers = createManagers(loadPreferredSkin);

    const first = managers.initialize();
    const second = managers.initialize();
    await expect(first).rejects.toBe(failure);
    await expect(second).rejects.toBe(failure);
    expect(loadPreferredSkin).toHaveBeenCalledTimes(1);

    await managers.initialize();
    await managers.initialize();
    expect(loadPreferredSkin).toHaveBeenCalledTimes(2);
  });
});
