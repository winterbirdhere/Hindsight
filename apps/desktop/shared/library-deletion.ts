import type { LibrarySourceKind } from "./replay-library";

/** The renderer confirms a server-owned intent. It never supplies mutation targets. */
export type LibraryDeletionRequest =
  | { method:"deletion-pending";after?:string }
  | { method:"deletion-preview";replayId:string }
  | { method:"deletion-commit"|"deletion-cancel";replayId:string;token:string }
  | { method:"deletion-status"|"deletion-recover"|"deletion-cleanup"|"deletion-continue-preview";intentId:string };
export type LibraryDeletionState="preview"|"blocked"|"cancelled"|"expired"|"committing"|"recovery-required"|"partial"|"cleanup-required"|"complete";
export type LibraryDeletionTargetState="pending"|"committing"|"committed"|"unchanged"|"conflict";
export interface LibraryDeletionPending {
  intentId:string;replayId:string;state:"committing"|"recovery-required"|"partial"|"cleanup-required";createdAt:number;committedTargets:number;totalTargets:number;
}
export interface LibraryDeletionPendingPage {items:LibraryDeletionPending[];next?:string}
export interface LibraryDeletionTarget {
  id:string;sourceId:string;sourceKind:LibrarySourceKind;
  action:"remove-stable-scores"|"quarantine-replay"|"mark-native-score-deleted";
  label:string;path:string;count?:number;retainedFiles?:string[];
  /** Exact acknowledged local GUIDs or Stable raw-record fingerprints, with multiplicity. */
  records?:{id:string;count:number}[];
}
export interface LibraryDeletionResult {
  intentId:string;replayId:string;state:LibraryDeletionState;expiresAt:number;
  /** Present only on a newly prepared, actionable preview. */
  token?:string;
  targets:(LibraryDeletionTarget&{state:LibraryDeletionTargetState;detail?:string})[];
  blockers:string[];
  onlineScoresUnchanged:true;
  sourceDeletionComplete?:true;
  /** Present only with a newly issued token for the same intent's acknowledged remaining targets. */
  continuation?:true;
}
