import type { Page, Locator, Frame } from "playwright";
import type { FlowStep, LocatorDescriptor } from "../types/index.js";
import { logger } from "../utils/logger.js";

/** Max time for any single Playwright interaction (click, fill, scroll) */
const ACTION_TIMEOUT = 10_000;

export interface ActionResult {
  success: boolean;
  usedLocator: string;    // human-readable description of the locator that worked
  errorMessage?: string;
}

/**
 * Convert a LocatorDescriptor to a human-readable string for logging.
 */
export function locatorToString(desc: LocatorDescriptor): string {
  switch (desc.method) {
    case "role":
      return desc.name
        ? `role=${desc.role}[name="${desc.name}"]`
        : `role=${desc.role}`;
    case "text":
      return `text="${desc.text}"`;
    case "label":
      return `label="${desc.label}"`;
    case "css":
      return `css=${desc.selector}`;
    case "testId":
      return `testId=${desc.testId}`;
  }
}

/**
 * Convert a LocatorDescriptor to a Playwright Locator.
 * Accepts Page or Frame — both share the same locator API.
 */
export function toLocator(pageOrFrame: Page | Frame, desc: LocatorDescriptor): Locator {
  switch (desc.method) {
    case "role":
      return pageOrFrame.getByRole(desc.role as any, {
        name: desc.name,
        exact: desc.exact,
      });
    case "text":
      return pageOrFrame.getByText(desc.text, { exact: desc.exact });
    case "label":
      return pageOrFrame.getByLabel(desc.label, { exact: desc.exact });
    case "css":
      return pageOrFrame.locator(desc.selector);
    case "testId":
      return pageOrFrame.getByTestId(desc.testId);
  }
}

/**
 * Try to find an element using a locator descriptor.
 */
