import { createHash } from "node:crypto";
import { chromium } from "playwright";
import type { ArtifactStore } from "../persistence/artifact-store.js";
import type {
  BrowserViewportResult,
  ElementObservation,
  ViewportPreset,
} from "./visual-qa-types.js";
export interface BrowserRenderRequest {
  readonly url: string;
  readonly artifactPrefix: string;
  readonly viewports: readonly ViewportPreset[];
}
export class BrowserRenderer {
  #activeBrowsers = 0;
  constructor(private readonly artifacts: ArtifactStore) {}
  get activeBrowserCount(): number {
    return this.#activeBrowsers;
  }
  async render(request: BrowserRenderRequest): Promise<readonly BrowserViewportResult[]> {
    const browser = await chromium.launch({ headless: true });
    this.#activeBrowsers++;
    try {
      const results: BrowserViewportResult[] = [];
      for (const viewport of request.viewports) {
        const started = Date.now();
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
        });
        try {
          const page = await context.newPage();
          const runtimeErrors: string[] = [];
          const consoleErrors: string[] = [];
          const failedResources: string[] = [];
          page.on("pageerror", (error) => runtimeErrors.push(error.message));
          page.on("console", (message) => {
            if (message.type() === "error") consoleErrors.push(message.text());
          });
          page.on("requestfailed", (failed) =>
            failedResources.push(`${failed.url()} ${failed.failure()?.errorText ?? "failed"}`),
          );
          await page.goto(request.url, { waitUntil: "networkidle", timeout: 15_000 });
          const observation = await page.evaluate(() => {
            const selector = (element: Element): string => {
              if (element.id) return `#${element.id}`;
              const name = element.tagName.toLowerCase();
              const classes = [...element.classList].slice(0, 2).join(".");
              return classes ? `${name}.${classes}` : name;
            };
            const meaningful = [
              ...document.querySelectorAll(
                "main,header,nav,section,article,h1,h2,h3,p,a,button,img,form,input,table",
              ),
            ]
              .filter((element) => {
                const box = element.getBoundingClientRect();
                const style = getComputedStyle(element);
                return box.width > 0 && box.height > 0 && style.display !== "none";
              })
              .slice(0, 250)
              .map((element) => {
                const box = element.getBoundingClientRect();
                const style = getComputedStyle(element);
                return {
                  selector: selector(element),
                  tag: element.tagName.toLowerCase(),
                  text: (element.textContent ?? "").trim().slice(0, 80),
                  left: box.left,
                  right: box.right,
                  top: box.top,
                  bottom: box.bottom,
                  clientWidth: (element as HTMLElement).clientWidth,
                  scrollWidth: (element as HTMLElement).scrollWidth,
                  clientHeight: (element as HTMLElement).clientHeight,
                  scrollHeight: (element as HTMLElement).scrollHeight,
                  fontSize: Number.parseFloat(style.fontSize) || 0,
                  opacity: Number.parseFloat(style.opacity) || 0,
                  visibility: style.visibility,
                  overflow: style.overflow,
                } satisfies ElementObservation;
              });
            return {
              documentWidth: document.documentElement.scrollWidth,
              documentHeight: document.documentElement.scrollHeight,
              brokenImages: [...document.images]
                .filter((image) => image.complete && image.naturalWidth === 0)
                .map((image) => image.currentSrc || image.src),
              elements: meaningful,
            };
          });
          const bytes = await page.screenshot({ fullPage: true, type: "png" });
          const artifactRef = `${request.artifactPrefix}/${viewport.name.toLowerCase()}.png`;
          await this.artifacts.put(artifactRef, bytes, {
            kind: "SCREENSHOT",
            contentType: "image/png",
          });
          results.push({
            viewport,
            ...observation,
            screenshot: {
              viewport: viewport.name,
              width: viewport.width,
              height: viewport.height,
              artifactRef,
              capturedAt: new Date(),
              pageUrl: request.url,
              contentHash: createHash("sha256").update(bytes).digest("hex"),
            },
            runtimeErrors,
            consoleErrors,
            failedResources,
            renderDurationMs: Date.now() - started,
          });
        } finally {
          await context.close();
        }
      }
      return results;
    } finally {
      await browser.close();
      this.#activeBrowsers--;
    }
  }
}
