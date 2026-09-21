import {
  createBrowserQACheckResult,
  type BrowserQACheckResult,
  type BrowserQAEvidence,
} from "./browser-qa-domain.js";
import type { BrowserQACheckExecutor } from "./browser-qa-runner.js";

const result = (
  context: Parameters<BrowserQACheckExecutor["execute"]>[0],
  input: Omit<BrowserQACheckResult, "route" | "viewport">,
): BrowserQACheckResult =>
  createBrowserQACheckResult({
    ...input,
    route: context.route,
    viewport: context.viewport,
  });

const definition = (
  checkId: string,
  category: BrowserQACheckResult["category"],
  defaultSeverity: BrowserQACheckResult["severity"],
  timeoutMs: number,
) => ({ checkId, version: 1, category, defaultSeverity, scope: "PAGE" as const, timeoutMs });

export const browserQACoreCheckExecutors: readonly BrowserQACheckExecutor[] = [
  {
    definition: definition("runtime.page-error", "RUNTIME", "ERROR", 1_000),
    async execute(context) {
      const errors = context.events.pageErrors;
      return result(context, errors.length
        ? {
            checkId: "runtime.page-error",
            category: "RUNTIME",
            status: "FAIL",
            severity: "ERROR",
            message: `${errors.length} uncaught page error${errors.length === 1 ? "" : "s"}`,
            evidence: errors.map((message): BrowserQAEvidence => ({ type: "console", level: "pageerror", message })),
          }
        : {
            checkId: "runtime.page-error",
            category: "RUNTIME",
            status: "PASS",
            severity: "ERROR",
            message: "No uncaught page errors",
          });
    },
  },
  {
    definition: definition("runtime.console-error", "CONSOLE", "ERROR", 1_000),
    async execute(context) {
      const errors = context.events.consoleErrors;
      if (errors.length)
        return result(context, {
          checkId: "runtime.console-error",
          category: "CONSOLE",
          status: "FAIL",
          severity: "ERROR",
          message: `${errors.length} console error${errors.length === 1 ? "" : "s"}`,
          evidence: errors,
        });
      if (context.events.consoleWarnings.length)
        return result(context, {
          checkId: "runtime.console-error",
          category: "CONSOLE",
          status: "WARNING",
          severity: "WARNING",
          message: `${context.events.consoleWarnings.length} console warning${context.events.consoleWarnings.length === 1 ? "" : "s"}`,
          evidence: context.events.consoleWarnings,
        });
      return result(context, {
        checkId: "runtime.console-error",
        category: "CONSOLE",
        status: "PASS",
        severity: "ERROR",
        message: "No console errors or warnings",
      });
    },
  },
  {
    definition: definition("network.failed-request", "NETWORK", "ERROR", 1_000),
    async execute(context) {
      const critical = [...context.events.failedRequests, ...context.events.badResponses].filter((e) => {
        if (e.type !== "network") return false;
        return ["document", "script", "stylesheet", "fetch", "xhr", "font"].includes(e.resourceType ?? "") || e.status === undefined;
      });
      if (context.events.blockedRequests.length)
        return result(context, {
          checkId: "network.failed-request",
          category: "NETWORK",
          status: "FAIL",
          severity: "ERROR",
          message: "Unexpected external network activity was blocked",
          evidence: [...context.events.blockedRequests, ...critical],
        });
      if (critical.length)
        return result(context, {
          checkId: "network.failed-request",
          category: "NETWORK",
          status: "FAIL",
          severity: "ERROR",
          message: `${critical.length} required browser resource request${critical.length === 1 ? "" : "s"} failed`,
          evidence: critical,
        });
      const optional = [...context.events.failedRequests, ...context.events.badResponses];
      if (optional.length)
        return result(context, {
          checkId: "network.failed-request",
          category: "NETWORK",
          status: "WARNING",
          severity: "WARNING",
          message: `${optional.length} optional browser resource request${optional.length === 1 ? "" : "s"} failed`,
          evidence: optional,
        });
      return result(context, {
        checkId: "network.failed-request",
        category: "NETWORK",
        status: "PASS",
        severity: "ERROR",
        message: "No failed required browser requests",
      });
    },
  },
  {
    definition: definition("route.load", "ROUTING", "ERROR", 5_000),
    async execute(context) {
      const state = await context.page.evaluate(() => ({
        ready: document.readyState,
        root: Boolean(document.querySelector("#root, [data-sites-page]")),
      }));
      return result(context, state.ready === "loading" || !state.root
        ? {
            checkId: "route.load",
            category: "ROUTING",
            status: "FAIL",
            severity: "ERROR",
            message: "Route did not expose a ready Sites root/page marker",
          }
        : {
            checkId: "route.load",
            category: "ROUTING",
            status: "PASS",
            severity: "ERROR",
            message: "Route loaded and exposed a Sites root/page marker",
          });
    },
  },
  {
    definition: definition("internal-links", "ROUTING", "ERROR", 3_000),
    async execute(context) {
      const findings = await context.page.evaluate(() => {
        const links = [...document.querySelectorAll<HTMLAnchorElement>("a[href]")];
        const issues: string[] = [];
        for (const link of links) {
          const href = link.getAttribute("href")?.trim() ?? "";
          if (!href) {
            issues.push("empty href");
            continue;
          }
          if (/^(?:javascript|data):/i.test(href)) issues.push(`unsafe scheme: ${href.slice(0, 120)}`);
          if (href.startsWith("#") && href.length > 1 && !document.getElementById(href.slice(1)))
            issues.push(`missing fragment target: ${href.slice(0, 120)}`);
          if (href.startsWith("/") && href.startsWith("//")) issues.push(`protocol-relative link: ${href.slice(0, 120)}`);
        }
        return issues.slice(0, 50);
      });
      return result(context, findings.length
        ? {
            checkId: "internal-links",
            category: "ROUTING",
            status: "FAIL",
            severity: "ERROR",
            message: `${findings.length} invalid internal link finding${findings.length === 1 ? "" : "s"}`,
            evidence: findings.map((message): BrowserQAEvidence => ({ type: "element", locatorDescription: "a[href]", accessibleName: message })),
          }
        : {
            checkId: "internal-links",
            category: "ROUTING",
            status: "PASS",
            severity: "ERROR",
            message: "Internal links use supported schemes and available fragments",
          });
    },
  },
];
