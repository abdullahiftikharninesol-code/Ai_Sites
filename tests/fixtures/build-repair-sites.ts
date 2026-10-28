import type { SiteCoderFileBundle } from "../../src/cli/runtime/site-coder-file-bundle.js";

export const vertexPrompt = "Build Vertex AI Studio, a five-page business website. Pages: Home, Services, Our Work, About, Contact. Include responsive mobile navigation, service tabs, portfolio filters, project modal, an FAQ accordion on Home, and a validated demo contact form. Use frontend mock data only; no login or backend submissions.";
export const vertexPages = [
  { name: "Home", path: "/" }, { name: "Services", path: "/services" }, { name: "Our Work", path: "/our-work" },
  { name: "About", path: "/about" }, { name: "Contact", path: "/contact" },
] as const;
export const compilerFind = 'const deliveryWeeks: number = "4";';
export const compilerReplacement = 'const deliveryWeeks: number = 4;';
export const vertexSource = `import { useState } from "react";
import { MobileNav, Tabs, Accordion, DemoDialog, DemoForm } from "./sites-ui/functional";
import { StudioFooter } from "./StudioFooter";
import "./vertex.css";
${compilerFind}
const pages=[{label:"Home",href:"/"},{label:"Services",href:"/services"},{label:"Our Work",href:"/our-work"},{label:"About",href:"/about"},{label:"Contact",href:"/contact"}];
const projects=[{name:"Signal Atlas",category:"Strategy",description:"A research-led roadmap for a local planning demo."},{name:"Canvas Lab",category:"Design",description:"An accessible interface study with working local controls."}];
function ServiceTabs(){return <Tabs items={[{id:"strategy",label:"Strategy",content:<p>Research, discovery and a measurable delivery plan.</p>},{id:"design",label:"Design",content:<p>Accessible digital design and interactive prototypes.</p>}]}/>}
function Projects(){const [category,setCategory]=useState("All");const visible=projects.filter(project=>category==="All"||project.category===category);return <><label>Project category<select name="projectCategory" aria-label="Project category" value={category} onChange={event=>setCategory(event.target.value)}><option>All</option><option>Strategy</option><option>Design</option></select></label><div className="project-list">{visible.map(project=><article data-project={project.name} key={project.name}><h2>{project.name}</h2><p>{project.category}</p><DemoDialog label={"View "+project.name}><h2>{project.name}</h2><p>{project.description}</p></DemoDialog></article>)}</div></>}
function Home(){return <section data-sites-page="home"><h1>Vertex AI Studio</h1><p>Thoughtful digital experiences for ambitious ideas.</p><a href="/services">Explore our services</a><p>Typical discovery sprint: {deliveryWeeks} weeks.</p><h2>Service overview</h2><ServiceTabs/><h2>Selected projects</h2><Projects/><Accordion items={[{id:"process",label:"How does a project begin?",content:<p>We begin with a discovery workshop and a shared delivery plan.</p>}]}/><h2>Start a conversation</h2><DemoForm label="Studio enquiry"/></section>}
function Services(){return <section data-sites-page="services"><h1>Services</h1><ServiceTabs/></section>}
function OurWork(){return <section data-sites-page="our-work"><h1>Our Work</h1><Projects/></section>}
function About(){return <section data-sites-page="about"><h1>About Vertex</h1><p>We are an independent studio pairing practical strategy with careful design.</p><a href="/contact">Talk with the studio</a></section>}
function Contact(){return <section data-sites-page="contact"><h1>Contact Vertex</h1><p>Try our local enquiry demonstration.</p><DemoForm label="Studio enquiry"/></section>}
export function App(){const path=location.pathname;return <><header><a href="/" aria-label="Vertex AI Studio home">Vertex AI Studio</a><MobileNav items={pages}/></header><main>{path==="/services"?<Services/>:path==="/our-work"?<OurWork/>:path==="/about"?<About/>:path==="/contact"?<Contact/>:<Home/>}</main><StudioFooter/></>}
`;
export const vertexBundle: SiteCoderFileBundle = { siteName: "Vertex AI Studio", files: [
  { path: "src/App.tsx", content: vertexSource },
  { path: "src/StudioFooter.tsx", content: 'export function StudioFooter(){return <footer><p>Vertex AI Studio — frontend demonstration.</p><a href="/contact">Contact</a></footer>}' },
  { path: "src/vertex.css", content: '*{box-sizing:border-box}body{margin:0;background:#101622;color:#edf2ff;font-family:Arial,sans-serif}header,main,footer{padding:24px 6vw}header{display:flex;align-items:center;justify-content:space-between;gap:20px;border-bottom:1px solid #56617a}a{color:#adc8ff}h1{font-size:clamp(30px,5vw,60px)}main{min-height:65vh}section{max-width:1100px;margin:auto}button,input,select,textarea{font:inherit;padding:10px;max-width:100%}button{cursor:pointer;color:#101622;background:#d4e3ff;border:1px solid #6983b0;border-radius:6px}nav{display:flex;flex-wrap:wrap;gap:16px;padding:18px 0}label{display:block;margin:12px 0}input,textarea{display:block}article{padding:20px;border:1px solid #56617a;border-radius:12px}.project-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}dialog{max-width:min(90vw,600px);border-radius:12px}details{margin:24px 0}summary{cursor:pointer;padding:12px}footer{border-top:1px solid #56617a}button[role=tab]{margin:8px}[hidden]{display:none!important}@media(max-width:700px){.project-list{grid-template-columns:1fr}header,main,footer{padding:18px}header{flex-wrap:wrap}}' },
] };

// Sanitized structure observed in retained job 2b1ab8d1: seven inert buttons on
// dense JSX lines. The original provider patch was not retained; invented find
// text here is intentionally a synthetic negative, never called the live patch.
export const retainedPattern = Array.from({ length: 63 }, (_, index) => {
  const line = index + 1;
  return [44, 50, 52, 56].includes(line) ? `<section>${Array.from({ length: line === 44 ? 4 : 1 }, (_value, i) => `<button type="button">Local control ${line}-${i}</button>`).join("")}</section>` : `// fixture line ${line}`;
}).join("\n");
