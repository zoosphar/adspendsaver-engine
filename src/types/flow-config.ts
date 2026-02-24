export type FlowAction = "click" | "select_if_exists" | "wait_for" | "type_input";

export type FlowType = "product_to_checkout" | "product_to_checkout_from_grid" | "multiple_products_to_checkout_from_grid"

/**
 * A locator descriptor that maps directly to Playwright's locator API.
 * Claude extracts these from the accessibility tree (browser_snapshot),
 * and Stage 3 converts them into Playwright Locator objects.
 */
export type LocatorDescriptor =
  | { method: "role"; role: string; name?: string; exact?: boolean }
  | { method: "text"; text: string; exact?: boolean }
  | { method: "label"; label: string; exact?: boolean }
  | { method: "css"; selector: string }
  | { method: "testId"; testId: string };

export interface FlowStep {
  action: FlowAction;
  locator: LocatorDescriptor;
  fallbackLocators?: LocatorDescriptor[];
  description: string;
  strategy?: "first_available";
  value?: string;
  timeout?: number;
  required?: boolean;
  metadata?: Record<string, unknown>;
}

export interface VariantOption {
  label: string;          // e.g. "Red", "Blue", "M", "L", "XL"
  locator: LocatorDescriptor;
  available: boolean;     // false if sold out / disabled
}

export interface VariantGroup {
  name: string;           // e.g. "Color", "Size"
  type: "color" | "size" | "other";
  options: VariantOption[];
}

export interface VariantCombination {
  label: string;          // e.g. "Red / M"
  selections: {
    groupName: string;    // e.g. "Color"
    optionLabel: string;  // e.g. "Red"
    locator: LocatorDescriptor;
  }[];
}

/**
 * A single locator check: does this element exist on the page in the current state?
 */
export interface SanityCheck {
  description: string;
  locator: LocatorDescriptor;
  fallbackLocators?: LocatorDescriptor[];
}

/**
 * A phase in the sanity check. Each phase:
 * 1. Executes transitionSteps to reach the right page state
 * 2. Verifies all checks (locator existence)
 */
export interface SanityPhase {
  name: string;                 // e.g. "pre-cart", "post-cart"
  transitionSteps: FlowStep[];  // steps to execute before checking (empty for first phase)
  checks: SanityCheck[];        // locators to verify exist
}

/**
 * Tells Stage 2 exactly how to verify the FlowConfig locators,
 * including what steps to execute to reach each page state.
 */
export interface SanityConfig {
  phases: SanityPhase[];
}

export interface FlowConfig {
  flow_type: FlowType;
  pageUrl: string;
  clientWebsite: string;
  extractedAt: string;
  pageStructure: {
    framework?: string;
    isSPA: boolean;
    notes: string[];
  };
  variants?: VariantGroup[];
  steps: FlowStep[];
  sanityConfig?: SanityConfig;
}
