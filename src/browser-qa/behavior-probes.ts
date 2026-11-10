import type { ElementHandle, Locator, Page } from "playwright";
import { FunctionalValidationError } from "./browser-qa-failure.js";
import { functionalPageSurface } from "./functional-surfaces.js";
import { evaluateCalculationFormula, type CalculationFormula } from "../sites/generation/calculation-formula.js";

/**
 * Reusable, evidence-based behavior probes (Phase 5).
 *
 * Every probe locates controls through roles, accessible names and DOM
 * relationships (never test IDs, class names or positions), derives the
 * expected outcome only from what the page itself states (an option's key and
 * direction, a filter's label, an item's name, an explicit formula), and acts
 * only when that expectation is objective. A contradiction is a
 * FunctionalValidationError (FAILED); anything that cannot be established is a
 * FunctionalCoverageLimit (limited coverage), never a guessed failure.
 */
export class FunctionalCoverageLimit extends Error {
  constructor(message: string) { super(message); this.name = "FunctionalCoverageLimit"; }
}
/** Frames: React/Vue updates land within a few frames; 12 frames (~200 ms) bounds a no-op action. */
export const BEHAVIOR_PROBE_LIMITS = Object.freeze({ maxActions: 16, maxChoicesPerControl: 6, maxControls: 4, settleFrames: 12, searchSettleFrames: 30, maxCollections: 6, maxUnchangedChoices: 3 });

type Surface = Page | Locator;
interface Item { readonly name: string; readonly text: string; readonly cells: readonly string[] }
const isPage = (surface: Surface): surface is Page => "goto" in surface;

const rootOf = async (surface: Surface): Promise<Locator> => isPage(surface) ? functionalPageSurface(surface) : surface;
const frame = (page: Page) => page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
const clip = (value: string, length = 60) => value.length > length ? `${value.slice(0, length - 1)}…` : value;
const list = (items: readonly string[], max = 4) => items.slice(0, max).map(item => JSON.stringify(clip(item, 40))).join(", ") + (items.length > max ? ", …" : "");
const norm = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ").trim();
const ALL_CHOICE = /^(?:all(?:\s+\w+)?|any|everything|show all|clear(?: all)?(?: filters?)?|reset(?: filters?)?|none)$/i;

/** Poll animation frames until `read()` differs from `before` (bounded); returns the last value. */
async function settle(page: Page, read: () => Promise<string>, before: string, frames: number = BEHAVIOR_PROBE_LIMITS.settleFrames): Promise<string> {
  let current = before;
  for (let attempt = 0; attempt < frames; attempt++) {
    await frame(page);
    current = await read();
    if (current !== before) { await frame(page); return read(); }
  }
  return current;
}

// ---------------------------------------------------------------------------
// Item collections (structure, not class names)
// ---------------------------------------------------------------------------