async function tryLocator(
  pageOrFrame: Page | Frame,
  desc: LocatorDescriptor,
  timeout: number = 5000
): Promise<boolean> {
  try {
    await toLocator(pageOrFrame, desc).first().waitFor({ state: "attached", timeout });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a locator from primary + fallbacks. Returns the first one found.
 */
export async function resolveLocator(
  page: Page,
  step: FlowStep,
  timeout: number = 5000
): Promise<{ locator: Locator; desc: LocatorDescriptor } | null> {
  // Try main page: primary + fallbacks
  if (await tryLocator(page, step.locator, timeout)) {
    return { locator: toLocator(page, step.locator), desc: step.locator };
  }

  if (step.fallbackLocators) {
    for (const fallback of step.fallbackLocators) {
      if (await tryLocator(page, fallback, 2000)) {
        logger.info("Using fallback locator", {
          primary: locatorToString(step.locator),
          fallback: locatorToString(fallback),
          description: step.description,
        });
        return { locator: toLocator(page, fallback), desc: fallback };
      }
    }
  }

  // Try child frames (iframes) — e.g. cart drawers rendered in iframes
  for (const frame of page.frames()) {
    if (frame === page.mainFrame() || frame.isDetached()) continue;

    if (await tryLocator(frame, step.locator, 2000)) {
      logger.info("Found element in iframe", {
        locator: locatorToString(step.locator),
        description: step.description,
        frameUrl: frame.url(),
      });
      return { locator: toLocator(frame, step.locator), desc: step.locator };
    }

    if (step.fallbackLocators) {
      for (const fallback of step.fallbackLocators) {
        if (await tryLocator(frame, fallback, 1000)) {
          logger.info("Found element in iframe via fallback", {
            fallback: locatorToString(fallback),
            description: step.description,
            frameUrl: frame.url(),
          });
          return { locator: toLocator(frame, fallback), desc: fallback };
        }
      }
    }
  }

  return null;
}

function allLocatorsDescription(step: FlowStep): string {
  const primary = locatorToString(step.locator);
  const fallbacks = step.fallbackLocators?.map(locatorToString).join(", ");
  return fallbacks ? `${primary} (fallbacks: ${fallbacks})` : primary;
}

export async function click(page: Page, step: FlowStep): Promise<ActionResult> {
  const timeout = step.timeout ?? ACTION_TIMEOUT;
  const resolved = await resolveLocator(page, step, timeout);
  if (!resolved) {
    return {
      success: false,
      usedLocator: locatorToString(step.locator),
      errorMessage: `Element not found: ${allLocatorsDescription(step)}`,
    };
  }

  try {
    await resolved.locator.first().scrollIntoViewIfNeeded({ timeout });
    await resolved.locator.first().click({ timeout });
    return { success: true, usedLocator: locatorToString(resolved.desc) };
  } catch (err) {
    const errMsg = String(err);

    // If a parent element intercepts pointer events (common with custom radio/checkbox UIs
    // where a sr-only input is overlaid by a styled label), try clicking the associated label
    if (errMsg.includes("intercepts pointer events")) {
      logger.info("Click intercepted by parent, trying associated label", {
        locator: locatorToString(resolved.desc),
        description: step.description,
      });

      try {
        const el = resolved.locator.first();

        // Strategy 1: Find label[for=id] associated with this input
        const id = await el.getAttribute("id").catch(() => null);
        if (id) {
          const associatedLabel = page.locator(`label[for="${id}"]`);
          if (await associatedLabel.count().then((c) => c > 0).catch(() => false)) {
            await associatedLabel.first().click({ timeout });
            logger.info("Clicked associated label[for] successfully", { id });
            return { success: true, usedLocator: `label[for="${id}"]` };
          }
        }

        // Strategy 2: Find ancestor <label> wrapping this input
        const parentLabel = el.locator("xpath=ancestor::label");
        if (await parentLabel.count().then((c) => c > 0).catch(() => false)) {
          await parentLabel.first().click({ timeout });
          logger.info("Clicked parent label successfully");
          return { success: true, usedLocator: "ancestor label" };
        }

        // Strategy 3: Use JavaScript to programmatically select and fire events
        await el.evaluate((input) => {
          if (input instanceof HTMLInputElement) {
            input.checked = true;
            input.dispatchEvent(new Event("change", { bubbles: true }));
            input.dispatchEvent(new Event("input", { bubbles: true }));
            // Also click the input in JS context (may trigger framework handlers)
            input.click();
          }
        });
        logger.info("Used JS dispatch as fallback");
        return { success: true, usedLocator: locatorToString(resolved.desc) + " (js-dispatch)" };
      } catch (labelErr) {
        return {
          success: false,
          usedLocator: locatorToString(resolved.desc),
          errorMessage: `Click failed (label + JS fallbacks exhausted) on ${locatorToString(resolved.desc)}: ${String(labelErr)}`,
        };
      }
    }

    return {
      success: false,
      usedLocator: locatorToString(resolved.desc),
      errorMessage: `Click failed on ${locatorToString(resolved.desc)}: ${errMsg}`,
    };
  }
}

export async function selectIfExists(
  page: Page,
  step: FlowStep
): Promise<ActionResult> {
  const resolved = await resolveLocator(page, step, 3000);
  if (!resolved) {
    return {
      success: true,
      usedLocator: locatorToString(step.locator),
      errorMessage: "Element not found, skipped (select_if_exists)",
    };
  }

  try {
    const element = resolved.locator.first();
    const tagName = await element.evaluate((el) => el.tagName.toLowerCase());

    if (tagName === "select") {
      if (step.strategy === "first_available") {
        const optionValue = await element.evaluate((select) => {
          const options = Array.from(
            (select as HTMLSelectElement).options
          );
          const valid = options.find(
            (o) =>
              !o.disabled &&
              o.value !== "" &&
              !o.textContent?.toLowerCase().includes("select") &&
              !o.textContent?.toLowerCase().includes("choose")
          );
          return valid?.value ?? null;
        });

        if (optionValue) {
          await element.selectOption(optionValue, { timeout: ACTION_TIMEOUT });
          return { success: true, usedLocator: locatorToString(resolved.desc) };
        }
      }
      // Default: select the second option (first real option after placeholder)
      await element.evaluate((select) => {
        const sel = select as HTMLSelectElement;
        if (sel.options.length > 1) {
          sel.selectedIndex = 1;
          sel.dispatchEvent(new Event("change", { bubbles: true }));
        }
      });
      return { success: true, usedLocator: locatorToString(resolved.desc) };
    }

    // For non-select elements (swatch buttons, radio buttons), click the first one
    await element.click({ timeout: ACTION_TIMEOUT });
    return { success: true, usedLocator: locatorToString(resolved.desc) };
  } catch (err) {
    return {
      success: false,
      usedLocator: locatorToString(resolved.desc),
      errorMessage: `Select failed on ${locatorToString(resolved.desc)}: ${String(err)}`,
    };
  }
}

export async function waitFor(
  page: Page,
  step: FlowStep
): Promise<ActionResult> {
  const timeout = step.timeout ?? 5000;

  // Try primary locator
  try {
    await toLocator(page, step.locator).first().waitFor({ state: "attached", timeout });
    return { success: true, usedLocator: locatorToString(step.locator) };
  } catch {
    // Try fallbacks
  }

  if (step.fallbackLocators) {
    for (const fallback of step.fallbackLocators) {
      try {
        await toLocator(page, fallback).first().waitFor({ state: "attached", timeout: 2000 });
        return { success: true, usedLocator: locatorToString(fallback) };
      } catch {
        // Try next
      }
    }
  }

  return {
    success: false,
    usedLocator: locatorToString(step.locator),
    errorMessage: `Timeout waiting for: ${allLocatorsDescription(step)} (${timeout}ms)`,
  };
}

export async function typeInput(
  page: Page,
  step: FlowStep
): Promise<ActionResult> {
  if (!step.value) {
    return {
      success: false,
      usedLocator: locatorToString(step.locator),
      errorMessage: "type_input step has no value",
    };
  }

  const resolved = await resolveLocator(page, step);
  if (!resolved) {
    return {
      success: false,
      usedLocator: locatorToString(step.locator),
      errorMessage: `Input not found: ${allLocatorsDescription(step)}`,
    };
  }

  try {
    await resolved.locator.first().fill(step.value, { timeout: ACTION_TIMEOUT });
    return { success: true, usedLocator: locatorToString(resolved.desc) };
  } catch (err) {
    return {
      success: false,
      usedLocator: locatorToString(resolved.desc),
      errorMessage: `Type failed on ${locatorToString(resolved.desc)}: ${String(err)}`,
    };
  }
}
