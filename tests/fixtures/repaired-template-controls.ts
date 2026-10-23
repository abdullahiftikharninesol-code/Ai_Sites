import { join } from "node:path";
import { chromium, expect } from "playwright/test";
import { BROWSER_QA_VIEWPORTS } from "../../src/browser-qa/browser-qa-domain.js";

/** Exercise actual React controls, including StrictMode's effect cleanup. No AI. */
export async function verifyRepairedTemplateControls(key: string, url: string, proof: string) {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const viewport of BROWSER_QA_VIEWPORTS) {
      const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      if (key === "creative-agency") {
        // Reproduce the browser API return that made the old concise effect invalid.
        await page.addInitScript(() => {
          const scroll = window.scrollTo.bind(window);
          Object.assign(window, { templateScrollCalls: 0 });
          Object.defineProperty(window, "scrollTo", { configurable: true, value: (options?: ScrollToOptions | number, y?: number) => {
            Object.assign(window, { templateScrollCalls: (window as unknown as { templateScrollCalls: number }).templateScrollCalls + 1 });
            if (typeof options === "number") scroll(options, y ?? 0);
            else scroll(options);
            return Promise.resolve();
          } });
        });
        await page.goto(url, { waitUntil: "networkidle" });
        for (const route of ["/work", "/services", "/about", "/contact"]) {
          const menu = page.getByRole("button", { name: "Menu", exact: true });
          if (await menu.isVisible()) await menu.click();
          await page.locator(`a[href="${route}"]:visible`).first().click();
          await expect(page).toHaveURL(new URL(route, url).href);
          await expect(page.locator("main h1")).toBeVisible();
        }
        expect(await page.evaluate(() => (window as unknown as { templateScrollCalls: number }).templateScrollCalls)).toBeGreaterThan(4);
      } else if (key === "real-estate") {
        await page.goto(url, { waitUntil: "networkidle" });
        const stories = page.getByRole("button", { name: "Read story ↗", exact: true });
        const titles = ["At home in the Hudson Valley", "The architecture of retreat", "A collector’s guide to natural materials"];
        for (let index = 0; index < titles.length; index++) {
          await stories.nth(index).click();
          const dialog = page.getByRole("dialog");
          await expect(dialog).toHaveAccessibleName(titles[index]!);
          await expect(dialog.locator("p").nth(1)).not.toBeEmpty();
          if (index === 0) await page.screenshot({ path: join(proof, `${key}-${viewport.id.toLowerCase()}-story.png`) });
          await dialog.getByRole("button", { name: "Close story" }).click();
          await expect(dialog).toHaveCount(0);
          await expect(stories.nth(index)).toBeFocused();
        }
        await stories.first().click();
        await page.getByRole("dialog").getByRole("link", { name: "Explore properties" }).click();
        await expect(page).toHaveURL(new URL("/properties", url).href);
        await expect(page.locator(".property-card")).toHaveCount(6);
      } else if (key === "healthcare-clinic") {
        await page.goto(url + "/services", { waitUntil: "networkidle" });
        const services = page.getByRole("button", { name: /^Read more about / });
        expect(await services.count()).toBe(6);
        for (let index = 0; index < 6; index++) {
          const title = (await services.nth(index).getAttribute("aria-label"))!.replace("Read more about ", "");
          await services.nth(index).click();
          const dialog = page.getByRole("dialog");
          await expect(dialog).toHaveAccessibleName(title);
          await expect(dialog.getByRole("heading", { name: "Planning your visit" })).toBeVisible();
          await expect(dialog.locator("li")).toHaveCount(3);
          if (index === 0) await page.screenshot({ path: join(proof, `${key}-${viewport.id.toLowerCase()}-service.png`) });
          await page.keyboard.press("Escape");
          await expect(dialog).toHaveCount(0);
          await expect(services.nth(index)).toBeFocused();
        }
        await page.goto(url + "/team", { waitUntil: "networkidle" });
        const biographies = page.locator(".team-grid button");
        for (let index = 0; index < 6; index++) {
          const name = await page.locator(".team-grid h2").nth(index).innerText();
          await biographies.nth(index).click();
          const dialog = page.getByRole("dialog");
          await expect(dialog).toHaveAccessibleName(name);
          await expect(dialog.locator("p").nth(1)).not.toBeEmpty();
          await dialog.getByRole("button", { name: "Close details" }).click();
        }
        await page.getByRole("button", { name: "See open roles" }).click();
        const careers = page.getByRole("dialog", { name: "Careers at Harbor Health" });
        await expect(careers).toContainText("No live vacancies are listed");
        await careers.getByRole("link", { name: "Contact our team" }).click();
        await expect(page).toHaveURL(new URL("/contact", url).href);
        await expect(page.getByRole("heading", { name: "Request an appointment" })).toBeVisible();
      }
      expect(errors).toEqual([]);
      await page.close();
    }
  } finally { await browser.close(); }
}
