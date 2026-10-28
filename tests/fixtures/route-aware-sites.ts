import { vertexBundle, compilerFind, compilerReplacement } from "./build-repair-sites.js";
import type { SiteCoderFileBundle } from "../../src/cli/runtime/site-coder-file-bundle.js";

export const routeAwarePrompt = `Create Vertex AI Studio, a frontend-only agency website.
## 2. Website Pages
**Home**
Hero, service overview, featured project summary and working FAQ accordion.
**Services**
Working service tabs.
**Our Work**
Working category filters and project detail modal.
**About**
Team and company details.
**Contact**
Validated contact form with honest local demo feedback.
## 3. Interactive Functionality
Mobile menu and real navigation. Category filtering, service tabs, project modals and contact form validation.
Preserve responsive desktop, tablet and mobile layouts. No backend or remote submission.`;

export type RouteFixtureKind = "valid" | "missing" | "decorative" | "missing-route" | "buttons" | "tabs" | "custom-accordion" | "decorative-accordion" | "never-close-accordion";
export function routeAwareFixture(route = "/work", kind: RouteFixtureKind = "valid"): SiteCoderFileBundle {
  return { ...vertexBundle, files: vertexBundle.files.map(file => {
    if (file.path !== "src/App.tsx") return file;
    let content = file.content.replace(compilerFind, compilerReplacement).replaceAll("/our-work", route)
      .replace(/function Home\(\)\{[^\n]+/, `function Home(){return <section data-sites-page="home"><h1>Vertex AI Studio</h1><p>Thoughtful digital experiences for ambitious ideas.</p><a href="/services">Explore our services</a><p>Discovery sprint: {deliveryWeeks} weeks.</p><h2>Featured work</h2><p>Discover our recent studio projects.</p><Accordion items={[{id:"process",label:"How does a project begin?",content:<p>We begin with a discovery workshop and a shared delivery plan.</p>}]}/></section>}`);
    if (kind.endsWith("accordion")) {
      const handler = kind === "decorative-accordion" ? 'setSelected(value=>value===index?-1:index)' : kind === "never-close-accordion" ? 'setSelected(index);setVisible(index)' : 'setSelected(value=>value===index?-1:index);setVisible(value=>value===index?-1:index)';
      content = content.replace('function Home(){return', 'function Home(){const[selected,setSelected]=useState(-1);const[visible,setVisible]=useState(-1);return')
        .replace(/<Accordion items=\{\[\{id:"process"[^\n]*?\}\]\}\/>/, `<div><h2>Frequently asked questions</h2>{["How does a project begin?","How do we work together?","What happens after delivery?"].map((question,index)=><div key={question}><h3><span><button type="button" aria-expanded={selected===index} onClick={()=>{${handler}}}>{question}</button></span></h3>{visible===index&&<div><p>We begin with a discovery workshop and a shared delivery plan.</p></div>}</div>)}</div>`);
    }
    if (kind === "missing") content = content.replace(/<label>Project category[\s\S]*?<\/label>/, "").replace("projects.filter(project=>category===\"All\"||project.category===category)", "projects");
    if (kind === "decorative") content = content.replace("setCategory(event.target.value)", "setCategory(category)");
    if (kind === "missing-route") content = content.replace(`path===${JSON.stringify(route)}?<OurWork/>:`, "");
    if (kind === "buttons" || kind === "tabs") content = content.replace(/<label>Project category[\s\S]*?<\/label>/,
      `<div ${kind === "tabs" ? 'role="tablist" aria-label="Project category"' : 'aria-label="Project category"'}>{["All","Strategy","Design"].map(value=><button key={value} type="button" ${kind === "tabs" ? 'role="tab" aria-selected={category===value}' : 'aria-pressed={category===value}'} onClick={()=>setCategory(value)}>{value}</button>)}</div>`);
    return { ...file, content };
  }) };
}