/** Repeated sibling elements that look like content items (cards, list items, rows). */
async function candidateCollections(surface: Surface): Promise<ElementHandle<Element>[]> {
  const root = await rootOf(surface);
  const handle = await root.evaluateHandle((root: Element) => {
    const visible = (element: Element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
    const excluded = (element: Element) => !!element.closest("nav,header,footer,aside,form,select,thead,dialog,[role=navigation],[role=dialog],[role=complementary],[role=tablist]");
    const scores = new Map<Element, number>();
    const consider = (container: Element | null) => {
      if (!container || !root.contains(container) || scores.has(container) || excluded(container)) return;
      const children = [...container.children].filter(child => !["SCRIPT", "STYLE", "TEMPLATE"].includes(child.tagName));
      if (children.length < 2) return;
      const counts = new Map<string, number>();
      for (const child of children) counts.set(child.tagName, (counts.get(child.tagName) ?? 0) + 1);
      const [tag, count] = [...counts].sort((a, b) => b[1] - a[1])[0]!;
      if (count < 2 || count < children.length * 0.6 || ["SECTION", "HEADER", "FOOTER", "NAV", "MAIN", "LABEL", "INPUT", "BUTTON", "OPTION", "FORM", "H1", "H2", "H3", "H4", "P"].includes(tag)) return;
      const alike = children.filter(child => child.tagName === tag);
      if (alike.filter(child => (child.textContent ?? "").trim()).length < 2) return;
      // A list of bare links is navigation, not content.
      if (alike.every(child => { const links = child.querySelectorAll("a"); return links.length === 1 && (links[0]!.textContent ?? "").trim() === (child.textContent ?? "").trim(); })) return;
      let score = alike.length;
      if (["UL", "OL", "TBODY"].includes(container.tagName) || ["list", "grid", "rowgroup", "table", "feed"].includes(container.getAttribute("role") ?? "")) score += 2;
      if (alike.every(child => child.tagName === "TR" || child.querySelector("h2,h3,h4,h5,h6,[role=heading]"))) score += 2;
      scores.set(container, score);
    };
    for (const element of root.querySelectorAll("ul,ol,tbody,[role=list],[role=grid],[role=rowgroup],[role=feed]")) consider(element);
    for (const heading of root.querySelectorAll("h2,h3,h4,h5,h6,[role=heading]")) {
      let current: Element = heading;
      for (let depth = 0; depth < 4 && current.parentElement && current !== root; depth++) { current = current.parentElement; consider(current.parentElement); }
    }
    // Innermost collections only: a wrapper around an item list is not itself the list.
    const usable = [...scores].filter(([container]) => [...container.children].filter(visible).length >= 2);
    return usable.filter(([container]) => !usable.some(([other]) => other !== container && container.contains(other)))
      .sort((a, b) => b[1] - a[1]).slice(0, 6).map(([container]) => container);
  });
  const properties = await handle.getProperties();
  const result: ElementHandle<Element>[] = [];
  for (const value of properties.values()) { const element = value.asElement(); if (element) result.push(element as ElementHandle<Element>); }
  await handle.dispose();
  return result.slice(0, BEHAVIOR_PROBE_LIMITS.maxCollections);
}

/** Visible items of one collection in DOM order; null once the container is detached. */
function readItems(container: ElementHandle<Element>): Promise<Item[] | null> {
  return container.evaluate((container: Element) => {
    if (!container.isConnected) return null;
    const visible = (element: Element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
    const text = (element: Element | null | undefined) => ((element as HTMLElement | null)?.innerText ?? element?.textContent ?? "").replace(/\s+/g, " ").trim();
    const children = [...container.children].filter(child => !["SCRIPT", "STYLE", "TEMPLATE"].includes(child.tagName));
    const counts = new Map<string, number>();
    for (const child of children) counts.set(child.tagName, (counts.get(child.tagName) ?? 0) + 1);
    const tag = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
    return children.filter(child => child.tagName === tag && visible(child)).map(child => {
      const all = text(child);
      const name = text(child.querySelector("h1,h2,h3,h4,h5,h6,[role=heading]")) || (child.tagName === "TR" ? text(child.querySelector("td,th")) : "") || text(child.querySelector("a,strong,b")) || all.slice(0, 60);
      return { name, text: all.slice(0, 400), cells: child.tagName === "TR" ? [...child.children].map(cell => text(cell)) : [] };
    }).filter(item => item.name);
  });
}
const snapshot = async (collections: readonly ElementHandle<Element>[]) => Promise.all(collections.map(readItems));
const fingerprint = (states: readonly (Item[] | null)[]) => JSON.stringify(states.map(items => items?.map(item => item.name) ?? null));

// ---------------------------------------------------------------------------
// Keys stated by the page
// ---------------------------------------------------------------------------

const AMOUNT = /(?:[$€£¥₹]|\b(?:USD|EUR|GBP|PKR|INR|AUD|CAD|Rs\.?)\s?)\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?|(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s?(?:USD|EUR|GBP|PKR|INR|AUD|CAD)\b/g;
export function amounts(text: string): number[] {
  const values = [...text.matchAll(AMOUNT)].map(match => Number((match[1] ?? match[3] ?? "").replace(/,/g, "") + "." + (match[2] ?? match[4] ?? "0")));
  return [...new Set(values.filter(Number.isFinite))];
}
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
function dates(text: string): number[] {
  const found = new Set<number>();
  for (const match of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) found.add(Date.UTC(+match[1]!, +match[2]! - 1, +match[3]!));
  for (const match of text.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/gi)) found.add(Date.UTC(+match[3]!, MONTHS.indexOf(match[1]!.toLowerCase()), +match[2]!));
  for (const match of text.matchAll(/\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+(\d{4})\b/gi)) found.add(Date.UTC(+match[3]!, MONTHS.indexOf(match[2]!.toLowerCase()), +match[1]!));
  return [...found];
}
const ratings = (text: string) => [...new Set([...text.matchAll(/(\d(?:\.\d)?)\s*(?:\/\s*5\b|out of 5\b|stars?\b|★)/gi)].map(match => Number(match[1])))];

type SortKey = "price" | "name" | "date" | "rating" | "column";
interface SortIntent { readonly key: SortKey; readonly direction: "asc" | "desc" }
/** Key and direction stated by an option label; undefined when the label does not state both. */
export function sortIntent(label: string): SortIntent | undefined {
  const text = label.toLowerCase();
  const az = /\ba\s*(?:-|–|—|to|→)\s*z\b/.test(text), za = /\bz\s*(?:-|–|—|to|→)\s*a\b/.test(text);
  const asc = az || /low(?:est)?\s*(?:-|–|—|to|→)\s*high|ascending|\basc\b|cheapest|\blowest\b|oldest|smallest|least expensive/.test(text);
  const desc = za || /high(?:est)?\s*(?:-|–|—|to|→)\s*low|descending|\bdesc\b|most expensive|\bhighest\b|newest|latest|most recent|largest|top[- ]rated|best[- ]rated/.test(text);
  if (asc === desc) return undefined;
  const key: SortKey | undefined = /price|cost|cheap|expensive/.test(text) ? "price" : /rating|rated|stars?\b/.test(text) ? "rating"
    : /newest|oldest|latest|recent|date/.test(text) ? "date" : /name|title|alphabet/.test(text) || az || za ? "name" : undefined;
  return key ? { key, direction: asc ? "asc" : "desc" } : undefined;
}
function keyOf(item: Item, key: SortKey, column?: number): number | string | undefined {
  if (key === "name") return item.name;
  if (key === "column") {
    const cell = item.cells[column ?? -1];
    if (cell === undefined) return undefined;
    const numeric = cell.replace(/[$€£¥₹,%\s]/g, "");
    return /^-?\d+(?:\.\d+)?$/.test(numeric) ? Number(numeric) : cell;
  }
  const values = key === "price" ? amounts(item.text) : key === "date" ? dates(item.text) : ratings(item.text);
  return values.length === 1 ? values[0] : undefined;
}
const compare = (a: number | string, b: number | string) => typeof a === "number" && typeof b === "number" ? a - b
  : String(a).localeCompare(String(b), undefined, { sensitivity: "base", numeric: true });
function ordering(items: readonly Item[], intent: SortIntent, column?: number): { readonly keys: (number | string)[]; readonly ordered: boolean } | undefined {
  const keys = items.map(item => keyOf(item, intent.key, column));
  if (keys.some(value => value === undefined) || items.length < 2) return undefined;
  const defined = keys as (number | string)[];
  if (intent.key === "column" && new Set(defined.map(value => typeof value)).size > 1) return undefined;
  const ordered = defined.every((value, index) => index === 0 || (intent.direction === "asc" ? compare(defined[index - 1]!, value) <= 0 : compare(defined[index - 1]!, value) >= 0));
  return { keys: defined, ordered };
}
const sameMembers = (a: readonly Item[], b: readonly Item[]) => JSON.stringify(a.map(item => item.name).sort()) === JSON.stringify(b.map(item => item.name).sort());
const describeOrder = (items: readonly Item[], keys: readonly (number | string)[]) => list(items.map((item, index) => typeof keys[index] === "number" && item.name !== String(keys[index]) ? `${item.name} (${keys[index]})` : item.name));

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

interface SortAction { readonly label: string; readonly intent?: SortIntent; readonly column?: number; readonly header?: Locator; apply(): Promise<void> }
async function sortActions(surface: Surface): Promise<SortAction[]> {
  const actions: SortAction[] = [];
  for (const select of await surface.getByRole("combobox").all()) {
    if (!(await select.isVisible()) || !(await select.isEnabled())) continue;
    const name = await select.evaluate(element => [(element as HTMLSelectElement).labels?.[0]?.textContent ?? "", element.getAttribute("aria-label") ?? ""].join(" "));
    const options = await select.locator("option").evaluateAll(options => options.map(option => ({ value: (option as HTMLOptionElement).value, text: option.textContent?.trim() ?? "" })));
    for (const option of options) {
      const intent = sortIntent(option.text) ?? (/\bsort|order\b/i.test(name) ? sortIntent(`${name} ${option.text}`) : undefined);
      if (intent) actions.push({ label: option.text, intent, apply: () => select.selectOption(option.value).then(() => undefined) });
    }
  }
  for (const button of await surface.getByRole("button").all()) {
    if (actions.length >= 12) break;
    if (!(await button.isVisible()) || await button.evaluate(element => !!element.closest("th"))) continue;
    const label = (await button.getAttribute("aria-label")) ?? (await button.innerText());
    const intent = sortIntent(label);
    if (intent) actions.push({ label, intent, apply: () => button.click({ timeout: 800 }) });
  }
  for (const header of await surface.locator("th").all()) {
    if (!(await header.isVisible())) continue;
    const control = header.getByRole("button");
    const sortable = await header.getAttribute("aria-sort") !== null || await control.count() > 0;
    if (!sortable) continue;
    const column = await header.evaluate(element => [...(element.parentElement?.children ?? [])].indexOf(element));
    const label = (await header.innerText()).trim();
    actions.push({ label: `column ${label}`, column, header, apply: async () => { await ((await control.count()) ? control.first() : header).click({ timeout: 800 }); } });
  }
  return actions;
}

export async function probeSorting(page: Page, surface: Surface = page): Promise<string> {
  const actions = (await sortActions(surface)).slice(0, BEHAVIOR_PROBE_LIMITS.maxChoicesPerControl);
  if (!actions.length) throw new FunctionalCoverageLimit("No sort control states an interpretable key and direction (e.g. price low to high, name A–Z)");
  const collections = await candidateCollections(surface);
  if (!collections.length) throw new FunctionalCoverageLimit("No item collection with at least two visible items was found to sort");
  const checked: string[] = [];
  let trivial = 0, undeterminable = 0;
  try {
    for (const action of actions) {
      const before = await snapshot(collections);
      await action.apply();
      await settle(page, async () => fingerprint(await snapshot(collections)), fingerprint(before));
      const after = await snapshot(collections);
      let intent = action.intent;
      if (action.header) {
        const state = await action.header.getAttribute("aria-sort");
        intent = state === "ascending" ? { key: "column", direction: "asc" } : state === "descending" ? { key: "column", direction: "desc" } : undefined;
        if (!intent) { undeterminable++; continue; }
      }
      // The collection this control acts on is the one whose order changed. When
      // nothing changed, it is identifiable only if exactly one collection has
      // readable keys for this option; otherwise no failure can be attributed.
      const indices = after.map((_, index) => index).filter(index => after[index] && before[index] && after[index].length >= 2);
      const changed = indices.filter(index => fingerprint([after[index]!]) !== fingerprint([before[index]!]));
      const readable = indices.filter(index => ordering(after[index]!, intent!, action.column));
      if (!changed.length && readable.length > 1) {
        if (readable.every(index => ordering(after[index]!, intent!, action.column)!.ordered)) trivial++; else undeterminable++;
        continue;
      }
      let verdict = false;
      for (const index of changed.length ? changed : readable) {
        const result = ordering(after[index]!, intent!, action.column);
        if (!result) continue;
        if (!sameMembers(before[index]!, after[index]!)) throw new FunctionalValidationError(`Sort "${clip(action.label)}" changed which items are shown instead of only their order: before ${list(before[index]!.map(item => item.name))}; after ${list(after[index]!.map(item => item.name))}`);
        if (!result.ordered) {
          const expected = after[index]!.map((item, position) => ({ item, key: result.keys[position]! })).sort((a, b) => intent!.direction === "asc" ? compare(a.key, b.key) : compare(b.key, a.key));
          throw new FunctionalValidationError(`Sort "${clip(action.label)}" does not order items by ${intent!.key} ${intent!.direction === "asc" ? "ascending" : "descending"}. Observed: ${describeOrder(after[index]!, result.keys)}; expected: ${describeOrder(expected.map(entry => entry.item), expected.map(entry => entry.key))}`);
        }
        if (changed.includes(index)) { checked.push(`"${clip(action.label, 40)}" reordered ${after[index]!.length} items by ${intent!.key}`); verdict = true; }
        else trivial++;
        break;
      }
      if (!verdict && !changed.length && !indices.some(index => ordering(after[index]!, intent!, action.column))) undeterminable++;
    }
  } finally { await Promise.all(collections.map(handle => handle.dispose())); }
  if (checked.length) return `Sorting verified: ${checked.join("; ")}`;
  if (trivial) throw new FunctionalCoverageLimit("Every interpretable sort option matched the existing order, so reordering could not be observed");
  throw new FunctionalCoverageLimit(`Item ${undeterminable ? "sort keys" : "collections"} could not be read unambiguously for the stated sort options`);
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

interface FilterChoice { readonly label: string; apply(): Promise<void>; reset?: () => Promise<void> }
async function insideAny(locator: Locator, containers: readonly ElementHandle<Element>[]): Promise<boolean> {
  const element = await locator.elementHandle({ timeout: 500 }).catch(() => null);
  if (!element) return true;
  try { for (const container of containers) if (await container.evaluate((container: Element, element: Element) => container.contains(element), element)) return true; return false; }
  finally { await element.dispose(); }
}
async function filterControls(surface: Surface, collections: readonly ElementHandle<Element>[]): Promise<FilterChoice[][]> {
  const groups: FilterChoice[][] = [];
  const cap = BEHAVIOR_PROBE_LIMITS.maxChoicesPerControl;
  for (const select of await surface.getByRole("combobox").all()) {
    if (!(await select.isVisible()) || !(await select.isEnabled())) continue;
    const name = await select.evaluate(element => [(element as HTMLSelectElement).labels?.[0]?.textContent ?? "", element.getAttribute("aria-label") ?? ""].join(" "));
    const options = await select.locator("option").evaluateAll(options => options.map(option => ({ value: (option as HTMLOptionElement).value, text: option.textContent?.trim() ?? "", disabled: (option as HTMLOptionElement).disabled })));
    if (/\bsort|order by\b/i.test(name) || options.some(option => sortIntent(option.text))) continue;
    const initial = await select.inputValue();
    const all = options.find(option => ALL_CHOICE.test(option.text) || option.value === "");
    const reset = () => select.selectOption(all?.value ?? initial).then(() => undefined);
    const choices = options.filter(option => option !== all && !option.disabled && option.value !== initial).slice(0, cap);
    if (choices.length) groups.push(choices.map(option => ({ label: option.text, apply: () => select.selectOption(option.value).then(() => undefined), reset })));
  }
  const checkboxes: FilterChoice[] = [];
  for (const box of await surface.getByRole("checkbox").all()) {
    if (checkboxes.length >= cap) break;
    if (!(await box.isVisible()) || !(await box.isEnabled()) || await box.isChecked() || await insideAny(box, collections)) continue;
    const label = await box.evaluate(element => ((element as HTMLInputElement).labels?.[0]?.textContent ?? element.getAttribute("aria-label") ?? "").trim());
    if (!label || /agree|terms|consent|subscribe|newsletter|remember|compar|select all/i.test(label)) continue;
    checkboxes.push({ label, apply: () => box.check({ timeout: 800 }), reset: () => box.uncheck({ timeout: 800 }) });
  }
  if (checkboxes.length) groups.push(checkboxes);
  const radios = new Map<string, Locator[]>();
  for (const radio of await surface.getByRole("radio").all()) {
    if (!(await radio.isVisible()) || !(await radio.isEnabled()) || await insideAny(radio, collections)) continue;
    const group = (await radio.getAttribute("name")) ?? "";
    radios.set(group, [...(radios.get(group) ?? []), radio]);
  }
  for (const members of radios.values()) {
    const labelled = await Promise.all(members.map(async radio => ({ radio, label: await radio.evaluate(element => ((element as HTMLInputElement).labels?.[0]?.textContent ?? element.getAttribute("aria-label") ?? "").trim()), checked: await radio.isChecked() })));
    const restore = labelled.find(entry => ALL_CHOICE.test(entry.label)) ?? labelled.find(entry => entry.checked);
    const choices = labelled.filter(entry => entry !== restore && !entry.checked && entry.label).slice(0, cap);
    if (choices.length) groups.push(choices.map(entry => ({ label: entry.label, apply: () => entry.radio.check({ timeout: 800 }), ...(restore ? { reset: () => restore.radio.check({ timeout: 800 }) } : {}) })));
  }
  const toggles: { button: Locator; label: string }[] = [];
  for (const button of await surface.locator("button[aria-pressed],[role=button][aria-pressed]").all()) {
    if (!(await button.isVisible()) || await insideAny(button, collections)) continue;
    const label = ((await button.getAttribute("aria-label")) ?? (await button.innerText())).trim();
    if (label && !sortIntent(label) && !/compar/i.test(label)) toggles.push({ button, label });
  }
  const allToggle = toggles.find(toggle => ALL_CHOICE.test(toggle.label));
  const toggleChoices = toggles.filter(toggle => toggle !== allToggle).slice(0, cap);
  if (toggleChoices.length) groups.push(toggleChoices.map(toggle => ({ label: toggle.label, apply: () => toggle.button.click({ timeout: 800 }),
    reset: () => (allToggle ?? toggle).button.click({ timeout: 800 }) })));
  return groups.slice(0, BEHAVIOR_PROBE_LIMITS.maxControls);
}
const subsetOf = (smaller: readonly Item[], larger: readonly Item[]) => {
  const remaining = new Map<string, number>();
  for (const item of larger) remaining.set(item.name, (remaining.get(item.name) ?? 0) + 1);
  return smaller.every(item => { const count = remaining.get(item.name) ?? 0; remaining.set(item.name, count - 1); return count > 0; });
};
const filterLabel = (label: string) => norm(label.replace(/\(\s*\d+\s*\)|\b\d+\s+(?:items?|results?)\b/gi, ""));

export async function probeFiltering(page: Page, surface: Surface = page): Promise<string> {
  const collections = await candidateCollections(surface);
  if (!collections.length) throw new FunctionalCoverageLimit("No item collection with at least two visible items was found to filter");
  const groups = await filterControls(surface, collections);
  if (!groups.length) throw new FunctionalCoverageLimit("No filter control (select, checkbox, radio or pressed-state button) was found outside the items");
  const verified: string[] = [], unchanged: string[] = [];
  let actions = 0, emptied = 0;
  try {
    const baseline = await snapshot(collections);
    for (const group of groups) for (const choice of group) {
      if (actions++ >= BEHAVIOR_PROBE_LIMITS.maxActions) break;
      const before = await snapshot(collections);
      await choice.apply();
      await settle(page, async () => fingerprint(await snapshot(collections)), fingerprint(before));
      const after = await snapshot(collections);
      const index = after.map((items, position) => ({ items, position })).filter(entry => entry.items && before[entry.position] && fingerprint([entry.items]) !== fingerprint([before[entry.position]!]))
        .sort((a, b) => (before[b.position]?.length ?? 0) - (before[a.position]?.length ?? 0))[0]?.position;
      if (index === undefined) unchanged.push(choice.label);
      else {
        const shown = after[index]!, all = before[index]!;
        if (!shown.length) emptied++;
        else if (shown.length < all.length && subsetOf(shown, all)) {
          // Relevance is asserted only when the label is visibly stated on some, but not all, items.
          const label = filterLabel(choice.label);
          const mentions = all.filter(item => label.length >= 3 && norm(item.text).includes(label));
          if (mentions.length && mentions.length < all.length) {
            const wrong = shown.filter(item => !norm(item.text).includes(label));
            if (wrong.length) throw new FunctionalValidationError(`Filter "${clip(choice.label)}" shows items that do not match it: ${list(wrong.map(item => item.name))}; expected only ${list(mentions.map(item => item.name))}`);
          }
          verified.push(`"${clip(choice.label, 40)}" narrowed ${all.length}→${shown.length} items`);
        }
      }
      if (choice.reset) {
        await choice.reset();
        if (index !== undefined) await settle(page, async () => fingerprint(await snapshot(collections)), fingerprint(after)); else await frame(page);
        const restored = await snapshot(collections);
        if (index !== undefined && baseline[index] && restored[index] && !sameMembers(restored[index], baseline[index]))
          throw new FunctionalValidationError(`Clearing filter "${clip(choice.label)}" does not restore the full item set: ${restored[index].length} of ${baseline[index].length} items shown`);
      }
      if (verified.length >= 2 || (!verified.length && !emptied && unchanged.length >= BEHAVIOR_PROBE_LIMITS.maxUnchangedChoices)) break;
    }
  } finally { await Promise.all(collections.map(handle => handle.dispose())); }
  if (verified.length) return `Filtering verified: ${verified.join("; ")}`;
  if (unchanged.length >= 2 && !emptied) throw new FunctionalValidationError(`Filter controls do not change the visible items: ${list(unchanged)}`);
  throw new FunctionalCoverageLimit(emptied ? "Filters only produced empty results, so matching items could not be confirmed" : "Too few filter choices were available to establish filtering behavior");
}

// ---------------------------------------------------------------------------
// Search (strengthens the existing "results change" probe)
// ---------------------------------------------------------------------------

/** A query taken from one visible item must keep that item visible; clearing restores all items. */
export async function probeSearchMatching(page: Page, surface: Surface, search: Locator): Promise<string> {
  await search.fill("");
  const collections = await candidateCollections(surface);
  try {
    const states = await snapshot(collections);
    const index = states.findIndex(items => (items?.length ?? 0) >= 3);
    if (index < 0) return "Search matching not asserted: no item list with three or more items";
    const items = states[index]!;
    let target: { item: Item; token: string } | undefined;
    for (const item of items) {
      const token = norm(item.name).split(" ").find(word => word.length >= 4 && /\p{L}/u.test(word) && items.filter(other => norm(other.text).includes(word)).length < items.length);
      if (token) { target = { item, token }; break; }
    }
    if (!target) return "Search matching not asserted: no distinctive word in item names";
    await search.fill(target.token);
    await settle(page, async () => fingerprint(await snapshot(collections)), fingerprint(states), BEHAVIOR_PROBE_LIMITS.searchSettleFrames);
    const body = norm(await (await rootOf(surface)).innerText());
    if (!body.includes(norm(target.item.name))) throw new FunctionalValidationError(`Searching "${target.token}" hides "${clip(target.item.name)}", whose name contains the query`);
    await search.fill("");
    await settle(page, async () => fingerprint(await snapshot(collections)), "", BEHAVIOR_PROBE_LIMITS.searchSettleFrames);
    const restored = await readItems(collections[index]!);
    if (restored && !sameMembers(restored, items)) throw new FunctionalValidationError(`Clearing the search does not restore all items: ${restored.length} of ${items.length} shown`);
    return `Search verified: "${target.token}" kept "${clip(target.item.name, 40)}" visible and clearing restored ${items.length} items`;
  } finally { await Promise.all(collections.map(handle => handle.dispose())); }
}

// ---------------------------------------------------------------------------
// Calculations
// ---------------------------------------------------------------------------

interface NumericInput { readonly locator: Locator; readonly name: string; readonly kind: "spinbutton" | "slider" }
async function numericInputs(surface: Surface): Promise<NumericInput[]> {
  const found: NumericInput[] = [];
  for (const kind of ["spinbutton", "slider"] as const) for (const locator of await surface.getByRole(kind).all()) {
    if (found.length >= 6 || !(await locator.isVisible()) || !(await locator.isEnabled())) continue;
    const name = await locator.evaluate(element => (element.getAttribute("aria-label") ?? (element as HTMLInputElement).labels?.[0]?.textContent ??
      (element.getAttribute("aria-labelledby") ?? "").split(/\s+/).map(id => document.getElementById(id)?.textContent ?? "").join(" ") ?? "").trim() || element.getAttribute("name") || "");
    found.push({ locator, name, kind });
  }
  return found;
}
async function setNumber(input: NumericInput, value: number): Promise<void> {
  if (input.kind === "spinbutton") { await input.locator.fill(String(value)); return; }
  await input.locator.evaluate((element: Element, value: number) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, String(value));
    element.dispatchEvent(new Event("input", { bubbles: true })); element.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}
async function nextValue(input: NumericInput, offset = 5): Promise<{ from: number; to: number }> {
  const bounds = await input.locator.evaluate(element => ({ value: (element as HTMLInputElement).value, min: (element as HTMLInputElement).min, max: (element as HTMLInputElement).max, step: (element as HTMLInputElement).step }));
  const step = Number(bounds.step) > 0 ? Number(bounds.step) : 1, min = bounds.min === "" ? -Infinity : Number(bounds.min), max = bounds.max === "" ? Infinity : Number(bounds.max);
  const from = bounds.value === "" ? (Number.isFinite(min) ? min : 1) : Number(bounds.value);
  const up = from + step * offset, down = from - step * offset;
  const to = up <= max ? up : down >= min ? down : from + step <= max ? from + step : from - step;
  return { from, to: Math.round(to * 1e6) / 1e6 };
}
const resultTexts = async (surface: Surface) => (await rootOf(surface)).evaluate((root: Element) => {
  const visible = (element: Element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
  const outputs = [...root.querySelectorAll("output,[role=status],[aria-live]:not([aria-live=off])")].filter(visible);
  return (outputs.length ? outputs : [root]).map(element => (element as HTMLElement).innerText).join(" | ");
});

export async function probeCalculation(page: Page, surface: Surface = page, formula?: CalculationFormula): Promise<string> {
  const inputs = await numericInputs(surface);
  if (!inputs.length) throw new FunctionalCoverageLimit("No numeric input (number field or slider) was found for the calculation");
  // Responsiveness: a result must visibly react to an input change.
  let responsive: string | undefined;
  for (const input of inputs.slice(0, 2)) {
    const { from, to } = await nextValue(input);
    const before = await resultTexts(surface);
    await setNumber(input, to);
    const after = await settle(page, () => resultTexts(surface), before);
    if (after !== before) { responsive = `${input.name || "input"} ${from}→${to}`; break; }
  }
  if (!responsive) throw new FunctionalValidationError(`Changing ${list(inputs.slice(0, 2).map(input => input.name || "a numeric input"))} does not update any visible result`);
  if (!formula) throw new FunctionalCoverageLimit(`The result responds to input changes (${responsive}); correctness was not asserted because no explicit formula was given`);
  // Correctness only against the user's explicit formula, bound to uniquely labelled inputs.
  const binding = new Map<string, NumericInput>();
  for (const variable of formula.variables) {
    const matches = inputs.filter(input => { const name = norm(input.name); return name === variable || name.split(" ").includes(variable) || (variable.includes(" ") && name.includes(variable)); });
    if (matches.length !== 1) throw new FunctionalCoverageLimit(`Formula variable "${variable}" has ${matches.length ? "several" : "no"} matching labelled inputs; correctness not asserted`);
    binding.set(variable, matches[0]!);
  }
  const resultLabel = formula.result;
  const readResult = async () => (await rootOf(surface)).evaluate((root: Element, label: string) => {
    const normalize = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ").trim();
    const numbers = (value: string) => [...value.matchAll(/-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?/g)].map(match => match[0].replace(/,/g, ""));
    const candidates = [...root.querySelectorAll("*")].filter(element => {
      const text = (element as HTMLElement).innerText ?? "";
      return element.getClientRects().length > 0 && text.length <= 120 && normalize(text).includes(label) && numbers(text.replace(new RegExp(label, "i"), "")).length > 0;
    });
    const deepest = candidates.filter(element => !candidates.some(other => other !== element && element.contains(other)));
    if (deepest.length !== 1) return { error: deepest.length ? "AMBIGUOUS" : "MISSING" };
    const values = numbers(((deepest[0] as HTMLElement).innerText).replace(new RegExp(label, "i"), ""));
    return values.length === 1 ? { value: values[0]! } : { error: "AMBIGUOUS" };
  }, resultLabel);
  const verified: string[] = [];
  for (const offset of [0, 2]) {
    const values: Record<string, number> = {};
    for (const [variable, input] of binding) {
      const value = offset ? (await nextValue(input, offset)).to : Number(await input.locator.inputValue() || "0");
      if (offset) await setNumber(input, value);
      values[variable] = value;
    }
    await frame(page); await frame(page);
    const observed = await readResult();
    if ("error" in observed) throw new FunctionalCoverageLimit(`The "${resultLabel}" result is ${observed.error === "MISSING" ? "not shown with a single number" : "ambiguous"}; correctness not asserted`);
    const expected = evaluateCalculationFormula(formula, values);
    if (expected === undefined) throw new FunctionalCoverageLimit("The stated formula could not be evaluated for the current inputs");
    const decimals = observed.value.split(".")[1]?.length ?? 0;
    const tolerance = 0.5 * 10 ** -decimals + Math.abs(expected) * 1e-9;
    const shown = Number(observed.value);
    const inputsText = Object.entries(values).map(([name, value]) => `${name}=${value}`).join(", ");
    if (Math.abs(shown - expected) > tolerance)
      throw new FunctionalValidationError(`"${resultLabel}" shows ${observed.value} for ${inputsText}; the stated rule ${resultLabel} = ${formula.expression.replace(/[{}]/g, "")} gives ${Math.round(expected * 1e6) / 1e6}`);
    verified.push(`${inputsText} → ${observed.value}`);
  }
  return `Calculation verified against the stated formula: ${verified.join("; ")}`;
}

// ---------------------------------------------------------------------------
// Multi-step workflows
// ---------------------------------------------------------------------------

const stepState = (root: Locator) => root.evaluate((root: Element) => {
  const visible = (element: Element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
  const key = (element: Element) => element.id || element.getAttribute("name") || element.getAttribute("aria-label") || ((element as HTMLInputElement).labels?.[0]?.textContent ?? "").trim();
  const indicator = /step\s*(\d+)\s*(?:of|\/)\s*(\d+)/i.exec((root as HTMLElement).innerText);
  return {
    fields: [...root.querySelectorAll("input:not([type=hidden]),select,textarea")].filter(visible).map(key).join("|"),
    headings: [...root.querySelectorAll("h1,h2,h3,h4,legend,[role=heading]")].filter(visible).map(element => element.textContent?.trim() ?? "").join("|"),
    current: [...root.querySelectorAll("[aria-current=step]")].map(element => element.textContent?.trim() ?? "").join("|"),
    step: indicator ? Number(indicator[1]) : null,
  };
});
const fieldValues = (root: Locator, keys: readonly string[]) => root.evaluate((root: Element, keys: readonly string[]) => {
  const key = (element: Element) => element.id || element.getAttribute("name") || element.getAttribute("aria-label") || ((element as HTMLInputElement).labels?.[0]?.textContent ?? "").trim();
  const fields = [...root.querySelectorAll("input,select,textarea")];
  return Object.fromEntries(keys.map(name => [name, (fields.find(field => key(field) === name) as HTMLInputElement | undefined)?.value ?? null]));
}, keys);
async function fillStep(root: Locator): Promise<Record<string, string>> {
  const filled: Record<string, string> = {};
  for (const field of await root.locator("input:not([type=hidden]),textarea,select").all()) {
    if (!(await field.isVisible()) || !(await field.isEnabled())) continue;
    const info = await field.evaluate(element => ({ tag: element.tagName, type: (element as HTMLInputElement).type, value: (element as HTMLInputElement).value, required: (element as HTMLInputElement).required || element.getAttribute("aria-required") === "true",
      key: element.id || element.getAttribute("name") || element.getAttribute("aria-label") || ((element as HTMLInputElement).labels?.[0]?.textContent ?? "").trim(), min: (element as HTMLInputElement).min }));
    if (info.tag === "SELECT") {
      if (!info.value) { const option = await field.locator("option").evaluateAll(options => options.map(option => option as HTMLOptionElement).find(option => !option.disabled && option.value)?.value); if (option) await field.selectOption(option); }
      continue;
    }
    if (["checkbox", "radio"].includes(info.type)) { if (info.required) await field.check({ timeout: 800 }); continue; }
    if (["submit", "button", "reset", "image", "file", "range", "color"].includes(info.type) || info.value) continue;
    const value = info.type === "email" ? "offline-qa@example.test" : info.type === "tel" ? "5550100" : info.type === "number" ? (info.min || "1") : info.type === "date" ? "2030-01-15"
      : info.type === "url" ? "https://example.test" : info.type === "time" ? "10:30" : "Offline QA";
    await field.fill(value);
    if (info.key && !["number", "date", "time"].includes(info.type)) filled[info.key] = value;
  }
  return filled;
}

export async function probeMultiStep(page: Page, surface: Surface = page): Promise<string> {
  const root = await rootOf(surface);
  const next = root.getByRole("button", { name: /^(?:next|continue)(?:\s+(?:step|to\b.*))?\s*(?:→|›|»)?$/i }).filter({ visible: true }).first();
  if (!(await next.count())) throw new FunctionalCoverageLimit("No visible Next/Continue control was found for the multi-step flow");
  const first = await stepState(root);
  const entered = await fillStep(root);
  const read = async () => JSON.stringify(await stepState(root));
  await next.click({ timeout: 800 });
  const second = JSON.parse(await settle(page, read, JSON.stringify(first), 30)) as typeof first;
  if (second.fields === first.fields && second.headings === first.headings && second.current === first.current && second.step === first.step) {
    const blocked = await root.locator('[role=alert],[aria-invalid="true"]').filter({ visible: true }).count();
    if (blocked) throw new FunctionalCoverageLimit("Next was blocked by validation that safe local input did not satisfy");
    throw new FunctionalValidationError("Next does not advance to a different step: the visible fields, headings and step indicator are unchanged");
  }
  if (first.step !== null && second.step !== null && second.step !== first.step + 1)
    throw new FunctionalValidationError(`Next moves the step indicator from ${first.step} to ${second.step} instead of ${first.step + 1}`);
  const back = root.getByRole("button", { name: /^(?:back|previous|prev)(?:\s+step)?\s*(?:←|‹|«)?$|^(?:←|‹|«)\s*(?:back|previous)$/i }).filter({ visible: true }).first();
  if (!(await back.count())) throw new FunctionalCoverageLimit("Next advances to a new step; no Back/Previous control was found to verify returning");
  await back.click({ timeout: 800 });
  const third = JSON.parse(await settle(page, read, JSON.stringify(second), 30)) as typeof first;
  if (third.fields !== first.fields || third.headings !== first.headings || (first.step !== null && third.step !== first.step))
    throw new FunctionalValidationError(`Back does not return to the previous step (expected fields ${clip(first.fields || "none")}, observed ${clip(third.fields || "none")})`);
  const keys = Object.keys(entered);
  const values = await fieldValues(root, keys);
  const lost = keys.filter(key => values[key] !== entered[key]);
  if (lost.length) throw new FunctionalValidationError(`Back loses values entered on the previous step: ${list(lost)}`);
  return `Multi-step verified: Next advanced${first.step !== null ? ` from step ${first.step} to ${second.step}` : ""}, Back returned with ${keys.length} entered value(s) preserved`;
}

// ---------------------------------------------------------------------------
// Selection and comparison
// ---------------------------------------------------------------------------

const ownerItemName = (control: Locator) => control.evaluate(element => {
  let current: Element | null = element.parentElement;
  for (let depth = 0; current && depth < 8; depth++, current = current.parentElement) {
    const heading = current.querySelector("h1,h2,h3,h4,h5,h6,[role=heading]");
    if (heading && current.parentElement && [...current.parentElement.children].filter(child => child.tagName === current!.tagName).length >= 2) return heading.textContent?.trim() ?? "";
    if (current.tagName === "TR") return current.querySelector("td,th")?.textContent?.trim() ?? "";
  }
  return "";
});
const selectionState = (control: Locator) => control.evaluate(element => [(element as HTMLInputElement).checked, element.getAttribute("aria-pressed"), element.getAttribute("aria-checked"), (element as HTMLElement).innerText ?? ""].join("|"));
async function comparisonView(root: Locator): Promise<Locator | undefined> {
  const named = root.page().locator('[role=region],[role=dialog],dialog,[role=complementary],aside,section,table,[role=table]').filter({ visible: true });
  for (const candidate of await named.all()) {
    const name = await candidate.evaluate(element => [element.getAttribute("aria-label") ?? "", ...(element.getAttribute("aria-labelledby") ?? "").split(/\s+/).map(id => document.getElementById(id)?.textContent ?? ""),
      element.querySelector("caption,h1,h2,h3,h4,[role=heading]")?.textContent ?? ""].join(" "));
    if (/compar/i.test(name)) return candidate;
  }
  return undefined;
}

export async function probeComparison(page: Page, surface: Surface = page): Promise<string> {
  const root = await rootOf(surface);
  const toggles: { control: Locator; item: string }[] = [];
  for (const control of [...await root.getByRole("checkbox", { name: /compar/i }).all(), ...await root.getByRole("button", { name: /compar/i }).all()]) {
    if (toggles.length >= 4 || !(await control.isVisible())) continue;
    const item = await ownerItemName(control);
    if (item && !toggles.some(toggle => toggle.item === item)) toggles.push({ control, item });
  }
  if (toggles.length < 2) throw new FunctionalCoverageLimit("Fewer than two per-item compare controls were found");
  const [a, b] = toggles as [typeof toggles[number], typeof toggles[number]];
  for (const toggle of [a, b]) {
    const before = await selectionState(toggle.control);
    await toggle.control.click({ timeout: 800 });
    const after = await settle(page, () => selectionState(toggle.control), before, 10);
    if (after === before) throw new FunctionalValidationError(`Compare control for "${clip(toggle.item)}" does not change its selection state`);
  }
  let view = await comparisonView(root);
  if (!view) {
    const trigger = page.getByRole("button", { name: /^(?:compare(?:\s*\(\d+\))?|compare (?:now|selected|items)|view comparison|show comparison)$/i }).filter({ visible: true }).first();
    if (await trigger.count()) { await trigger.click({ timeout: 800 }); await frame(page); view = await comparisonView(root); }
  }
  if (!view) throw new FunctionalCoverageLimit("Selection state changes, but no comparison view (a region, table or dialog named for comparison) could be identified");
  const text = norm(await view.innerText());
  const missing = [a, b].filter(toggle => !text.includes(norm(toggle.item))).map(toggle => toggle.item);
  if (missing.length) throw new FunctionalValidationError(`The comparison view does not show the selected item(s) ${list(missing)}`);
  const unselected = toggles.slice(2).map(toggle => toggle.item).filter(item => text.includes(norm(item)));
  if (unselected.length) throw new FunctionalValidationError(`The comparison view shows unselected item(s) ${list(unselected)}`);
  await a.control.click({ timeout: 800 });
  await frame(page); await frame(page);
  if (await view.isVisible().catch(() => false) && norm(await view.innerText()).includes(norm(a.item)))
    throw new FunctionalValidationError(`Deselected item "${clip(a.item)}" remains in the comparison view`);
  return `Comparison verified: selecting ${list([a.item, b.item])} showed them in the comparison view; deselecting removed "${clip(a.item, 40)}"`;
}

// ---------------------------------------------------------------------------
// Cart totals (used by the existing cart probe)
// ---------------------------------------------------------------------------

/** The single price stated in the smallest region around an Add to Cart control, if unambiguous. */
export async function statedUnitPrice(control: Locator): Promise<number | undefined> {
  const texts = await control.evaluate(element => {
    const out: string[] = [];
    for (let current = element.parentElement; current && current.tagName !== "BODY"; current = current.parentElement) {
      out.push((current).innerText ?? "");
      if (current.tagName === "MAIN") break;
    }
    return out;
  });
  for (const text of texts) {
    const values = amounts(text);
    if (values.length === 1) return values[0];
    if (values.length > 1) return undefined;
  }
  return undefined;
}
/** Subtotal (or a lone total with no tax/shipping/discount lines) must equal unit price × quantity. */
export async function verifyCartTotal(panel: Locator, unitPrice: number, quantity: number): Promise<string> {
  const found = await panel.evaluate((panel: Element) => {
    const lines = [...panel.querySelectorAll("*")].filter(element => element.getClientRects().length > 0).map(element => ({ element, text: ((element as HTMLElement).innerText ?? "").replace(/\s+/g, " ").trim() }))
      .filter(entry => entry.text.length <= 80 && /\b(?:sub-?total|total)\b/i.test(entry.text) && /\d/.test(entry.text));
    const deepest = lines.filter(entry => !lines.some(other => other !== entry && entry.element.contains(other.element)));
    return { lines: deepest.map(entry => entry.text), adjustments: /\b(?:tax|vat|shipping|delivery|discount|fee|coupon)\b/i.test((panel as HTMLElement).innerText ?? "") };
  });
  const subtotal = found.lines.filter(text => /sub-?total/i.test(text));
  const candidates = subtotal.length ? subtotal : found.adjustments ? [] : found.lines;
  if (candidates.length !== 1) return "cart total not asserted (no single unambiguous subtotal)";
  const values = amounts(candidates[0]!);
  if (values.length !== 1) return "cart total not asserted (subtotal has no single stated amount)";
  const expected = Math.round(unitPrice * quantity * 100) / 100;
  if (Math.abs(values[0]! - expected) > 0.005)
    throw new FunctionalValidationError(`Cart shows "${clip(candidates[0]!)}" but the stated unit price ${unitPrice} × quantity ${quantity} = ${expected}`);
  return `cart subtotal ${expected} = ${unitPrice} × ${quantity}`;
}
