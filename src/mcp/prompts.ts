import type { PipelineInput } from "../types/index.js";
import type { SimulationResult, AdditionalChecks } from "../types/index.js";
import type { VariantSweepResult } from "../types/variant-sweep.js";

const LOCATOR_DOCS = `## Locator Descriptor Format

Each locator is an object with a "method" field that maps to Playwright's locator API:

- **role**: \`page.getByRole(role, { name })\`. Best for buttons, links, radios, checkboxes.
  \`{ "method": "role", "role": "button", "name": "Add to Cart" }\`
- **text**: \`page.getByText(text)\`. For matching visible text content.
  \`{ "method": "text", "text": "Checkout" }\`
- **label**: \`page.getByLabel(label)\`. For form elements with labels.
  \`{ "method": "label", "label": "Size" }\`
- **css**: \`page.locator(selector)\`. Fallback when semantic locators are not possible.
  \`{ "method": "css", "selector": "[data-testid='add-to-cart']" }\`
- **testId**: \`page.getByTestId(testId)\`.
  \`{ "method": "testId", "testId": "checkout-button" }\`

Add "exact": true when you need exact text matching (to avoid partial matches).

**Prefer semantic locators** (role, text, label) over CSS. The accessibility tree directly shows roles and names — use those.

## Locator best practices
- Build locators directly from what you see in the accessibility tree: roles, names, labels.
- Prefer: role > label > text > testId > css
- Use "exact": true when the name could partially match other elements.
- Use CSS locators only when semantic locators are ambiguous or unavailable.`;

/**
 * Phase A prompt: extract variants + steps up to and including Add to Cart.
 * Does NOT include cart/checkout steps (those come from Phase B after ATC is clicked).
 */
export function buildPreCartPrompt(
  input: PipelineInput,
  snapshot: string,
  feedback?: string
): string {
  const base = `You are an e-commerce automation engineer. Analyze the accessibility tree of a product page and produce a PARTIAL FlowConfig JSON containing only the variant options and the steps UP TO AND INCLUDING the Add to Cart click.

## Target: ${input.pageUrl}

## Accessibility Tree (initial page state — BEFORE any interaction)

<accessibility_tree>
${snapshot}
</accessibility_tree>

## Your Task

Analyze the accessibility tree above and identify:
1. All variant option groups (color, size, material) with every individual option
2. The Add to Cart button

**IMPORTANT**: Do NOT attempt to extract cart drawer, cart modal, or checkout elements. Those do not exist yet on this page — they only appear AFTER clicking Add to Cart. We will extract those in a separate step.

## CRITICAL: Extract ALL variant options

You MUST extract every individual color option, size option, and any other variant option visible in the tree. Do NOT pick just the first one. We need to test every combination.

${LOCATOR_DOCS}

## Output JSON Format
\`\`\`json
{
  "flow_type": "product_to_checkout",
  "pageUrl": "${input.pageUrl}",
  "clientWebsite": "${input.clientWebsite}",
  "extractedAt": "<ISO 8601>",
  "pageStructure": { "framework": "<Shopify|WooCommerce|Custom>", "isSPA": false, "notes": [] },
  "variants": [
    {
      "name": "Color",
      "type": "color",
      "options": [
        { "label": "Red", "locator": { "method": "role", "role": "radio", "name": "Red" }, "available": true },
        { "label": "Blue", "locator": { "method": "role", "role": "radio", "name": "Blue" }, "available": true }
      ]
    },
    {
      "name": "Size",
      "type": "size",
      "options": [
        { "label": "S", "locator": { "method": "role", "role": "radio", "name": "S" }, "available": true },
        { "label": "M", "locator": { "method": "role", "role": "radio", "name": "M" }, "available": true }
      ]
    }
  ],
  "steps": [
    {
      "action": "wait_for",
      "locator": { "method": "role", "role": "button", "name": "Add to Cart" },
      "description": "Wait for product form to load",
      "required": true
    },
    {
      "action": "click",
      "locator": { "method": "role", "role": "button", "name": "Add to Cart" },
      "fallbackLocators": [
        { "method": "text", "text": "Add to Cart" }
      ],
      "description": "Click Add to Cart",
      "required": true
    }
  ]
}
\`\`\`

## Variant rules
- The "variants" array contains ALL variant groups found on the page (Color, Size, Material, Style).
- Each group has "type": "color" for color pickers, "size" for size selectors, "other" for anything else.
- Each option has a "locator" that uniquely identifies THAT specific option.
- For radio buttons in the tree: use \`{ "method": "role", "role": "radio", "name": "<accessible name>" }\`.
- For buttons acting as variant selectors: use \`{ "method": "role", "role": "button", "name": "<text>" }\`.
- For \`<select>\` dropdowns: use \`{ "method": "label", "label": "<select label>" }\` for the group, and for individual options the executor will handle option selection by value.
- Set "available": false for options that show as disabled in the accessibility tree.
- If there are NO variant options on the page, omit the "variants" field entirely.

## Steps rules
- The "steps" array contains ONLY steps up to and including the Add to Cart click.
- Variant selection is handled separately — do NOT include variant selection in "steps".
- The first step should wait for a key product element to load (e.g., the ATC button).
- The last step MUST be the Add to Cart click.
- Add 1-2 fallbackLocators for the Add to Cart step.
- Do NOT include any cart/checkout steps — those will be extracted separately after ATC is clicked.

Respond with ONLY the JSON. No explanation.`;

  if (feedback) {
    return `${base}

## Previous Attempt Feedback

The previous extraction had issues. Please fix them:

${feedback}

Produce a corrected JSON.`;
  }

  return base;
}

