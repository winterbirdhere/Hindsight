import { mkdtemp, readFile, writeFile, readdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { readNativePreference, saveNativePreference } from "./library-native-preference";

it("persists and atomically replaces only the app-owned native locator", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hindsight-native-pref-"));
  expect(await readNativePreference(directory)).toBeUndefined();
  await saveNativePreference(directory, "D:\\native-one"); expect(await readNativePreference(directory)).toBe("D:\\native-one");
  await saveNativePreference(directory, "D:\\native-two"); expect(await readNativePreference(directory)).toBe("D:\\native-two");
  expect(await readdir(directory)).toEqual(["native-installation.json"]);
  const original = await readFile(join(directory, "native-installation.json"));
  await expect(saveNativePreference(directory, "relative")).rejects.toThrow();
  expect(await readFile(join(directory, "native-installation.json"))).toEqual(original);
});
it("reports corrupt preferences instead of guessing another source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hindsight-native-pref-"));
  await writeFile(join(directory, "native-installation.json"), JSON.stringify({ version: 9, directory: "D:\\native" }));
  await expect(readNativePreference(directory)).rejects.toThrow(/preference/i);
});
