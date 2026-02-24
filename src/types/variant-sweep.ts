export interface ATCButtonState {
  found: boolean;
  enabled: boolean;
  visible: boolean;
  text: string;        // raw innerText, e.g. "Add to Cart", "Sold Out", "Notify Me"
  ariaDisabled: boolean;
}

export interface VariantHealthResult {
  combinationLabel: string;          // e.g. "Red / M"
  selections: { groupName: string; optionLabel: string; }[];
  selectionSuccess: boolean;
  selectionError?: string;
  atcState: ATCButtonState | null;   // null if selection failed
  priceText?: string;
  durationMs: number;
}

export interface VariantSweepResult {
  pageUrl: string;
  totalCombinations: number;
  availableCount: number;
  unavailableCount: number;
  selectionFailureCount: number;
  abortedEarly: boolean;
  abortReason?: string;
  results: VariantHealthResult[];
  durationMs: number;
}
