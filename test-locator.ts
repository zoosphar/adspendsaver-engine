/**
 * Manual locator tester.
 * Usage:
 *   bun run test-locator.ts <url> <method> <args...>
 *
 * Examples:
 *   bun run test-locator.ts "https://example.com/products/shirt" role button "Add to Cart"
 *   bun run test-locator.ts "https://example.com/products/shirt" text "Checkout"
 *   bun run test-locator.ts "https://example.com/products/shirt" label "Size"
 *   bun run test-locator.ts "https://example.com/products/shirt" css ".cart-drawer"
 *   bun run test-locator.ts "https://example.com/products/shirt" testId "add-to-cart"
 *   bun run test-locator.ts "https://example.com/products/shirt" snapshot
 *
 * Sequence mode — test multiple locators in order (click each, then test next):
 *   bun run test-locator.ts "https://example.com/products/shirt" sequence \
 *     click:css:label[for*='option1-red'] \
 *     click:role:button:"Add to Cart" \
 *     wait:css:.cart-drawer \
 *     test:role:link:Checkout
 *
 *   Format: <action>:<method>:<arg1>[:<arg2>]
 *   Actions: click (click element), wait (waitFor attached), test (just check existence)
 */
import { chromium } from "playwright";

async function testLocator(page: import("playwright").Page, method: string, args: string[]) {
  let locator;
  let description: string;

  switch (method) {
    case "role": {
      const role = args[0];
      const name = args[1];
      locator = page.getByRole(role as any, name ? { name } : undefined);
      description = name ? `getByRole("${role}", { name: "${name}" })` : `getByRole("${role}")`;
      break;
    }
    case "text": {
      const text = args[0];
      locator = page.getByText(text);
      description = `getByText("${text}")`;
      break;
    }
    case "label": {
      const label = args[0];
      locator = page.getByLabel(label);
      description = `getByLabel("${label}")`;
      break;
    }
    case "css": {
      const selector = args[0];
      locator = page.locator(selector);
      description = `locator("${selector}")`;
      break;
    }
    case "testId": {
      const testId = args[0];
      locator = page.getByTestId(testId);
      description = `getByTestId("${testId}")`;
      break;
    }
    default:
      console.error(`Unknown method: ${method}`);
      return { locator: null, description: `unknown(${method})` };
  }

  return { locator, description };
}

async function inspectLocator(locator: import("playwright").Locator, description: string) {
  console.log(`\nTesting: page.${description}`);

  const count = await locator.count();
  console.log(`Found: ${count} element(s)\n`);

  if (count > 0) {
    for (let i = 0; i < Math.min(count, 5); i++) {
      const el = locator.nth(i);
      const visible = await el.isVisible().catch(() => false);
      const enabled = await el.isEnabled().catch(() => false);
      const text = await el.textContent().catch(() => null);
      const tag = await el.evaluate((e) => e.tagName.toLowerCase()).catch(() => "?");
      const outerHtml = await el.evaluate((e) => e.outerHTML.slice(0, 300)).catch(() => "?");

      console.log(`  [${i}] <${tag}> visible=${visible} enabled=${enabled}`);
      console.log(`       text: "${text?.trim().slice(0, 80)}"`);
      console.log(`       html: ${outerHtml}`);
      console.log("");
    }
  }

  return count;
}

function parseSequenceStep(step: string): { action: string; method: string; args: string[] } {
  // Format: action:method:arg1[:arg2]
  // The method's argument may contain colons (e.g. css selectors), so we split carefully
  const firstColon = step.indexOf(":");
  const action = step.slice(0, firstColon);

  const rest = step.slice(firstColon + 1);
  const secondColon = rest.indexOf(":");
  const method = rest.slice(0, secondColon);

  let argStr = rest.slice(secondColon + 1);

  // For role method, the format is role:roleName:optionalName
  if (method === "role") {
    const roleColon = argStr.indexOf(":");
    if (roleColon !== -1) {
      return { action, method, args: [argStr.slice(0, roleColon), argStr.slice(roleColon + 1)] };
    }
    return { action, method, args: [argStr] };
  }

  return { action, method, args: [argStr] };
}

async function main() {
  const [, , url, method, ...args] = process.argv;

  if (!url || !method) {
    console.log("Usage: bun run test-locator.ts <url> <method> <args...>");
    console.log("");
    console.log("Methods:");
    console.log("  snapshot                     — print aria snapshot of the page");
    console.log('  role <role> [name]           — page.getByRole(role, { name })');
    console.log('  text <text>                  — page.getByText(text)');
    console.log('  label <label>                — page.getByLabel(label)');
    console.log('  css <selector>               — page.locator(selector)');
    console.log('  testId <id>                  — page.getByTestId(id)');
    console.log("");
    console.log("Sequence mode (test locators in order, clicking/waiting between):");
    console.log('  sequence click:css:label[for*="color-red"] click:role:button:Add to Cart wait:css:.cart-drawer test:role:link:Checkout');
    console.log("");
    console.log("  Actions: click, wait (waitFor 8s), test (check only, no interaction)");
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  console.log(`Navigating to: ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(3000);

  if (method === "snapshot") {
    console.log("\n=== Aria Snapshot ===\n");
    const snapshot = await page.locator("body").ariaSnapshot();
    console.log(snapshot);
    await browser.close();
    return;
  }

  if (method === "sequence") {
    console.log(`\n=== Sequence Mode: ${args.length} steps ===\n`);

    for (let i = 0; i < args.length; i++) {
      const { action, method: m, args: a } = parseSequenceStep(args[i]);
      console.log(`--- Step ${i + 1}: ${action} ${m} ${a.join(" ")} ---`);

      const { locator, description } = await testLocator(page, m, a);
      if (!locator) {
        console.log(`  SKIP: could not create locator\n`);
        continue;
      }

      const count = await inspectLocator(locator, description);

      if (count === 0) {
        console.log(`  FAILED: element not found`);
        console.log(`\n  Taking snapshot of current page state...\n`);
        const snapshot = await page.locator("body").ariaSnapshot().catch(() => "snapshot failed");
        console.log(snapshot);
        break;
      }

      if (action === "click") {
        try {
          await locator.first().scrollIntoViewIfNeeded();
          await locator.first().click({ timeout: 10000 });
          console.log(`  CLICKED successfully`);
          await page.waitForTimeout(2000);
        } catch (err) {
          console.log(`  CLICK FAILED: ${String(err)}`);
          console.log(`\n  Taking snapshot of current page state...\n`);
          const snapshot = await page.locator("body").ariaSnapshot().catch(() => "snapshot failed");
          console.log(snapshot);
          break;
        }
      } else if (action === "wait") {
        try {
          await locator.first().waitFor({ state: "attached", timeout: 8000 });
          console.log(`  WAIT satisfied`);
        } catch (err) {
          console.log(`  WAIT FAILED: ${String(err)}`);
          console.log(`\n  Taking snapshot of current page state...\n`);
          const snapshot = await page.locator("body").ariaSnapshot().catch(() => "snapshot failed");
          console.log(snapshot);
          break;
        }
      } else {
        console.log(`  TEST only — no interaction`);
      }

      console.log("");
    }

    await browser.close();
    return;
  }

  // Single locator mode
  const { locator, description } = await testLocator(page, method, args);
  if (!locator) {
    await browser.close();
    process.exit(1);
  }

  await inspectLocator(locator, description);
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
