import React, { useEffect, useState } from "react";
import { Link, NavLink, Route, Routes, useLocation } from "react-router-dom";

const projects = [
  { id: "01", title: "Aperture House", type: "Identity / Digital", year: "2025", tone: "coral", mark: "AH" },
  { id: "02", title: "Common Thread", type: "Campaign / Art Direction", year: "2024", tone: "blue", mark: "CT" },
  { id: "03", title: "Index Editions", type: "Editorial / E-commerce", year: "2024", tone: "ink", mark: "IE" },
  { id: "04", title: "Field Notes", type: "Strategy / Packaging", year: "2023", tone: "green", mark: "FN" },
  { id: "05", title: "After Hours", type: "Digital / Creative Development", year: "2022", tone: "coral", mark: "AH" },
];

function useMobile() {
  const [mobile, setMobile] = useState(() => window.matchMedia("(max-width: 760px)").matches);
  useEffect(() => { const query = window.matchMedia("(max-width: 760px)"); const update = () => setMobile(query.matches); query.addEventListener("change", update); return () => query.removeEventListener("change", update); }, []);
  return mobile;
}

function Shell({ children }) {
  const mobile = useMobile();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  useEffect(() => { setOpen(false); window.scrollTo(0, 0); }, [location.pathname]);
  const links = [["/", "Index"], ["/work", "Selected work"], ["/about", "Profile"], ["/contact", "Contact"]];
  return <div className="site-frame">
    <header className="topbar">
      <Link className="identity" to="/" aria-label="Maya Reed home"><span>M/R</span><small>Independent designer<br />New York · Worldwide</small></Link>
      {mobile ? <button className="menu-button" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls="mobile-nav">{open ? "Close" : "Menu"}</button> : <nav className="nav" aria-label="Primary">{links.map(([to, label]) => <NavLink key={to} to={to} end={to === "/"}>{label}</NavLink>)}</nav>}
    </header>
    {mobile && open && <nav id="mobile-nav" className="mobile-nav" aria-label="Mobile primary">{links.map(([to, label], i) => <NavLink key={to} to={to} end={to === "/"}><span>0{i + 1}</span>{label}</NavLink>)}</nav>}
    <main>{children}</main>
    <footer><div className="footer-mark">M/R</div><div><p>Have a project in mind?</p><Link to="/contact">Let’s make something memorable ↗</Link></div><div className="footer-meta"><span>New York, 10:24</span><span>Instagram · LinkedIn</span><span>© 2026 Maya Reed</span></div></footer>
  </div>;
}

function ProjectArt({ project, large = false }) { return <div className={`project-art ${project.tone} ${large ? "large" : ""}`}><span className="art-cross">+</span><b>{project.mark}</b><i>{project.id} / 04</i><div className="orb" /></div>; }
function ProjectRow({ project }) { return <article className="project-row"><div className="project-copy"><span className="eyebrow">{project.id} — {project.year}</span><h2>{project.title}</h2><p>{project.type}</p><Link to="/work" aria-label={`View ${project.title} project`}>View project <span>↗</span></Link></div><ProjectArt project={project} /></article>; }

function Home() { return <>
  <section className="hero"><div className="hero-kicker"><span>Portfolio 2026</span><span>Available for select collaborations</span></div><h1>Ideas with<br /><em>clear intent.</em></h1><div className="hero-bottom"><p>I’m Maya, an independent designer building identities and digital experiences for people shaping culture.</p><span className="scroll">Scroll to explore ↓</span></div></section>
  <section className="statement"><span className="section-no">01 / Selected work</span><p>From first thought to final form, I create <em>distinctive systems</em> that give ambitious ideas a place in the world.</p></section>
  <section className="work-list">{projects.slice(0, 3).map(project => <ProjectRow key={project.id} project={project} />)}</section>
  <section className="recognition"><span className="section-no">02 / Practice</span><div className="recognition-grid"><h2>Direction, design<br />and development.</h2><ul><li><span>Independent studio</span><b>Creative direction · Identity systems</b><small>2021—Now</small></li><li><span>Studio North</span><b>Design director · Digital experiences</b><small>2017—21</small></li><li><span>Form&Co</span><b>Senior designer · Editorial design</b><small>2013—17</small></li></ul></div></section>
</>; }

function Work() { return <><section className="page-intro"><span className="section-no">Archive / 2021—2026</span><h1>Selected<br /><em>work.</em></h1><p>A collection of identities, platforms, publications and campaigns created with people who care deeply about what they put into the world.</p></section><section className="filter-line" aria-label="Project disciplines"><span>All work</span><span>Identity</span><span>Digital</span><span>Editorial</span></section><section className="work-grid">{projects.map((project, i) => <article className={i % 3 === 0 ? "wide" : ""} key={project.id}><ProjectArt project={project} large /><div className="work-caption"><h2>{project.title}</h2><p>{project.type} · {project.year}</p></div></article>)}</section></>; }

function About() { return <><section className="page-intro about-intro"><span className="section-no">Profile / Maya Reed</span><h1>Good work starts<br />with a good <em>question.</em></h1></section><section className="bio"><div className="portrait" aria-label="Abstract portrait of Maya Reed"><span>MR</span><div /></div><div className="bio-copy"><h2>I turn complex ideas into clear, expressive experiences.</h2><p>For over a decade, I’ve partnered with founders, cultural institutions and thoughtful teams at moments of change. My practice moves between strategy, identity and digital design—always grounded in curiosity and close collaboration.</p><p>I believe rigor and play belong in the same room. The best work feels inevitable only after you’ve explored every unlikely direction.</p><div className="facts"><div><small>Previously</small><b>Studio North<br />Form&Co<br />Actual Source</b></div><div><small>Services</small><b>Creative direction<br />Brand identity<br />Digital experiences</b></div></div></div></section><section className="principles"><span className="section-no">Working principles</span>{["Ask better questions.", "Make room for surprise.", "Care about the details.", "Stay human."].map((x, i) => <div key={x}><span>0{i + 1}</span><h3>{x}</h3></div>)}</section></>; }

function Contact() {
  const [sent, setSent] = useState(false);
  return <section className="contact-page"><div className="contact-lead"><span className="section-no">Start a conversation</span><h1>Let’s make<br />something <em>matter.</em></h1><p>Tell me where you are, where you want to go, and what’s standing in the way.</p><a href="mailto:hello@mayareed.studio">hello@mayareed.studio ↗</a></div><form onSubmit={e => { e.preventDefault(); setSent(true); }}><label>Your name<input required name="name" placeholder="Jane Smith" /></label><label>Email address<input required type="email" name="email" placeholder="jane@company.com" /></label><label>What can I help with?<select name="project"><option>Brand identity</option><option>Website or digital product</option><option>Creative direction</option><option>Something else</option></select></label><label>Tell me a little more<textarea required name="message" rows="4" placeholder="A few words about your project, timing and ambitions…" /></label><button type="submit">{sent ? "Message received — thank you" : "Send inquiry ↗"}</button>{sent && <p className="success" role="status">I’ll be in touch within two working days.</p>}</form></section>;
}

export default function App() { return <Shell><Routes><Route path="/" element={<Home />} /><Route path="/work" element={<Work />} /><Route path="/about" element={<About />} /><Route path="/contact" element={<Contact />} /><Route path="*" element={<Home />} /></Routes></Shell>; }