/**
 * Phase B prompt: extract cart/checkout steps from the post-ATC page state.
 * Receives snapshot #2 (after ATC clicked) and a diff showing new elements.
 */
export function buildPostCartPrompt(
  input: PipelineInput,
  cartSnapshot: string,
  diff: string,
  iframeSnapshots?: string[]
): string {
  const iframeSection = iframeSnapshots && iframeSnapshots.length > 0
    ? `

## Iframe Content (cart drawer/sidebar may be rendered inside an iframe)

The following accessibility trees were captured from iframes on the page after clicking Add to Cart.
The cart drawer or sidebar is often rendered inside an iframe. Look here for cart items, checkout buttons, etc.

**IMPORTANT**: You do NOT need special iframe handling in your locators — use the same locator methods (role, text, css, etc.) as for the main page. The execution engine automatically searches inside iframes.

${iframeSnapshots.map((snap, i) => `<iframe_${i + 1}>\n${snap}\n</iframe_${i + 1}>`).join("\n\n")}`
    : "";

  return `You are an e-commerce automation engineer. The Add to Cart button has just been clicked on a product page. Analyze the current page state and extract the remaining steps to reach the Checkout page.

## Target: ${input.pageUrl}

## Current Accessibility Tree (after Add to Cart was clicked)

<accessibility_tree>
${cartSnapshot}
</accessibility_tree>

## What Changed (diff from initial page → current state)

Lines starting with \`+\` are NEW elements that appeared after clicking Add to Cart (e.g., cart drawer, cart items, checkout button). Lines starting with \`-\` are elements that disappeared.

<snapshot_diff>
${diff}
</snapshot_diff>${iframeSection}

## Your Task

Extract the remaining steps AFTER Add to Cart, specifically:
1. **Wait for cart**: Wait for the cart drawer/modal/page to appear (look for dialog, drawer, or cart container in the new elements)
2. **Verify cart has items**: Wait for a cart item element to confirm something was added
3. **Click Checkout**: Click the Checkout button/link — STOP here, do NOT proceed to payment

Focus on the \`+\` lines in the diff — those are the new elements you should target.

${LOCATOR_DOCS}

## Output JSON Format

Return ONLY an array of FlowStep objects:

\`\`\`json
[
  {
    "action": "wait_for",
    "locator": { "method": "role", "role": "dialog" },
    "fallbackLocators": [
      { "method": "text", "text": "Your cart" }
    ],
    "description": "Wait for cart drawer to open",
    "timeout": 8000,
    "required": true
  },
  {
    "action": "wait_for",
    "locator": { "method": "css", "selector": ".cart-item" },
    "description": "Verify cart has items",
    "required": true
  },
  {
    "action": "click",
    "locator": { "method": "role", "role": "link", "name": "Checkout" },
    "fallbackLocators": [
      { "method": "role", "role": "button", "name": "Checkout" },
      { "method": "css", "selector": "[href*='/checkout']" }
    ],
    "description": "Click Checkout",
    "required": true
  }
]
\`\`\`

## Rules
- Return ONLY the post-ATC steps (cart wait, cart verify, checkout click).
- Do NOT include Add to Cart or variant selection — those are already handled.
- Add 1-2 fallbackLocators for the wait-for-cart and checkout steps.
- Build locators from what you ACTUALLY see in the accessibility tree above — do NOT guess.

Respond with ONLY the JSON array. No explanation.`;
}

