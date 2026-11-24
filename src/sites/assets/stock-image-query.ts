import { createAssetIntent, type AssetIntent, type ResolvedAsset } from "./asset-domain.js";
import type { AssetResolutionContext, StockImageOrientation } from "./source-adapters.js";

/**
 * Turns an image intent plus the site's own words into a stock-photo search.
 * Deterministic and offline: no model call is spent on choosing photos.
 */

const STOPWORDS = new Set(`
a an the and or but of to in on at by for from with without into onto about as is are be been being it its this that these those
my our your their his her we you they i me us them who whom which what when where why how all any each every some such
create build make generate design develop add show display use using want need please can could would should will shall may might
website site web webpage page pages landing homepage home app application platform online portal
modern clean beautiful simple minimal minimalist professional responsive elegant stylish premium sleek bold fresh nice good great best
section sections hero banner cover header footer navigation nav menu button buttons form forms cta text copy content block blocks
image images photo photos photograph photographs picture pictures imagery visual visuals illustration illustrations gallery galleries
background backgrounds logo logos icon icons color colors colour colours style styles theme themes dark light layout layouts grid card cards
called named featuring feature features include includes including also like just very really more most new different another other better
brand brands company business official real actual stock placeholder placeholders storefront ecommerce commerce
change replace swap switch update refresh try pick choose find get set put place instead different
contact services service testimonial testimonials review reviews pricing faq blog team staff about portfolio products product shop store catalog
one two three four five six first second third main primary secondary top bottom left right full large small big
`.split(/\s+/).filter(Boolean));

/** Common site subjects; when present they make better searches than brand names. */
const SUBJECTS = new Set(`
travel tourism hotel resort hostel adventure hiking camping mountain mountains beach ocean sea lake forest nature safari cruise
restaurant cafe coffee bakery pizza sushi bar pub brewery winery wine cocktail food catering chef kitchen dessert tea juice burger
skincare beauty cosmetics makeup salon spa barber nail hair wellness massage fragrance perfume
fitness gym yoga pilates crossfit running cycling sports football soccer basketball tennis golf boxing martial
dental dentist clinic doctor medical health hospital pharmacy therapy therapist physiotherapy veterinary pet pets dog cat
law lawyer legal attorney accounting finance bank insurance consulting agency marketing startup saas software tech technology
real estate realestate property architecture interior furniture construction plumbing roofing cleaning landscaping garden gardening
fashion clothing apparel boutique jewelry shoes sneakers watches eyewear handbags
education school university tutoring course courses kids children daycare library
wedding photography photographer events music band concert festival art artist gallery museum theater film
automotive car cars vehicle dealership garage motorcycle bike bikes
florist flowers plants farm organic grocery market candles crafts handmade ceramics pottery
`.split(/\s+/).filter(Boolean));

const MAX_TERMS = 3;

/**
 * Topical search words from free text, in the user's order. Brand and place
 * names (capitalised mid-sentence) are left out: they rarely match stock
 * photos. Known site subjects are always kept within the term limit.
 */
export function stockSearchTerms(text = ""): string[] {
  const words: Array<{ word: string; index: number }> = [];
  let sentenceStart = true;
  for (const raw of text.normalize("NFKD").replace(/[̀-ͯ]/g, "").split(/\s+/)) {
    const startsSentence = sentenceStart;
    sentenceStart = /[.!?:]$/.test(raw);
    const properNoun = !startsSentence && /^[^a-z]*[A-Z]/.test(raw);
    for (const part of raw.replace(/[^A-Za-z-]/g, " ").split(/[\s-]+/)) {
      const word = part.toLowerCase();
      if (word.length < 3 || STOPWORDS.has(word) || (properNoun && !SUBJECTS.has(word))) continue;
      if (!words.some((item) => item.word === word)) words.push({ word, index: words.length });
    }
  }
  const subjects = words.filter(({ word }) => SUBJECTS.has(word));
  const chosen = [...subjects, ...words.filter(({ word }) => !SUBJECTS.has(word))].slice(0, MAX_TERMS);
  return chosen.sort((a, b) => a.index - b.index).map(({ word }) => word);
}

export interface StockQueryPlan {
  /** Most specific first; later queries are broader fallbacks when nothing suitable is found. */
  readonly queries: readonly string[];
  readonly orientation: StockImageOrientation;
  /** Provider rendition best suited to the placement. */
  readonly rendition: "large2x" | "large" | "portrait";
  readonly minShortSide: number;
}

