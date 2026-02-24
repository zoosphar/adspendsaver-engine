import { chromium, type Page } from "playwright";
import type {
  FlowConfig,
  FlowStep,
  PipelineInput,
  StageResult,
  VariantGroup,
  VariantCombination,
} from "../types/index.js";
import type {
  ATCButtonState,
  VariantHealthResult,
  VariantSweepResult,
} from "../types/variant-sweep.js";
import { toLocator, resolveLocator, locatorToString } from "../engine/actions.js";
import * as actions from "../engine/actions.js";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

/** Regex patterns that identify an ATC button */
const ATC_PATTERNS = [
  /add\s*to\s*cart/i,
  /add\s*to\s*bag/i,
  /buy\s*now/i,
  /add\s*to\s*basket/i,
];

/** DOM settle time after clicking a variant option */
const SETTLE_MS = 500;

/**
 * Short click timeout for the sweep. The default ACTION_TIMEOUT (10s) is too
 * long because Playwright retries intercepted clicks for the full duration.
 * With 352 combos × 2 intercepted clicks × 10s = ~2 hours.
 * At 2s: 352 × 2 × 2s = ~23 minutes — much more reasonable.
 */
const SWEEP_CLICK_TIMEOUT = 2000;

/** Max consecutive selection failures before aborting */
const MAX_CONSECUTIVE_SELECTION_FAILURES = 10;


/**
 * Search config.steps for a click action whose description or locator
 * matches common ATC button patterns.
 */
export function findATCStep(steps: FlowStep[]): FlowStep | null {
  for (const step of steps) {
    if (step.action !== "click") continue;

    // Check description
    if (ATC_PATTERNS.some((p) => p.test(step.description))) {
      return step;
    }

    // Check locator name (role-based locators often have a name matching ATC text)
    const loc = step.locator;
    if (loc.method === "role" && loc.name) {
      const name = loc.name;
      if (ATC_PATTERNS.some((p) => p.test(name))) return step;
    }
    if (loc.method === "text" && ATC_PATTERNS.some((p) => p.test(loc.text))) {
      return step;
    }
  }
  return null;
}

/**
 * Cartesian product of ALL variant options (ignoring `available` flag).
 * Stage 3B discovers actual availability rather than trusting Stage 1's guess.
 */
export function generateAllCombinations(variants: VariantGroup[]): VariantCombination[] {
  const groups = variants.filter((g) => g.options.length > 0);
  if (groups.length === 0) return [];

  let combos: VariantCombination[] = [{ label: "", selections: [] }];

  for (const group of groups) {
    const newCombos: VariantCombination[] = [];
    for (const existing of combos) {
      for (const option of group.options) {
        newCombos.push({
          label: existing.label
            ? `${existing.label} / ${option.label}`
            : option.label,
          selections: [
            ...existing.selections,
            {
              groupName: group.name,
              optionLabel: option.label,
              locator: option.locator,
            },
          ],
        });
      }
    }
    combos = newCombos;
  }

  return combos;
}

/**
 * Read the ATC button's current state without clicking it.
 */
async function observeATCState(
  page: Page,
  atcStep: FlowStep
): Promise<ATCButtonState> {
  const resolved = await resolveLocator(page, atcStep, 3000);
  if (!resolved) {
    return {
      found: false,
      enabled: false,
      visible: false,
      text: "",
      ariaDisabled: false,
    };
  }

  try {
    const el = resolved.locator.first();
    const state = await el.evaluate((node) => {
      const htmlEl = node as HTMLElement;
      const style = window.getComputedStyle(htmlEl);
      return {
        disabled: (htmlEl as HTMLButtonElement).disabled ?? false,
        ariaDisabled: htmlEl.getAttribute("aria-disabled") === "true",
        visible: style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0",
        text: (htmlEl.innerText || htmlEl.textContent || "").trim(),
      };
    });

    return {
      found: true,
      enabled: !state.disabled && !state.ariaDisabled,
      visible: state.visible,
      text: state.text,
      ariaDisabled: state.ariaDisabled,
    };
  } catch {
    return {
      found: false,
      enabled: false,
      visible: false,
      text: "",
      ariaDisabled: false,
    };
  }
}

/**
 * Try to read price text from the page using common selectors.
 */
async function readPriceText(page: Page): Promise<string | undefined> {
  const selectors = [
    "[itemprop='price']",
    "[data-price]",
    ".price",
  ];

  for (const selector of selectors) {
    try {
      const el = page.locator(selector).first();
      const count = await el.count();
      if (count > 0) {
        const text = await el.evaluate((node) =>
          ((node as HTMLElement).innerText || node.textContent || "").trim()
        );
        if (text) return text;
      }
    } catch {
      // Try next selector
    }
  }

  return undefined;
}

/**
 * Stage 3B: Variant Health Sweep
 *
 * Loads the page once on Chrome Desktop, clicks through every variant
 * combination without reloading, and records the ATC button state for each.
 * No LLM calls, no screenshots, no full checkout flow.
 */
