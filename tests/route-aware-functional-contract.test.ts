import { describe, expect, it } from "vitest";
import { DeterministicRequirementsPlanner, DeterministicDesignPlanner, assembleSiteSpec } from "../src/planning/planning.js";
import { functionalRequirements, functionalGenerationContract } from "../src/sites/generation/functional-capabilities.js";
import { withFunctionalContract } from "../src/sites/generation/functional-route-contract.js";
import { functionalSourceManifest, resolveFunctionalSourceContract } from "../src/sites/generation/functional-source-contract.js";
import { requestedPages } from "../src/sites/generation/requested-pages.js";
import { routeAwareFixture, routeAwarePrompt } from "./fixtures/route-aware-sites.js";

async function routeSpec(prompt = routeAwarePrompt) {
  const requirements = await new DeterministicRequirementsPlanner().plan(prompt);
  const design = await new DeterministicDesignPlanner().plan(requirements);
  return withFunctionalContract(assembleSiteSpec("Offline fixture", prompt, requirements, design), functionalRequirements(prompt));
}
describe("Route-aware deterministic completion contract", () => {
  it("preserves explicit five-page ownership rather than incidental team and FAQ words", async () => {
    const spec = await routeSpec();
    expect(spec.requirements.pages.map(page => page.name)).toEqual(["Home", "Services", "Our Work", "About", "Contact"]);
    const requirements = spec.requirements.functional!.requirements!;
    expect(requirements.find(item => item.capability === "category-filter")?.target.pageName).toBe("Our Work");
    expect(requirements.find(item => item.capability === "tabs")?.target.pageName).toBe("Services");
    expect(requirements.find(item => item.capability === "form")?.target.pageName).toBe("Contact");
    expect(requirements.filter(item => item.capability === "category-filter")).toHaveLength(1);
    expect(functionalGenerationContract(spec.requirements.functional!)).toContain("PAGE: Our Work");
  });
  it.each(["/work", "/our-work", "/portfolio", "/projects", "/case-studies"])("grounds the portfolio mapping in rendered source at %s", async route => {
    const source = routeAwareFixture(route), contract = resolveFunctionalSourceContract(await routeSpec(), source);
    expect(contract.requirements.find(item => item.capability === "category-filter")?.routes).toEqual([route]);
    const manifest = functionalSourceManifest(source);
    expect(manifest.routes.find(item => item.path === "/")?.capabilities).not.toContain("category-filter");
    expect(contract.pages).toHaveLength(5);
  });
  it("rejects unused portfolio components and links without actual routing", async () => {
    const spec = await routeSpec();
    expect(() => resolveFunctionalSourceContract(spec, routeAwareFixture("/work", "missing-route"))).toThrow(/no implemented generated route/);
  });
  it("defers an uncertain dynamic filter to mandatory behavior validation on its required route", async () => {
    const spec = await routeSpec();
    const requirement = resolveFunctionalSourceContract(spec, routeAwareFixture("/work", "missing")).requirements.find(item => item.capability === "category-filter")!;
    expect(requirement.routes).toEqual(["/work"]);
    expect(requirement.sourceAssessment?.state).toBe("UNCERTAIN");
  });
  it("does not require unrequested filtering", async () => {
    const spec = await routeSpec("Create a simple frontend-only SaaS landing page with a hero. No forms or login.");
    expect(spec.requirements.functional?.capabilities).not.toContain("category-filter");
  });
  it("does not let a planner silently drop a requested page", async () => {
    const original = await routeSpec();
    const incomplete = { ...original, requirements: { ...original.requirements, pages: original.requirements.pages.filter(page => page.name !== "Our Work") } };
    expect(() => resolveFunctionalSourceContract(incomplete, routeAwareFixture("/work", "missing-route"))).toThrow(/Required page Our Work/);
  });
  it("closes page sections before global functionality reminders", () => {
    const pages = requestedPages(routeAwarePrompt), contact = pages.find(page => page.name === "Contact")!;
    expect(routeAwarePrompt.slice(contact.start, contact.end)).not.toContain("Interactive Functionality");
  });
  it("preserves descriptive section intent without inventing a literal selector", async () => {
    const spec = await routeSpec("Pages: Home, Contact. Add working category filters in the portfolio section on Home. Frontend-only.");
    expect(spec.requirements.functional?.requirements?.find(item => item.capability === "category-filter")?.target).toEqual({ kind: "PAGE", sectionName: "portfolio", pageId: "home", pageName: "Home" });
  });
  it.each([
    "Include a project inquiry summary and business contact section.",
    "Add a contact section beside the form.",
    "Add a contact form and a business contact section.",
    "Contact form with validation. Include a business contact section.",
    "Do not place the contact form in #footer.",
    "The navigation should link to #contact. Include a contact form.",
    "Keep the contact form beside the portfolio section.",
  ])("does not invent a section constraint from incidental prose: %s", async extra => {
    const spec = await routeSpec(routeAwarePrompt.replace("Validated contact form with honest local demo feedback.", `Professional project inquiry form with name, email, company, service type, budget range and message. Validate required fields and email. Show honest local demo confirmation. ${extra}`));
    const form = spec.requirements.functional!.requirements!.find(item => item.capability === "form")!;
    expect(form.target).toEqual({ kind: "PAGE", pageId: "contact", pageName: "Contact" });
    expect(resolveFunctionalSourceContract(spec, routeAwareFixture()).requirements.find(item => item.capability === "form")?.routes).toEqual(["/contact"]);
  });
  it("does not attach another interaction's section to the form in the same sentence", async () => {
    const spec = await routeSpec(routeAwarePrompt.replace("Validated contact form with honest local demo feedback.", "Include the contact form and put an accordion in the FAQ section."));
    expect(spec.requirements.functional!.requirements!.find(item => item.capability === "form")?.target).toEqual({ kind: "PAGE", pageId: "contact", pageName: "Contact" });
    expect(spec.requirements.functional!.requirements!.find(item => item.capability === "accordion" && item.target.pageId === "contact")?.target).toMatchObject({ kind: "PAGE", sectionName: "FAQ" });
  });
  it("does not transfer another page's section constraint to Contact", async () => {
    const prompt = routeAwarePrompt.replace("Hero, service overview, featured project summary and working FAQ accordion.", "Hero, working FAQ accordion and a contact form in #home-inquiry.");
    const forms = (await routeSpec(prompt)).requirements.functional!.requirements!.filter(item => item.capability === "form");
    expect(forms.find(item => item.target.pageId === "home")?.target).toMatchObject({ kind: "SECTION", sectionId: "home-inquiry" });
    expect(forms.find(item => item.target.pageId === "contact")?.target).toEqual({ kind: "PAGE", pageId: "contact", pageName: "Contact" });
  });
  it.each([
    "Place the contact form in #project-inquiry.",
    "Put the contact form inside the section with id=\"project-inquiry\".",
    "In #project-inquiry, add the contact form.",
    "The contact form must be placed within #project-inquiry.",
  ])("honors a directly requested literal section ID: %s", async instruction => {
    const spec = await routeSpec(routeAwarePrompt.replace("Validated contact form with honest local demo feedback.", instruction));
    const form = spec.requirements.functional!.requirements!.find(item => item.capability === "form")!;
    expect(form.target).toMatchObject({ kind: "SECTION", sectionId: "project-inquiry", pageId: "contact" });
    expect(() => resolveFunctionalSourceContract(spec, routeAwareFixture())).toThrow(/Required explicit section #project-inquiry/);
    const source = routeAwareFixture();
    const withSection = { ...source, files: source.files.map(file => ({ ...file, content: file.path === "src/App.tsx" ? file.content.replace('data-sites-page="contact"', 'data-sites-page="contact" id="project-inquiry"') : file.content })) };
    expect(resolveFunctionalSourceContract(spec, withSection).requirements.find(item => item.capability === "form")?.routes).toEqual(["/contact"]);
    expect(functionalGenerationContract(spec.requirements.functional!)).toContain('literal id="project-inquiry"');
  });
  it("does not turn a named section into a required DOM ID", async () => {
    const spec = await routeSpec(routeAwarePrompt.replace("Validated contact form with honest local demo feedback.", 'Place the contact form within the "Project inquiry" section.'));
    const form = spec.requirements.functional!.requirements!.find(item => item.capability === "form")!;
    expect(form.target).toEqual({ kind: "SECTION", sectionName: "Project inquiry", pageId: "contact", pageName: "Contact" });
    expect(resolveFunctionalSourceContract(spec, routeAwareFixture()).requirements.find(item => item.capability === "form")?.routes).toEqual(["/contact"]);
    expect(functionalGenerationContract(spec.requirements.functional!)).toContain('accessible heading/label "Project inquiry"');
  });
  it.each(['id={"project-inquiry"}', 'id={regionId}'])("does not reject explicit IDs implemented with JSX expressions: %s", async attribute => {
    const spec = await routeSpec(routeAwarePrompt.replace("Validated contact form with honest local demo feedback.", "Place the contact form in #project-inquiry."));
    const source = routeAwareFixture();
    const actual = { ...source, files: source.files.map(file => ({ ...file, content: file.path === "src/App.tsx" ? file.content.replace('data-sites-page="contact"', `data-sites-page="contact" ${attribute}`).replace('function Contact(){', 'function Contact(){const regionId="project-inquiry";') : file.content })) };
    expect(resolveFunctionalSourceContract(spec, actual).requirements.find(item => item.capability === "form")?.routes).toEqual(["/contact"]);
  });
  it("still rejects a genuinely absent form under the exact failing prompt pattern", async () => {
    const spec = await routeSpec(routeAwarePrompt.replace("Validated contact form with honest local demo feedback.", "Validated contact form. Include a project inquiry summary and business contact section."));
    const source = routeAwareFixture();
    const missing = { ...source, files: source.files.map(file => ({ ...file, content: file.path === "src/App.tsx" ? file.content.replace('<DemoForm label="Studio enquiry"/>', "") : file.content })) };
    expect(() => resolveFunctionalSourceContract(spec, missing)).toThrow(/Required form has no implemented control on \/contact/);
  });
  it("ignores unused route manifests and unrelated pathname fields", () => {
    const source = { siteName: "Test", files: [{ path: "src/App.tsx", content: `
      const unused=[{path:"/portfolio",element:<Work/>}];
      function Work(){return <main><h1>Our Work</h1></main>}
      function Unused(){return <Routes><Route path="/unused" element={<Work/>}/></Routes>}
      export function App(){const item={pathname:"/fake"};return <main>{item.pathname==="/fake"?<p>Text</p>:<p>Other</p>}</main>}
    ` }] };
    expect(functionalSourceManifest(source).routes.map(route => route.path)).toEqual(["/"]);
  });
  it.each(["jsx", "objects", "dictionary", "switch"])("supports grounded %s routing and nested page components", kind => {
    const routing = kind === "jsx" ? `export function App(){return <BrowserRouter><Routes><Route path="/" element={<Home/>}/><Route path="/studio"><Route path="work" element={<OurWork/>}/></Route></Routes></BrowserRouter>}`
      : kind === "objects" ? `const routes=[{path:"/",element:<Home/>},{path:"/studio",children:[{path:"work",element:<OurWork/>}]}];const router=createBrowserRouter(routes);export function App(){return <RouterProvider router={router}/>}`
      : kind === "dictionary" ? `const pages={"/":<Home/>,"/studio/work":<OurWork/>};export function App(){const path=location.pathname;return pages[path]??<Home/>}`
      : `export function App(){switch(location.pathname){case "/studio/work":return <OurWork/>;default:return <Home/>}}`;
    const source = { siteName: "Test", files: [{ path: "src/App.tsx", content: `function Home(){return <main><h1>Home</h1><p>Welcome</p></main>}function OurWork(){return <Portfolio/>}function Portfolio(){return <section id="portfolio"><h1>Our Work</h1><select aria-label="Filter projects"><option>All</option></select></section>}${routing}` }] };
    const manifest = functionalSourceManifest(source);
    expect(manifest.routes.find(route => route.path === "/studio/work")?.labels).toContain("OurWork");
    expect(manifest.routes.find(route => route.path === "/studio/work")?.sections).toContain("portfolio");
    expect(manifest.routes.find(route => route.path === "/")?.capabilities).not.toContain("category-filter");
  });
  it.each(["jsx", "objects"])("inherits %s layout navigation without fabricating an empty layout page", kind => {
    const routing = kind === "jsx" ? `export function App(){return <BrowserRouter><Routes><Route path="/studio" element={<Layout/>}><Route path="work" element={<OurWork/>}/></Route></Routes></BrowserRouter>}`
      : `const router=createBrowserRouter([{path:"/studio",element:<Layout/>,children:[{path:"work",element:<OurWork/>}]}]);export function App(){return <RouterProvider router={router}/>}`;
    const source = { siteName: "Nested", files: [{ path: "src/App.tsx", content: `import {MobileNav} from "./sites-ui/functional";function Layout(){return <><MobileNav items={[]}/><Outlet/></>}function OurWork(){return <main><h1>Our Work</h1><p>Studio projects</p></main>}${routing}` }] };
    const manifest = functionalSourceManifest(source);
    expect(manifest.routes.some(route => route.path === "/studio")).toBe(false);
    expect(manifest.routes.some(route => route.path === "/")).toBe(false);
    expect(manifest.routes.find(route => route.path === "/studio/work")?.capabilities).toContain("mobile-nav");
  });
});
