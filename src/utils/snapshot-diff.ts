import { createTwoFilesPatch } from "diff";

/**
 * Compute a unified diff between two aria snapshots.
 * Shows `+` lines (new elements after ATC) and `-` lines (removed).
 */
export function computeSnapshotDiff(before: string, after: string): string {
  return createTwoFilesPatch(
    "snapshot-before.txt",
    "snapshot-after.txt",
    before,
    after,
    "initial page",
    "after ATC",
    { context: 3 }
  );
}