export async function executeStage3B(
  flowConfig: FlowConfig,
  input: PipelineInput
): Promise<StageResult<VariantSweepResult>> {
  const startTime = Date.now();
  const maxCombinations = env.MAX_SWEEP_COMBINATIONS;

  try {
    const variants = flowConfig.variants;
    if (!variants || variants.length === 0) {
      return {
        success: true,
        data: null,
        durationMs: Date.now() - startTime,
      };
    }

    let allCombinations = generateAllCombinations(variants);
    if (allCombinations.length <= 1) {
      return {
        success: true,
        data: null,
        durationMs: Date.now() - startTime,
      };
    }

    // Safety cap
    let capped = false;
    if (allCombinations.length > maxCombinations) {
      logger.warn("Stage 3B: Capping combinations", {
        total: allCombinations.length,
        cap: maxCombinations,
      });
      allCombinations = allCombinations.slice(0, maxCombinations);
      capped = true;
    }

    // Find the ATC step
    const atcStep = findATCStep(flowConfig.steps);
    if (!atcStep) {
      logger.warn("Stage 3B: No ATC step found, skipping sweep");
      return {
        success: true,
        data: null,
        error: "No ATC step found in flow config",
        durationMs: Date.now() - startTime,
      };
    }

    logger.info("Stage 3B: Starting variant health sweep", {
      totalCombinations: allCombinations.length,
      capped,
      atcStep: atcStep.description,
    });

    // Launch Chrome Desktop
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
    });
    const page = await context.newPage();

    try {
      // Navigate once
      await page.goto(input.pageUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const results: VariantHealthResult[] = [];
      let consecutiveSelectionFailures = 0;
      let abortedEarly = false;
      let abortReason: string | undefined;

      for (let i = 0; i < allCombinations.length; i++) {
        const combo = allCombinations[i];
        const comboStart = Date.now();

        logger.info("Stage 3B: Testing combination", {
          index: i + 1,
          total: allCombinations.length,
          label: combo.label,
        });

        // Click each variant option in this combination
        let selectionSuccess = true;
        let selectionError: string | undefined;

        for (const selection of combo.selections) {
          const variantStep: FlowStep = {
            action: "click",
            locator: selection.locator,
            description: `Select ${selection.groupName}: ${selection.optionLabel}`,
            required: true,
            timeout: SWEEP_CLICK_TIMEOUT,
          };

          const clickResult = await actions.click(page, variantStep);
          if (!clickResult.success) {
            selectionSuccess = false;
            selectionError = clickResult.errorMessage;
            break;
          }

          // Wait for DOM to settle
          await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
        }

        // Observe ATC state if selection succeeded
        let atcState: ATCButtonState | null = null;
        let priceText: string | undefined;

        if (selectionSuccess) {
          atcState = await observeATCState(page, atcStep);
          priceText = await readPriceText(page);
          consecutiveSelectionFailures = 0;
        } else {
          consecutiveSelectionFailures++;
        }

        results.push({
          combinationLabel: combo.label,
          selections: combo.selections.map((s) => ({
            groupName: s.groupName,
            optionLabel: s.optionLabel,
          })),
          selectionSuccess,
          selectionError,
          atcState,
          priceText,
          durationMs: Date.now() - comboStart,
        });

        // Early abort after too many consecutive selection failures
        if (consecutiveSelectionFailures >= MAX_CONSECUTIVE_SELECTION_FAILURES) {
          abortedEarly = true;
          abortReason = `${MAX_CONSECUTIVE_SELECTION_FAILURES} consecutive selection failures`;
          logger.warn("Stage 3B: Aborting sweep due to consecutive failures", {
            consecutiveSelectionFailures,
            stoppedAt: i + 1,
            total: allCombinations.length,
          });
          break;
        }
      }

      // Compile results
      const availableCount = results.filter(
        (r) => r.selectionSuccess && r.atcState?.found && r.atcState.enabled && r.atcState.visible
      ).length;
      const unavailableCount = results.filter(
        (r) => r.selectionSuccess && r.atcState !== null && (!r.atcState.enabled || !r.atcState.visible || !r.atcState.found)
      ).length;
      const selectionFailureCount = results.filter((r) => !r.selectionSuccess).length;

      const sweepResult: VariantSweepResult = {
        pageUrl: input.pageUrl,
        totalCombinations: allCombinations.length,
        availableCount,
        unavailableCount,
        selectionFailureCount,
        abortedEarly,
        abortReason,
        results,
        durationMs: Date.now() - startTime,
      };

      logger.info("Stage 3B: Sweep complete", {
        totalCombinations: sweepResult.totalCombinations,
        available: availableCount,
        unavailable: unavailableCount,
        selectionFailures: selectionFailureCount,
        abortedEarly,
        durationMs: sweepResult.durationMs,
      });

      return {
        success: true,
        data: sweepResult,
        durationMs: Date.now() - startTime,
      };
    } finally {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  } catch (err) {
    logger.error("Stage 3B failed", { error: String(err) });
    return {
      success: false,
      data: null,
      error: String(err),
      durationMs: Date.now() - startTime,
    };
  }
}
