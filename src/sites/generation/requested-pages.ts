/** Explicit page declarations, not incidental words in feature descriptions. */
export interface RequestedPage { readonly id: string; readonly name: string; readonly path: string; readonly start: number; readonly end: number }
export const pageId = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const families: Readonly<Record<string, readonly string[]>> = {
  home: ["home", "homepage", "overview"], services: ["services", "service", "solutions"],
  portfolio: ["our-work", "work", "portfolio", "projects", "selected-work", "case-studies", "casestudies"],
  about: ["about", "about-us", "company"], contact: ["contact", "contact-us", "get-in-touch"],
  product: ["product", "product-detail", "product-details", "productdetail", "productpage"],
  faq: ["faq", "faqs", "questions"], team: ["team", "our-team"], pricing: ["pricing", "plans"],
  menu: ["menu"], resources: ["resources"], agents: ["agents"], integrations: ["integrations"],
  dentists: ["dentists"], properties: ["properties"], dashboard: ["dashboard"], gallery: ["gallery"],
};
export function pageFamily(name: string): string {
  const id = pageId(name.replace(/(?:Page|Screen|View)$/, "").replace(/([a-z])([A-Z])/g, "$1-$2").replace(/\s+page$/i, ""));
  return Object.entries(families).find(([, aliases]) => aliases.includes(id))?.[0] ?? id;
}
export function equivalentPage(a: string, b: string): boolean { return pageFamily(a) === pageFamily(b); }
const defaultPath = (name: string) => pageFamily(name) === "home" ? "/" : pageFamily(name) === "product" ? "/product" : `/${pageId(name)}`;

export function requestedPages(prompt: string): readonly RequestedPage[] {
  const found: { id: string; name: string; path: string; start: number; end: number }[] = [];
  const add = (name: string, start: number, end: number, path?: string) => {
    const clean = name.replace(/\s+(?:page|screen|view)$/i, "").trim();
    if (!clean || clean.length > 60 || !/^[\w &'/-]+$/.test(clean)) return;
    const id = pageId(clean);
    const earlier = found.find(page => page.id === id);
    if (earlier) { if (start >= 0) { earlier.start = start; earlier.end = end; } return; }
    found.push({ id, name: clean, path: path ?? defaultPath(clean), start, end });
  };
  const inline = /\b(?:required\s+|website\s+)?pages?\s*:\s*([^\n.;]+)/gi;
  for (const match of prompt.matchAll(inline)) {
    const list = match[1]!.split(/,|\s+and\s+/i);
    if (list.length < 2) continue;
    for (const item of list) {
      const clean = item.replace(/[*`]/g, "").trim();
      const route = /\((\/[^\s)]+)\)/.exec(clean)?.[1];
      add(clean.replace(/\s*\([^)]*\)/, ""), -1, -1, route);
    }
  }
  const lines = [...prompt.matchAll(/[^\n]*\n|[^\n]+$/g)];
  let active: typeof found[number] | undefined, pagesBlock = false;
  for (const line of lines) {
    const raw = line[0].trim();
    const text = raw.replace(/^#{1,6}\s*/, "").replace(/^[*-]\s+|^\d+[.)]\s+/, "").replace(/\*\*|__|`/g, "").trim();
    if (/^(?:\d+[.)]\s*)?(?:required\s+|website\s+)?pages\s*:?$/i.test(text)) { pagesBlock = true; continue; }
    if (/^(?:global|shared|site-wide|interactive functionality|functional requirements|design|technical requirements|website functionality)\b/i.test(text)) {
      if (active) active.end = line.index;
      active = undefined; pagesBlock = false; continue;
    }
    const name = text.replace(/\s*\(\/[^)]*\)/, "").replace(/\s+(?:page|screen|view)\s*:?$/i, "").replace(/:$/, "");
    const known = Object.values(families).flat().includes(pageId(name));
    const decorated = /^#{1,6}\s|^\*\*[^*]+\*\*\s*:?$|^\d+[.)]\s/.test(raw);
    const header = known && !/^[-*]\s/.test(raw) || pagesBlock && decorated && !/^#{1,2}\s/.test(raw) && /^[A-Z][\w &'-]{1,50}$/.test(name);
    if (header) {
      if (active) active.end = line.index;
      add(name, line.index, prompt.length, /\((\/[^\s)]+)\)/.exec(text)?.[1]);
      active = found.find(page => page.id === pageId(name));
    } else if (/^#{1,3}\s/.test(raw) || /^(?:global|shared|site-wide|interactive functionality|functional requirements)\b/i.test(text)) {
      if (active) active.end = line.index;
      active = undefined; pagesBlock = false;
    }
  }
  return found;
}
