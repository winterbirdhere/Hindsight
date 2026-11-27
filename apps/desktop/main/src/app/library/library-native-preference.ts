import { mkdir, lstat, open, rename, unlink } from "fs/promises";
import { join, win32 } from "path";
import { randomUUID } from "crypto";

const valid = (value: unknown): value is string => typeof value === "string" && value.length <= 32768 && !value.includes("\0") && win32.isAbsolute(value);
/** Built-in native installation locator only. Stable settings retain their existing owner. */
export async function readNativePreference(directory: string): Promise<string | undefined> {
  let handle;
  try {
    const file = join(directory, "native-installation.json");
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 96 * 1024) throw new Error("Invalid native installation preference");
    handle = await open(file, "r");
    const buffer = Buffer.alloc(96 * 1024 + 1); let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break; size += bytesRead;
    }
    if (size > 96 * 1024) throw new Error("Invalid native installation preference");
    const content = buffer.subarray(0, size).toString("utf8");
    const value = JSON.parse(content) as { version?: unknown; directory?: unknown };
    if (value.version !== 1 || !valid(value.directory)) throw new Error("Invalid native installation preference");
    return value.directory;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  finally { await handle?.close(); }
}
export async function saveNativePreference(directory: string, nativeDirectory: string): Promise<void> {
  if (!valid(nativeDirectory)) throw new Error("Invalid native installation preference");
  await mkdir(directory, { recursive: true });
  if ((await lstat(directory)).isSymbolicLink()) throw new Error("Library directory cannot be a link");
  const temporary = join(directory, "native-installation." + randomUUID() + ".tmp");
  let handle;
  try {
    handle = await open(temporary, "wx");
    await handle.writeFile(JSON.stringify({ version: 1, directory: nativeDirectory })); await handle.sync();
    await handle.close(); handle = undefined;
    await rename(temporary, join(directory, "native-installation.json"));
  } finally {
    await handle?.close();
    await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
  }
}
