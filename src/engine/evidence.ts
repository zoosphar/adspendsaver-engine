import type { Page, BrowserContext } from "playwright";
import { mkdir } from "fs/promises";
import { join } from "path";

export async function injectClickHighlighter(page: Page): Promise<void> {
  await page.addInitScript(() => {
    document.addEventListener(
      "click",
      (e) => {
        const dot = document.createElement("div");
        dot.style.cssText = `
          position: fixed;
          left: ${e.clientX - 10}px;
          top: ${e.clientY - 10}px;
          width: 20px;
          height: 20px;
          border-radius: 50%;
          background: rgba(255, 200, 0, 0.8);
          pointer-events: none;
          z-index: 999999;
          animation: clickRipple 0.6s ease-out forwards;
        `;
        document.body.appendChild(dot);

        // Add ripple animation style if not already present
        if (!document.getElementById("click-highlight-style")) {
          const style = document.createElement("style");
          style.id = "click-highlight-style";
          style.textContent = `
            @keyframes clickRipple {
              0% { transform: scale(1); opacity: 0.8; }
              100% { transform: scale(3); opacity: 0; }
            }
          `;
          document.head.appendChild(style);
        }

        setTimeout(() => dot.remove(), 600);
      },
      true
    );
  });
}

export async function takeStepScreenshot(
  page: Page,
  comboName: string,
  stepIndex: number,
  stepDescription: string,
  evidenceDir: string
): Promise<string> {
  const safeCombo = comboName.replace(/\s+/g, "_").toLowerCase();
  const safeDesc = stepDescription
    .replace(/[^a-zA-Z0-9]/g, "_")
    .toLowerCase()
    .slice(0, 50);

  const dir = join(evidenceDir, safeCombo, "screenshots");
  await mkdir(dir, { recursive: true });

  const filename = `step_${String(stepIndex).padStart(2, "0")}_${safeDesc}.png`;
  const filepath = join(dir, filename);

  await page.screenshot({ path: filepath, fullPage: false });
  return filepath;
}

export function getVideoRecordingConfig(evidenceDir: string, comboName: string) {
  const safeCombo = comboName.replace(/\s+/g, "_").toLowerCase();
  const dir = join(evidenceDir, safeCombo, "recordings");

  return {
    recordVideo: {
      dir,
      size: { width: 1280, height: 720 },
    },
  };
}
