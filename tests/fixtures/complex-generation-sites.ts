import type { SiteCoderFileBundle } from "../../src/cli/runtime/site-coder-file-bundle.js";
import { functionalFixtures, ecommercePrompt } from "./functional-generation-sites.js";
import { recoverFunctionalPlaceholders } from "../../src/sites/generation/functional-recovery.js";

export interface ComplexFixture { readonly id: string; readonly prompt: string; readonly bundle: SiteCoderFileBundle }
const variants = [
  ["portfolio", "Cobalt Photography", "Selected Work", "/studio/work", "dialog"],
  ["agency", "Signal Engineering", "Solutions", "/company/solutions", "tabs, accordion, contact form, dialog"],
  ["saas", "Task Harbor", "Workspace", "/workspace", "tabs, search, dialog"],
  ["education", "Open Learning", "Course Catalog", "/academy/courses", "category filters, search, dialog"],
  ["restaurant", "Juniper Kitchen", "Seasonal Menu", "/dining/menu", "tabs, category filters, accordion"],
  ["directory", "Local Collective", "Directory", "/community/directory", "category filters, search, contact form"],
  ["dashboard", "Field Metrics", "Analytics", "/app/analytics", "tabs, search, dialog"],
  ["mixed", "Museum Workshop", "Learning Lab", "/museum/learning", "tabs, category filters, search, dialog, accordion, contact form, newsletter"],
] as const;
export function complexFixture(id: string, brokenDialog = false): ComplexFixture {
  const row = variants.find(row => row[0] === id); if (!row) throw new Error("Unknown test fixture");
  const [, brand, page, route, features] = row;
  const prompt = `${id === "mixed" ? "Use an editorial grid with readable text and consistent spacing.\n".repeat(120) : ""}Build a complete ${id} website for ${brand}.\n## Page 1 — Home\nBrand overview and clear navigation.\n## Page 2 — ${page} (${route})\nImplement working ${features}. Use meaningful local sample records and details.\n## Global Requirements\nResponsive mobile menu and valid internal navigation. Frontend mock data only. No real payments.`;
  const content = `import {useState} from "react";
import {MobileNav,Tabs,Accordion,DemoDialog,DemoForm,CategoryFilter,useProductFilter,ProductSearch,NewsletterSignup} from "./sites-ui/functional";
import "./styles.css";
const pages=[{label:"Home",href:"/"},{label:${JSON.stringify(page)},href:${JSON.stringify(route)}}];
const records=[{id:"coast",name:"Coastal research",category:"Research"},{id:"forest",name:"Forest workshop",category:"Learning"},{id:"river",name:"River archive",category:"Research"}];
function Catalog(){const filter=useProductFilter(records);return <section><h2>Browse the collection</h2><CategoryFilter options={filter.categories} value={filter.category} onChange={filter.setCategory}/><div>{filter.visible.map(item=><article key={item.id} data-product-id={item.id}><h3>{item.name}</h3><p>{item.category} with useful local information and practical next steps.</p></article>)}</div></section>}
function RecordDialog(){const[open,setOpen]=useState(false);return <section><button aria-haspopup="dialog" onClick={()=>setOpen(true)}><h3>Coastal research</h3><p>A complete local case study with delivery details.</p></button>{open&&<div role="dialog" aria-modal="true" aria-label="Coastal research details"><h2>Coastal research</h2><p>A practical demonstration of research, delivery and measurable outcomes.</p><button onClick={()=>setOpen(${brokenDialog ? "true" : "false"})}>Close details</button></div>}</section>}
function Home(){return <main><h1>${brand}</h1><p>Thoughtful information and useful tools for our visitors.</p><a href=${JSON.stringify(route)}>Explore ${page}</a></main>}
function ContentPage(){return <main><h1>${page}</h1><p>Explore practical local examples, useful details and clear next steps.</p>
${features.includes("tabs") ? '<Tabs items={[{id:"research",label:"Research",content:<p>Useful research insights.</p>},{id:"delivery",label:"Delivery",content:<p>Practical delivery plans.</p>}]}/>' : ""}
${features.includes("category filters") ? "<Catalog/>" : ""}
${features.includes("search") ? "<ProductSearch products={records}/>" : ""}
${features.includes("dialog") ? "<RecordDialog/>" : ""}
${features.includes("accordion") ? '<Accordion items={[{id:"approach",label:"How does it work?",content:<p>Choose a local example and explore the available information.</p>}]}/>' : ""}
${features.includes("contact form") ? '<DemoForm label="Contact"/>' : ""}
${features.includes("newsletter") ? "<NewsletterSignup/>" : ""}
</main>}
export function App(){const path=window.location.pathname.replace(/\\/$/,'')||'/';return <><header><a href="/">${brand}</a><MobileNav items={pages}/></header>{path===${JSON.stringify(route)}?<ContentPage/>:<Home/>}<footer>Local demonstration information.</footer></>}`;
  return { id, prompt, bundle: { files: [{ path: "src/App.tsx", content }, { path: "src/styles.css", content: '*{box-sizing:border-box}body{margin:0;font-family:Arial;background:#f5f5f1;color:#172132}header,main,footer{padding:20px}nav{display:flex;flex-wrap:wrap;gap:16px}button,input,textarea,select{font:inherit;max-width:100%;padding:8px}section{margin:16px 0}article{padding:12px;border:1px solid}label{display:block}p{line-height:1.5}[hidden]{display:none!important}[role=dialog]{position:fixed;inset:10%;background:white;z-index:100;overflow:auto;padding:24px}@media(max-width:600px){[role=dialog]{inset:8px}}' }] } };
}
export const complexFixtures: readonly ComplexFixture[] = [
  ...variants.map(([id]) => complexFixture(id)),
  { id: "ecommerce", prompt: ecommercePrompt, bundle: recoverFunctionalPlaceholders(functionalFixtures.ecommerce).bundle },
];
