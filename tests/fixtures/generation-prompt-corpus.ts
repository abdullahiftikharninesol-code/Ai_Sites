import type { FunctionalCapability } from "../../src/sites/generation/functional-capabilities.js";

export interface GenerationPromptCase {
  readonly name: string;
  readonly prompt: string;
  readonly required: readonly FunctionalCapability[];
  readonly excluded?: readonly FunctionalCapability[];
}
// These expectations are independent of the extractor, brands, layouts and
// generated source. They are requirements tests, not model-output snapshots.
export const generationPromptCorpus: readonly GenerationPromptCase[] = [
  { name: "personal portfolio", prompt: "Build an elegant photographer portfolio. Pages: Home, Biography, Selected Projects. No shopping cart.", required: [], excluded: ["cart"] },
  { name: "five-page agency", prompt: "Build a digital agency. Pages: Home, Services, Case Studies, About, Contact. Add service tabs, an FAQ accordion, category filters, project detail modal, contact form and mobile navigation.", required: ["tabs", "accordion", "category-filter", "dialog", "form", "mobile-nav"] },
  { name: "multipage ecommerce", prompt: "Build a clothing storefront. Pages: Home, Shop, Product Detail. Include shopping cart, quantity controls, size selection, product gallery, category filters and product search.", required: ["cart", "quantity", "size", "gallery", "category-filter", "product-navigation", "search"] },
  { name: "restaurant", prompt: "Build a restaurant with working category filters for its dishes, menu tabs and mobile navigation. Pages: Home, Seasonal Menu, Our Story.", required: ["category-filter", "tabs", "mobile-nav"] },
  { name: "corporate consulting", prompt: "Build a corporate consultancy. Pages: Home, Expertise, Our Firm, Contact. Include a contact form with honest demo feedback. No newsletter.", required: ["form"], excluded: ["newsletter"] },
  { name: "SaaS product", prompt: "Build a SaaS product website with pricing tabs, FAQ accordion and newsletter. Pages: Home, Features, Pricing.", required: ["tabs", "accordion", "newsletter"] },
  { name: "education", prompt: "Create an educational course catalog with search, category filters and a course detail modal. Pages: Home, Courses, Instructors.", required: ["search", "category-filter", "dialog"] },
  { name: "real estate", prompt: "Create a real estate property directory with search, category filters, an interactive gallery and an inquiry form. Frontend mock data only.", required: ["search", "category-filter", "gallery", "form"] },
  { name: "editorial blog", prompt: "Create an editorial journal with searchable stories and newsletter demo feedback. Pages: Home, Stories, Contributors.", required: ["search", "newsletter"] },
  { name: "healthcare information", prompt: "Create a healthcare information website. Include FAQ accordion and contact form. No shopping cart. No real payments.", required: ["accordion", "form"], excluded: ["cart"] },
  { name: "interactive dashboard", prompt: "Create an interactive analytics dashboard with search, metric tabs and a detail dialog. Use local sample data.", required: ["search", "tabs", "dialog"] },
  { name: "mixed museum and repair directory", prompt: "Build a museum of musical instruments with a repair directory. Include searchable exhibits, category filters, an FAQ accordion and a feedback form. Pages: Home, Instruments, Repair Collective.", required: ["search", "category-filter", "accordion", "form"] },
];
