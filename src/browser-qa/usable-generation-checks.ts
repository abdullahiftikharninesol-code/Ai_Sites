import type { BrowserQACheckExecutor, BrowserQAPageContext } from "./browser-qa-runner.js";
import { createBrowserQACheckResult, createBrowserQAReport, type BrowserQAReport } from "./browser-qa-domain.js";
import { FunctionalValidationError } from "./browser-qa-failure.js";
import { functionalPageSurface } from "./functional-surfaces.js";
import { mobileNavigationToggle } from "./mobile-navigation.js";
import { browserQACoreCheckExecutors } from "./browser-qa-core-checks.js";
import { browserQAResponsiveAndInteractionChecks } from "./browser-qa-interaction-checks.js";
import { browserQARuntimeChecks } from "./browser-qa-runtime-checks.js";
import { functionalBrowserChecks } from "./functional-capability-checks.js";
import type { ResolvedFunctionalContract } from "../sites/generation/functional-route-contract.js";

const advisoryChecks = new Set(["generation.requirement-advisories", "functional.requirements", "functional.navigation", "functional.controls", "interaction-smoke", "interaction.mobile-nav", "form-smoke", "responsive-overflow", "broken-images", "accessibility-smoke", "runtime.console-error"]);

/** Change acceptance, never erase a failed assertion or its diagnostic evidence. */
export function applyUsableGenerationReportPolicy(report: BrowserQAReport): BrowserQAReport {
  const checks = report.checks.map(check => {
    const unsafeLink = check.checkId === "internal-links" && check.evidence?.some(item => item.type === "element" && item.accessibleName?.startsWith("unsafe scheme:"));
    const minorLink = check.checkId === "internal-links" && !unsafeLink && check.failureKind !== "QA_INFRASTRUCTURE_FAILURE" && !!check.evidence?.length;
    const alertOnly = check.checkId === "browser-safety-events" && !!check.evidence?.length && check.evidence.every(item => item.type === "console");
    if (check.status === "FAIL" && (advisoryChecks.has(check.checkId) || minorLink || alertOnly))
      return createBrowserQACheckResult({ ...check, severity: "WARNING" });
    return check;
  });
  return createBrowserQAReport({ ...report, checks });
}

/** A real rendered body is required. Heading levels and semantic completeness
 * are independent from whether a usable page was actually rendered. */
export async function usablePageContent(context: BrowserQAPageContext): Promise<string> {
  const surface = await functionalPageSurface(context.page);
  const content = await surface.evaluate(element => {
    const visible = (node: Element) => !!node.getClientRects().length && !["hidden", "collapse"].includes(getComputedStyle(node).visibility) && getComputedStyle(node).opacity !== "0" && !node.closest('[hidden],[aria-hidden="true"]');
    const read = (node: Element): string => {
      if (!visible(node) || node.matches('header,footer,nav,[role="navigation"],script,style,button')) return "";
      return [...node.childNodes].map(child => child.nodeType === Node.TEXT_NODE ? child.textContent ?? "" : child instanceof Element ? read(child) : "").join(" ").replace(/\s+/g, " ").trim();
    };
    const media = [...element.querySelectorAll("img,svg,video,canvas")].filter(visible).map(node => node.getAttribute("src") ?? node.tagName);
    return { text: read(element), media };
  });
  if (!content.text && !content.media.length) throw new FunctionalValidationError("Generated page is blank or contains only navigation/controls");
  return JSON.stringify(content);
}

const result = (context: BrowserQAPageContext, checkId: string, message: string) => createBrowserQACheckResult({ checkId, category: "ROUTING", status: "PASS", severity: "ERROR", route: context.route, viewport: context.viewport, message });
const primaryLinks = (context: BrowserQAPageContext) => context.page.locator(':is(header,[role="banner"],nav,[role="navigation"]) a[href]:not(:is(footer,[role="contentinfo"],article) a)').filter({ visible: true });

async function revealPrimaryNavigation(context: BrowserQAPageContext): Promise<void> {
  const menu = await mobileNavigationToggle(context.page);
  if (!menu) return;
  const wasOpen = await menu.getAttribute("aria-expanded") === "true";
  if (!wasOpen) {
    // Missing/broken optional menu controls are advisory. Still discover and
    // follow any destinations that can actually be exposed by a normal click.
    try { await menu.click({ timeout: 800 }); }
    catch (error) { if (!(error instanceof Error) || error.name !== "TimeoutError") throw error; }
    await context.page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  }
}

