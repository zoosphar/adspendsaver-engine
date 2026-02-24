# AdSpendSaver Engine (Early Alpha)

The core engine behind [AdSpendSaver](https://adspendsaver.com) — automated landing page QA for paid media. Catches broken purchase flows, dead links, missing UTM parameters, and cross-browser rendering issues — before ad spend is wasted on pages that don't convert.

> **Status:** Early alpha. APIs and DSL schema are subject to change.

## The Problem

Brands spend thousands on ads pointing to product pages that silently break: an "Add to Cart" button doesn't work on Safari mobile, a variant selector fails after a site deploy, UTM parameters get stripped at checkout. These failures are invisible in analytics (the user just bounces) and expensive to diagnose manually across browser/device/variant combinations.

## What This Does

Given a product page URL, the engine autonomously:

1. **Discovers the purchase flow** — An LLM navigates the live page via browser automation, identifies every interactive element (add-to-cart, variant selectors, checkout buttons), and outputs a structured flow definition (DSL)
2. **Validates the flow** — A headless browser verifies every extracted selector actually exists on the page. If selectors are stale or wrong, it feeds errors back to the LLM and re-extracts (up to N retries)
3. **Executes across 6 browser/device combos** — The validated flow runs deterministically (no LLM in the loop) on Chrome, Firefox, and Safari across desktop and mobile viewports
4. **Sweeps product variants** — If the page has color/size selectors, it tests every available combination
5. **Verifies failures with vision** — Failed steps get a screenshot analyzed by a vision model to confirm whether the failure is real or a locator flake
6. **Produces a structured report** — Pass/fail per combo, broken images, console errors, UTM preservation checks, severity classification, and recommended actions

## Architecture

```
                    ┌─────────────────────────────────┐
   POST /api/run    │          HTTP Server (Bun)       │
  ─────────────────►│                                  │
                    └──────────────┬──────────────────-┘
                                   │
                    ┌──────────────▼──────────────────-┐
                    │     Stage 1: LLM Extraction       │
                    │  Claude + Playwright MCP           │
                    │  → Navigates page, outputs DSL     │
                    └──────────────┬──────────────────-┘
                                   │ FlowConfig JSON
                    ┌──────────────▼──────────────────-┐
                    │     Stage 2: Sanity Check          │
                    │  Direct Playwright (no LLM)        │
                    │  → Verifies all selectors exist     │
                    │  → Feeds back missing → retry S1    │
                    └──────────────┬──────────────────-┘
                                   │ Validated config
                    ┌──────────────▼──────────────────-┐
                    │     Stage 3: Execution Engine      │
                    │  Deterministic DSL runner (no LLM) │
                    │  → 6 browser/device combos         │
                    │  → Variant sweep (all combos)       │
                    │  → Screenshot evidence              │
                    └──────────────┬──────────────────-┘
                                   │
                    ┌──────────────▼──────────────────-┐
                    │     Failure Verification           │
                    │  Gemini Vision on screenshots      │
                    │  → Confirms real vs flaky failures  │
                    └──────────────┬──────────────────-┘
                                   │
                    ┌──────────────▼──────────────────-┐
                    │     Summary Generation            │
                    │  Claude → structured JSON report   │
                    │  → severity, findings, actions      │
                    └──────────────────────────────────-┘
```

**Key design decision:** The LLM is only used for extraction (Stage 1) and analysis (failure verification + summary). The actual test execution is a deterministic switch/case engine running a JSON DSL — no LLM variance, no prompt sensitivity, fully reproducible results.

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Bun (TypeScript, ESM) |
| LLM — extraction & summary | Anthropic Claude (Sonnet) |
| LLM — failure verification | Google Gemini 2.5 Flash |
| Browser automation | Playwright + @playwright/mcp |
| Storage | Firebase Firestore + Cloud Storage |
| Container | Docker (oven/bun:1.2-debian) |

## Browser/Device Coverage

| Browser | Desktop (1920x1080) | Mobile (390x844) |
|---|---|---|
| Chromium | Chrome Desktop | Chrome Android |
| Firefox | Firefox Desktop | Firefox Android |
| WebKit | Safari Desktop | Safari iOS |

## API

### `POST /api/run`

Full pipeline — extract flow, validate, execute across all combos.

```json
{
  "pageUrl": "https://example.com/products/widget?utm_source=meta&utm_campaign=summer",
  "adId": "ad_123",
  "clientWebsite": "example.com"
}
```

### `POST /api/rerun`

Re-execute using a previously extracted flow config (skips Stage 1 if the cached config passes sanity checks). Falls back to full pipeline if the cached config is stale.

### `GET /health`

Returns `{ "status": "ok" }`.

### Response Shape

```json
{
  "success": true,
  "adId": "ad_123",
  "pageUrl": "https://example.com/products/widget",
  "flowConfigs": [],
  "simulationResults": [
    {
      "comboName": "Chrome Desktop",
      "browser": "chromium",
      "device": "desktop",
      "variantCombination": "Red / M",
      "overallSuccess": true,
      "adParamsPreserved": true,
      "steps": [],
      "consoleErrors": []
    }
  ],
  "additionalChecks": {
    "is404": false,
    "brokenImages": [],
    "consoleErrors": [],
    "adParamCheck": { "preserved": true, "missingParams": [] }
  },
  "summary": {
    "overallStatus": "pass",
    "severity": "none",
    "findings": [],
    "recommendedActions": []
  },
  "durationMs": 142000
}
```

## Setup

### Prerequisites

- [Bun](https://bun.sh) v1.2+
- Anthropic API key
- Google Gemini API key
- Firebase service account JSON + Storage bucket

### Local

```bash
cp .env.example .env
# Fill in API keys and Firebase credentials

bun install
bun run dev
```

### Docker

```bash
cp .env.example .env
# Fill in credentials

docker compose up --build
```

The container installs Chromium, Firefox, and WebKit browsers and requires 2GB shared memory for headless rendering.

## Configuration

All configuration via environment variables (see `.env.example`):

| Variable | Required | Default | Description |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | — | Claude API key |
| `GEMINI_API_KEY` | Yes | — | Gemini API key |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Yes | — | Path to JSON file or inline JSON |
| `FIREBASE_STORAGE_BUCKET` | Yes | — | GCS bucket for evidence screenshots |
| `PORT` | No | 3000 | HTTP server port |
| `EXPLORATION_MODEL` | No | claude-sonnet-4-6 | Model for page exploration |
| `SUMMARY_MODEL` | No | claude-haiku-4-5 | Model for report generation |
| `GEMINI_MODEL` | No | gemini-2.5-flash | Model for failure verification |
| `MAX_SANITY_RETRIES` | No | 3 | Stage 1→2 retry attempts |
| `PIPELINE_TIMEOUT_MS` | No | 900000 | Full pipeline timeout (15 min) |

## Project Structure

```
src/
├── index.ts                  # HTTP server
├── pipeline.ts               # Orchestrator (Stage 1→2→3 loop)
├── config/
│   ├── env.ts                # Environment variable validation
│   └── firebase.ts           # Firebase init
├── engine/
│   ├── executor.ts           # Deterministic DSL engine
│   ├── actions.ts            # Playwright action implementations
│   ├── evidence.ts           # Screenshot capture + upload
│   └── failure-verifier.ts   # Gemini vision verification
├── stages/
│   ├── stage1-extract.ts     # LLM + MCP flow extraction
│   ├── stage2-sanity.ts      # Selector validation
│   ├── stage3-execute.ts     # Cross-browser execution
│   └── stage3b-variant-sweep.ts  # Variant combination sweep
├── mcp/
│   ├── client.ts             # Playwright MCP client
│   └── prompts.ts            # LLM prompt templates
├── firebase/
│   ├── firestore.ts          # Run/result persistence
│   └── storage.ts            # Evidence screenshot upload
├── types/
│   ├── flow-config.ts        # FlowConfig DSL schema
│   ├── pipeline.ts           # Pipeline I/O types
│   ├── simulation.ts         # Execution result types
│   ├── checks.ts             # Additional check types
│   └── variant-sweep.ts      # Variant sweep types
└── utils/
    ├── devices.ts            # Browser/device combo definitions
    ├── logger.ts             # Structured logging
    ├── snapshot-diff.ts      # DOM diff utilities
    └── url.ts                # URL manipulation helpers
```
