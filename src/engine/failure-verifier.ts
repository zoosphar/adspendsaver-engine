import { GoogleGenerativeAI } from "@google/generative-ai";
import type { FlowStep, FailureVerification } from "../types/index.js";
import { locatorToString } from "./actions.js";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

let genAI: GoogleGenerativeAI | null = null;

function getGenAI(): GoogleGenerativeAI {
  if (!genAI) {
    genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
  }
  return genAI;
}

export async function verifyFailure(
  screenshotBuffer: Buffer,
  step: FlowStep,
  errorMessage: string
): Promise<FailureVerification> {
  try {
    const model = getGenAI().getGenerativeModel({ model: env.GEMINI_MODEL });

    const prompt = `You are analyzing a screenshot from an e-commerce website simulation that encountered an error.

## Failed Step
- **Action**: ${step.action}
- **Description**: ${step.description}
- **Locator**: ${locatorToString(step.locator)}
- **Error**: ${errorMessage}

## Your Task

Look at this screenshot and determine:
1. Is this a genuine failure? (element truly doesn't exist, page is broken, etc.)
2. Or is it a false positive? (element exists but the selector is wrong, timing issue, etc.)
3. What do you actually see on the page?

Respond with ONLY a JSON object:
{
  "confirmed": true/false,
  "reasoning": "explanation of what you see",
  "suggestedFix": "optional suggestion for fixing the selector or approach"
}`;

    const result = await model.generateContent([
      prompt,
      {
        inlineData: {
          mimeType: "image/png",
          data: screenshotBuffer.toString("base64"),
        },
      },
    ]);

    const text = result.response.text();
    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn("Gemini did not return valid JSON", { response: text });
      return { confirmed: true, reasoning: "Could not parse Gemini response" };
    }

    const parsed = JSON.parse(jsonMatch[0]) as FailureVerification;
    logger.info("Gemini failure verification", {
      step: step.description,
      confirmed: parsed.confirmed,
      reasoning: parsed.reasoning,
    });
    return parsed;
  } catch (err) {
    logger.error("Gemini verification failed", { error: String(err) });
    // Default to confirmed failure if Gemini is unavailable
    return {
      confirmed: true,
      reasoning: `Gemini verification failed: ${String(err)}`,
    };
  }
}
