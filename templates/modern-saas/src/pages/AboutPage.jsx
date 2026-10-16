import React from "react";
import { CallToAction } from "../components/CallToAction.jsx";
import { Icon } from "../components/Icon.jsx";
import { PageHero } from "../components/PageHero.jsx";
import { SectionIntro } from "../components/SectionIntro.jsx";

const values = [
  { icon: "target", title: "Clarity over complexity", description: "Make the important work easier to understand, discuss, and move forward." },
  { icon: "users", title: "Teams are the system", description: "Design software around how people collaborate—not around abstract process." },
  { icon: "pulse", title: "Progress should feel visible", description: "Use thoughtful signals to encourage action without creating reporting overhead." },
];

const team = [
  { initials: "AP", name: "Avery Patel", role: "Product & strategy" },
  { initials: "JM", name: "Jordan Miller", role: "Design & experience" },
  { initials: "RC", name: "Riley Chen", role: "Engineering" },
  { initials: "TS", name: "Taylor Singh", role: "Customer success" },
];

export function AboutPage() {
  return (
    <>
      <PageHero eyebrow="About the example brand" title="Software should create momentum, not more work." description="FlowPilot is a fictional company story built to demonstrate a credible, human SaaS about page without relying on real claims or people." actionLabel="See how the product works" actionTo="/features" aside={<div className="principle-card"><span>Our product principle</span><strong>Make the next step obvious.</strong><p>Every screen, workflow, and interaction should help a team move with more confidence.</p></div>} />

      <section className="section section--compact">
        <div className="container story-grid">
          <div><p className="eyebrow">The story</p><h2>Built from a familiar frustration.</h2></div>
          <div className="story-copy"><p>FlowPilot began as an example of a simple idea: teams do their best work when direction, context, and progress live together.</p><p>Instead of adding another layer of process, the fictional product is designed to make existing work easier to see and coordinate. This narrative gives the template a believable foundation while staying easy to replace.</p></div>
        </div>
      </section>

      <section className="section section--tint">
        <div className="container">
          <SectionIntro eyebrow="What guides us" title="A few principles for building useful software." description="Clear values give an about page substance without resorting to unverified awards, metrics, or grand claims." align="center" />
          <div className="value-grid">{values.map((value) => <article key={value.title}><span className="icon-box"><Icon name={value.icon} /></span><h3>{value.title}</h3><p>{value.description}</p></article>)}</div>
        </div>
      </section>

      <section className="section">
        <div className="container team-layout">
          <SectionIntro eyebrow="Example team" title="Small team, shared standard." description="These fictional profiles use initials rather than external portraits, keeping the template dependable and easy to customize." />
          <div className="team-grid">{team.map((person, index) => <article key={person.name}><div className={`team-avatar team-avatar--${index + 1}`}>{person.initials}</div><h3>{person.name}</h3><p>{person.role}</p><span>Fictional profile</span></article>)}</div>
        </div>
      </section>
      <CallToAction title="Create an about story that earns attention through clarity." />
    </>
  );
}