export function usableGenerationChecks(contract?: ResolvedFunctionalContract, hasAssets = false, additional: readonly BrowserQACheckExecutor[] = []): readonly BrowserQACheckExecutor[] {
  const behavior = functionalBrowserChecks({ version: 1, capabilities: [], backendRequired: false, unsupportedTransactions: false }, contract?.actualRoutes ?? ["/"])[0]!;
  const checks: BrowserQACheckExecutor[] = [
    ...browserQACoreCheckExecutors,
    { definition: { checkId: "generation.meaningful-content", version: 1, category: "RUNTIME", defaultSeverity: "ERROR", scope: "PAGE", timeoutMs: 3000 }, execute: async context => { await usablePageContent(context); return result(context, "generation.meaningful-content", "Generated page contains visible content"); } },
    { definition: { checkId: "generation.primary-navigation", version: 1, category: "INTERACTION", defaultSeverity: "ERROR", scope: "PAGE", timeoutMs: 12000 },
      appliesTo: route => route === "/",
      execute: async context => {
        const start = context.page.url(), origin = new URL(start).origin;
        if (contract?.actualRoutes.length && !contract.actualRoutes.includes("/")) throw new FunctionalValidationError("The initial preview route / is not implemented");
        const original = await usablePageContent(context);
        await revealPrimaryNavigation(context);
        const hrefs = [...new Set(await primaryLinks(context).evaluateAll(links => links.map(link => link.getAttribute("href") ?? "")))];
        const destinations = hrefs.filter(href => !/^(?:mailto:|tel:|https?:\/\/)/i.test(href) || new URL(href, start).origin === origin);
        for (const href of destinations.slice(0, 12)) {
          if (!href.trim() || /^(?:#|javascript:|data:)/i.test(href) && (href === "#" || !href.startsWith("#"))) throw new FunctionalValidationError("Primary navigation has an empty or unsafe destination");
          const target = new URL(href, start);
          if (target.origin !== origin) continue;
          await context.page.goto(start, { waitUntil: "load", timeout: 4000 });
          const find = async () => {
            for (const candidate of await primaryLinks(context).all()) if (await candidate.getAttribute("href") === href) return candidate;
            return undefined;
          };
          let found = await find();
          if (!found) {
            await revealPrimaryNavigation(context);
            found = await find();
          }
          if (!found) throw new FunctionalValidationError("Primary navigation destination disappeared: " + href);
          await found.click({ timeout: 1500 });
          await context.page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
          const current = new URL(context.page.url());
          if (current.origin !== origin || current.pathname !== target.pathname) throw new FunctionalValidationError("Primary navigation did not reach " + href);
          if (target.hash) {
            const id = decodeURIComponent(target.hash.slice(1));
            if (!await context.page.locator('[id=' + JSON.stringify(id) + ']').isVisible()) throw new FunctionalValidationError("Primary navigation has a missing section: " + href);
          }
          const rendered = await usablePageContent(context);
          const known = contract?.actualRoutes.some(route => route === target.pathname || route.split('/').length === target.pathname.split('/').length && route.split('/').every((part, i) => part.startsWith(':') || part === target.pathname.split('/')[i]));
          if (target.pathname !== new URL(start).pathname && !known && rendered === original) throw new FunctionalValidationError("Primary navigation leads to an unimplemented page: " + href);
        }
        return result(context, "generation.primary-navigation", `Displayed primary navigation reaches working destinations (${Math.min(12, destinations.length)} checked${destinations.length > 12 ? "; additional links outside the bounded probe" : ""})`);
      } },
    ...additional,
    ...browserQAResponsiveAndInteractionChecks,
    ...browserQARuntimeChecks.filter(check => hasAssets || check.definition.checkId !== "broken-images"),
    behavior,
    { definition: { checkId: "generation.requirement-advisories", version: 1, category: "INTERACTION", defaultSeverity: "WARNING", scope: "PAGE", timeoutMs: 1000 }, appliesTo: route => route === "/", execute: context => Promise.resolve(createBrowserQACheckResult({ checkId: "generation.requirement-advisories", category: "INTERACTION", severity: "WARNING", status: contract?.advisories?.length ? "WARNING" : "SKIPPED", route: context.route, viewport: context.viewport, message: contract?.advisories?.length ? "Prompt requirement findings are advisory" : "No static requirement findings", evidence: contract?.advisories?.slice(0, 25).map(finding => ({ type: "element" as const, locatorDescription: finding.check, accessibleName: finding.message.slice(0, 1000) })) ?? [] })) },
  ];
  return checks.map(check => ({ ...check,
    ...(["network.failed-request", "browser-safety-events"].includes(check.definition.checkId) ? { afterInteractions: true } : {}),
  }));
}
