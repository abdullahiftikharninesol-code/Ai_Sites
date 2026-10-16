import React from "react";
import { Link } from "react-router-dom";
import { CallToAction } from "../components/CallToAction.jsx";
import { Icon } from "../components/Icon.jsx";
import { PageHero } from "../components/PageHero.jsx";
import { SectionIntro } from "../components/SectionIntro.jsx";
import { featureGroups } from "../data/content.js";

export function FeaturesPage() {
  return (
    <>
      <PageHero eyebrow="Product capabilities" title="A connected workspace for the way modern teams deliver." description="Plan important work, coordinate across functions, and improve each delivery cycle without adding process for its own sake." actionLabel="Explore example pricing" actionTo="/pricing" aside={<div className="orbital-visual"><span className="orbital-visual__core"><Icon name="workflow" size={28} /></span><i className="orbit-node orbit-node--one"><Icon name="target" size={18} /></i><i className="orbit-node orbit-node--two"><Icon name="users" size={18} /></i><i className="orbit-node orbit-node--three"><Icon name="pulse" size={18} /></i></div>} />

      <section className="section section--compact">
        <div className="container feature-groups">
          {featureGroups.map((group, index) => (
            <article className="feature-group" key={group.title}>
              <div className="feature-group__copy"><p className="eyebrow">{group.eyebrow}</p><h2>{group.title}</h2><p>{group.description}</p><ul className="check-list">{group.items.map((item) => <li key={item}><Icon name="check" />{item}</li>)}</ul></div>
              <div className={`feature-visual feature-visual--${index + 1}`} aria-label={`Illustrative ${group.eyebrow.toLowerCase()} capability`}>
                {index === 0 ? <PlanningVisual /> : index === 1 ? <CoordinationVisual /> : <InsightsVisual />}
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="section section--tint">
        <div className="container">
          <SectionIntro eyebrow="Connect your toolkit" title="Bring your everyday tools into one coherent workflow." description="This visual is illustrative—replace these neutral integration placeholders with the tools your product genuinely supports." align="center" />
          <div className="integration-row" aria-label="Illustrative integration placeholders">
            {["C", "M", "S", "D", "V", "Z"].map((letter, index) => <span key={letter} style={{ "--index": index }}>{letter}</span>)}
          </div>
          <div className="integration-note"><Icon name="layers" /><div><strong>Flexible by design</strong><p>Keep the section as a neutral ecosystem story or replace it with verified integrations later.</p></div><Link className="text-link" to="/contact">Discuss your workflow<Icon name="arrow" size={16} /></Link></div>
        </div>
      </section>
      <CallToAction title="Build a product story that feels clear from the first click." />
    </>
  );
}

function PlanningVisual() {
  return <div className="mini-window"><div className="mini-window__bar"><span /><span /><span /></div><div className="timeline"><div><b>Product strategy</b><span className="timeline-bar timeline-bar--long" /></div><div><b>Customer research</b><span className="timeline-bar timeline-bar--medium" /></div><div><b>Launch readiness</b><span className="timeline-bar timeline-bar--short" /></div></div></div>;
}

function CoordinationVisual() {
  return <div className="message-stack"><article><span>AM</span><div><strong>Alex Morgan</strong><p>Launch brief is ready for review.</p><small>Just now</small></div></article><article><span>SK</span><div><strong>Sam Kim</strong><p>Great—design handoff is already linked.</p><small>2 min</small></div></article><article className="message-stack__resolved"><Icon name="check" /><div><strong>Decision recorded</strong><p>Onboarding direction approved</p></div></article></div>;
}

function InsightsVisual() {
  return <div className="insights-visual"><div className="insights-visual__score"><span>Cycle health</span><strong>Strong</strong><small>Steady improvement</small></div><svg viewBox="0 0 320 120" role="img" aria-label="Illustrative upward progress line"><path d="M5 102 C48 98 60 74 98 79 S145 54 177 59 S230 30 315 18" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round" /><path d="M5 102 C48 98 60 74 98 79 S145 54 177 59 S230 30 315 18 L315 120 L5 120Z" fill="currentColor" opacity=".08" /></svg></div>;
}
