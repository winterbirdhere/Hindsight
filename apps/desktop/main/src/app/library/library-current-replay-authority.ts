import { randomUUID } from "crypto";
import { isDeepStrictEqual } from "util";
import { LIBRARY_NUMERIC_PROJECTION_VERSION } from "../../../../shared/library-analysis";
import type { LibraryNumericalBinding, LibraryNumericalResourceDescriptor } from "../../../../shared/library-analysis";
import type { LibraryMetricTarget } from "../../../../shared/replay-library-metrics";
import type { LibraryLocationTicket, LibraryMapTicket } from "./library-store";
import { validateNumericalRecipe } from "./library-numerical-profile";

/** Backend only. The renderer receives the separately issued token, never this store lease. */
export interface LibraryCurrentReplayAuthority {
  version: 1;
  leaseId: string;
  replayId: string;
  numericalTarget: LibraryMetricTarget;
  binding: LibraryNumericalBinding;
  sourceLease: { location: LibraryLocationTicket; map?: LibraryMapTicket };
}
export type LibraryCurrentReplayBindingResult = { state: "applied"; replayId: string; authority: LibraryCurrentReplayAuthority }
  | { state: "stale" | "source-disabled" };
export interface LibraryCurrentReplayAuthorityEntry {
  authority: LibraryCurrentReplayAuthority;
  descriptor: LibraryNumericalResourceDescriptor;
  ruleset: "stable" | "lazer";
}
const hash = (value: unknown, length = 64): value is string => typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value);

/** Copy only consumed numerical inputs; optional C corroboration is deliberately not retained. */
export function currentReplayDescriptor(value: LibraryNumericalResourceDescriptor): LibraryNumericalResourceDescriptor {
  if (!value || !value.input || !value.input.binding || !value.target) throw new Error("Invalid current replay descriptor");
  validateNumericalRecipe(value.recipe);
  const { input, target, origin, recipe } = value, binding = input.binding;
  if (input.format !== "resources" || !Number.isSafeInteger(input.replayBytes) || input.replayBytes < 1 || input.replayBytes > 64 * 1024 * 1024 ||
    !Number.isSafeInteger(input.mapBytes) || input.mapBytes < 1 || input.mapBytes > 16 * 1024 * 1024 ||
    !hash(binding.replaySha256) || !hash(binding.mapSha256) || !hash(binding.mapMd5, 32) || typeof binding.exactMapAndProfile !== "boolean" ||
    recipe.replaySha256 !== binding.replaySha256 || target.slot !== "numerical" || target.stage !== "S" || !hash(target.inputKey) ||
    target.producerVersion !== LIBRARY_NUMERIC_PROJECTION_VERSION || origin !== null && (!origin || !["stable", "lazer"].includes(origin.client) || origin.provenance !== "user-confirmed"))
    throw new Error("Invalid current replay descriptor");
  return { input: { format: "resources", replayBytes: input.replayBytes, mapBytes: input.mapBytes,
    binding: { replaySha256: binding.replaySha256, mapSha256: binding.mapSha256, mapMd5: binding.mapMd5, exactMapAndProfile: binding.exactMapAndProfile } },
    target: { slot: "numerical", stage: "S", inputKey: target.inputKey, producerVersion: target.producerVersion },
    origin: origin ? { client: origin.client, provenance: "user-confirmed" } : null, recipe: { ...recipe } };
}

/** Ephemeral capabilities do not survive a utility restart. Cached values do. */
export class LibraryCurrentReplayAuthorities {
  private readonly entries = new Map<string, LibraryCurrentReplayAuthorityEntry & { touched: number }>();
  private expire(): void { const now = Date.now(); for (const [id, entry] of this.entries) if (now - entry.touched > 30 * 60 * 1000) this.entries.delete(id); }
  issue(value: Omit<LibraryCurrentReplayAuthorityEntry, "authority"> & { authority: Omit<LibraryCurrentReplayAuthority, "leaseId"> }): LibraryCurrentReplayAuthority {
    this.expire();
    // Bounded eviction revokes old observation rights; it never removes durable metrics.
    if (this.entries.size >= 32) this.entries.delete(this.entries.keys().next().value as string);
    const authority = { ...value.authority, leaseId: randomUUID() };
    const entry = JSON.parse(JSON.stringify({ ...value, authority })) as LibraryCurrentReplayAuthorityEntry;
    this.entries.set(authority.leaseId, { ...entry, touched: Date.now() });
    return authority;
  }
  get(authority: LibraryCurrentReplayAuthority): LibraryCurrentReplayAuthorityEntry | undefined {
    this.expire(); if (!authority || typeof authority.leaseId !== "string") return undefined;
    const entry = this.entries.get(authority.leaseId); if (!entry) return undefined;
    if (!isDeepStrictEqual(authority, entry.authority)) return undefined;
    entry.touched = Date.now(); return entry;
  }
  release(authority: LibraryCurrentReplayAuthority): void { if (this.get(authority)) this.entries.delete(authority.leaseId); }
  clear(): void { this.entries.clear(); }
}