/** Placements that suit stock photography; logos and brand marks never do. */
const ROLE_PLANS: Partial<Record<AssetIntent["role"], { readonly extra: string; readonly orientation: StockImageOrientation; readonly rendition: StockQueryPlan["rendition"]; readonly minShortSide: number }>> = {
  HERO: { extra: "", orientation: "landscape", rendition: "large2x", minShortSide: 600 },
  BACKGROUND: { extra: "", orientation: "landscape", rendition: "large2x", minShortSide: 600 },
  CONTENT: { extra: "", orientation: "landscape", rendition: "large", minShortSide: 400 },
  GALLERY: { extra: "", orientation: "landscape", rendition: "large", minShortSide: 400 },
  PRODUCT: { extra: "product", orientation: "square", rendition: "large", minShortSide: 400 },
  TEAM: { extra: "professional portrait", orientation: "portrait", rendition: "portrait", minShortSide: 400 },
  TESTIMONIAL: { extra: "smiling person portrait", orientation: "portrait", rendition: "portrait", minShortSide: 400 },
};

export function stockQueryForIntent(intent: AssetIntent, context: AssetResolutionContext = {}): StockQueryPlan | undefined {
  if (intent.mediaType !== "IMAGE") return undefined;
  const role = ROLE_PLANS[intent.role];
  if (!role) return undefined;
  const requested = stockSearchTerms(context.requestText);
  const site = stockSearchTerms(context.subjectText);
  const subject = requested.length ? requested : site;
  const ratio = intent.preferredAspectRatio;
  const orientation: StockImageOrientation = ratio
    ? ratio.width > ratio.height * 1.15 ? "landscape" : ratio.height > ratio.width * 1.15 ? "portrait" : "square"
    : role.orientation;
  // A query always carries subject words; the placement word alone ("product") is too generic.
  const query = (terms: readonly string[]) => terms.length ? [...terms, role.extra].filter(Boolean).join(" ").trim() : "";
  const queries = [
    query(subject),
    // Broader: the single strongest subject word, then the site's own subject.
    query(subject.slice(0, 1)),
    query(site.slice(0, 1)),
  ].filter((value, index, all) => value && all.indexOf(value) === index);
  return queries.length ? { queries, orientation, rendition: role.rendition, minShortSide: role.minShortSide } : undefined;
}

const ROLE_WORDS: ReadonlyArray<readonly [AssetIntent["role"], RegExp]> = [
  ["HERO", /\b(?:hero|banner|cover|header)\b/i],
  ["BACKGROUND", /\bbackground\b/i],
  ["GALLERY", /\b(?:gallery|galleries)\b/i],
  ["PRODUCT", /\bproducts?\b/i],
  ["TEAM", /\b(?:team|staff)\b/i],
  ["TESTIMONIAL", /\btestimonials?\b/i],
];
const IMAGE_NOUN = String.raw`(?:image|images|photo|photos|picture|pictures|imagery|hero|banner|background|gallery)`;
const REPLACE_REQUEST = [
  new RegExp(String.raw`\b(?:change|replace|swap|switch|update|refresh)\b[^.!?\n]{0,40}\b${IMAGE_NOUN}\b`, "i"),
  /\b(?:use|try|pick|choose|find|show|with|want)\s+(?:a\s+|an\s+|some\s+)?(?:different|new|another|other|better)\s+(?:[a-z]+\s+){0,2}?(?:image|photo|picture)s?\b/i,
];

/** Saved images an edit instruction asks to replace. Only stock photos and placeholders are ever swapped. */
export function requestedImageReplacements(instruction: string, assets: readonly ResolvedAsset[]): ResolvedAsset[] {
  if (!REPLACE_REQUEST.some((pattern) => pattern.test(instruction))) return [];
  const replaceable = assets.filter((asset) => asset.mediaType === "IMAGE" && (asset.sourceType === "STOCK" || asset.sourceType === "PLACEHOLDER") && ROLE_PLANS[asset.role]);
  const roles = ROLE_WORDS.filter(([, pattern]) => pattern.test(instruction)).map(([role]) => role);
  if (roles.length) return replaceable.filter((asset) => roles.includes(asset.role));
  // "Replace the placeholder images with real photos": every swappable image.
  if (replaceable.length === 1 || /\b(?:all|every|placeholders?)\b|\b(?:images|photos|pictures)\b/i.test(instruction)) return replaceable;
  const hero = replaceable.filter((asset) => asset.role === "HERO");
  return hero.length ? hero : replaceable.slice(0, 1);
}

/** A new intent for a replacement photo, under its own id so the saved one stays intact. */
export function replacementIntent(asset: ResolvedAsset, existingIds: ReadonlySet<string>): AssetIntent {
  const base = asset.logicalAssetId.replace(/-r\d+$/, "");
  let index = 2;
  while (existingIds.has(`${base}-r${index}`)) index += 1;
  const id = `${base}-r${index}`;
  const purpose = `Replacement for ${asset.logicalAssetId}: use this path wherever ${asset.publicPath ?? asset.logicalAssetId} is used`;
  return createAssetIntent({
    intentId: id,
    logicalAssetId: id,
    mediaType: "IMAGE",
    role: asset.role,
    purpose,
    description: asset.purpose ?? purpose,
    required: false,
    decorative: asset.decorative,
    altTextIntent: asset.altText ?? asset.purpose ?? purpose,
    sourcePreference: ["STOCK"],
  });
}