export function buildLocatorRepairPrompt(
  accessibilityTree: string,
  failingStep: { action: string; locator: string; description: string },
  errorMessage: string
): string {
  return `You are an e-commerce automation engineer. A Playwright locator failed during a purchase flow simulation. Analyze the current page state and produce a corrected locator.

## Failing Step

- **Action**: ${failingStep.action}
- **Description**: ${failingStep.description}
- **Failed Locator**: ${failingStep.locator}
- **Error**: ${errorMessage}

## Current Accessibility Tree

This is the accessibility tree of the page RIGHT NOW (after previous steps have already been executed — e.g., a product may already be added to cart, a drawer may be open).

<accessibility_tree>
${accessibilityTree}
</accessibility_tree>

## Your Task

Find the correct element in the accessibility tree above that matches the intent of the failing step ("${failingStep.description}").

The page state may have changed since the flow config was first generated — elements like cart drawers, modals, or checkout buttons may have appeared or changed their roles/names.

## Locator Descriptor Format

Respond with ONLY a JSON object matching one of these formats:

- \`{ "method": "role", "role": "<role>", "name": "<accessible name>", "exact": true }\`
- \`{ "method": "text", "text": "<visible text>", "exact": true }\`
- \`{ "method": "label", "label": "<label text>", "exact": true }\`
- \`{ "method": "css", "selector": "<css selector>" }\`
- \`{ "method": "testId", "testId": "<test id>" }\`

Prefer semantic locators (role > text > label) over CSS. Build locators directly from what you see in the accessibility tree.

If you also identify good fallback locators, you may return:
\`\`\`json
{
  "primary": { "method": "role", "role": "link", "name": "Checkout" },
  "fallbacks": [
    { "method": "css", "selector": "[href*='/checkout']" }
  ]
}
\`\`\`

If the element genuinely does not exist on the page (e.g., the page is in an error state), respond with:
\`\`\`json
{ "notFound": true, "reason": "<explanation>" }
\`\`\`

Respond with ONLY the JSON. No explanation.`;
}

export function buildSummaryPrompt(
  results: SimulationResult[],
  checks: AdditionalChecks | null,
  input: PipelineInput,
  variantSweep?: VariantSweepResult | null
): string {
  const resultsJson = JSON.stringify(results, null, 2);
  const checksJson = checks ? JSON.stringify(checks, null, 2) : "null";

  let variantSweepSection = "";
  if (variantSweep) {
    variantSweepSection = `

## Variant Health Sweep (Stage 3B)

A lightweight sweep tested all ${variantSweep.totalCombinations} variant combinations on a single page load (Chrome Desktop only) by clicking each variant and observing the Add to Cart button state.

- **Available (ATC enabled)**: ${variantSweep.availableCount}
- **Unavailable (ATC disabled/hidden)**: ${variantSweep.unavailableCount}
- **Selection failures**: ${variantSweep.selectionFailureCount}
${variantSweep.abortedEarly ? `- **Aborted early**: ${variantSweep.abortReason}` : ""}

### Per-variant results

${JSON.stringify(variantSweep.results.map((r) => ({
  variant: r.combinationLabel,
  selectable: r.selectionSuccess,
  atcText: r.atcState?.text ?? "N/A",
  atcEnabled: r.atcState?.enabled ?? false,
  atcVisible: r.atcState?.visible ?? false,
  price: r.priceText ?? "N/A",
})), null, 2)}

Include variant availability findings in your analysis. Flag any variants that are unavailable or have selection issues.`;
  }

  return `You are an e-commerce QA analyst. Analyze the following simulation results from testing a product page across multiple browser/device combinations.

## Context

- **Ad ID**: ${input.adId}
- **Page URL**: ${input.pageUrl}
- **Client Website**: ${input.clientWebsite}
- **Ad Provider**: ${input.adProvider ?? "unknown"}

## Simulation Results (6 browser/device combos)

${resultsJson}

## Additional Checks

${checksJson}${variantSweepSection}

## Your Analysis

Respond with ONLY a JSON object:

\`\`\`json
{
  "overallStatus": "<pass|fail|partial>",
  "severity": "<critical|high|medium|low|none>",
  "findings": [
    "<finding 1>",
    "<finding 2>"
  ],
  "recommendedActions": [
    "<action 1>",
    "<action 2>"
  ],
  "rawSummary": "<2-3 paragraph detailed summary>"
}
\`\`\`

## Severity Guide

- **critical**: Page is 404, checkout is completely broken, or all combos fail
- **high**: Most combos fail, or ad params are lost on all combos
- **medium**: Some combos fail, or minor issues on specific browsers
- **low**: Minor issues like slow load times or console warnings
- **none**: All combos pass with no issues`;
}
