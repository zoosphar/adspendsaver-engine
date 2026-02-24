import { runPipeline } from "./src/pipeline.js";

const PAGE_URL = process.argv[2];

if (!PAGE_URL) {
  console.error("Usage: bun run test-run.ts <product-url>");
  process.exit(1);
}

console.log(`\nRunning pipeline for: ${PAGE_URL}\n`);

const output = await runPipeline({
  prompt: "Analyze product page purchase flow",
  clientWebsite: new URL(PAGE_URL).hostname,
  adId: `test_${Date.now()}`,
  pageUrl: PAGE_URL,
  enableEvidence: true,
});

console.log("\n=== Pipeline Result ===\n");
console.log(JSON.stringify(output, null, 2));
