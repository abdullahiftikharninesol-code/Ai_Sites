import React from "react";
import { Link } from "react-router-dom";
import { benefits, faqs, pricingPlans } from "../data/content.js";
import { CallToAction } from "../components/CallToAction.jsx";
import { FaqList } from "../components/FaqList.jsx";
import { Icon } from "../components/Icon.jsx";
import { ProductPreview } from "../components/ProductPreview.jsx";
import { SectionIntro } from "../components/SectionIntro.jsx";

export function HomePage() {
  return (
    <>
      <section className="home-hero">
        <div className="container home-hero__grid">
          <div className="home-hero__copy">
            <p className="eyebrow"><span className="eyebrow__dot" />A calmer way to move work forward</p>
            <h1>Turn ambitious plans into focused progress.</h1>
            <p className="home-hero__lead">FlowPilot gives modern teams one clear place to plan, coordinate, and improve the work that matters.</p>
            <div className="button-row">
              <Link className="button" to="/contact">Start building momentum<Icon name="arrow" size={17} /></Link>
              <Link className="button button--secondary" to="/features">Explore the product</Link>
            </div>
          </div>
          <div className="home-hero__visual"><ProductPreview /></div>
        </div>
      </section>

      <section className="trust-strip" aria-label="Illustrative customer names">
        <div className="container">
          <p>Trusted by teams building what&apos;s next</p>
          <div className="wordmarks">
            <span><b>◇</b> Northstar</span><span><b>◫</b> Vertex</span><span><b>○</b> Meridian</span><span><b>△</b> Assemble</span><span><b>✦</b> Kinship</span>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <SectionIntro eyebrow="Built for momentum" title="Less time managing work. More time moving it." description="Give every team enough structure to stay aligned, without turning the process into another project." align="center" />
          <div className="benefit-grid">
            {benefits.map((benefit) => (
              <article className="benefit-item" key={benefit.title}>
                <span className="icon-box"><Icon name={benefit.icon} /></span>
                <h3>{benefit.title}</h3>
                <p>{benefit.description}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="section section--tint">
        <div className="container workflow-grid">
          <div className="workflow-copy">
            <SectionIntro eyebrow="A simpler workflow" title="From first idea to finished work, without losing the thread." description="FlowPilot keeps the plan, the conversation, and the latest progress connected in one shared operating space." />
            <ol className="step-list">
              <li><span>01</span><div><h3>Set the direction</h3><p>Define the outcome, owners, and milestones that give the team a shared point of view.</p></div></li>
              <li><span>02</span><div><h3>Coordinate the work</h3><p>Bring tasks, context, and decisions together so handoffs stay clear.</p></div></li>
              <li><span>03</span><div><h3>Learn and improve</h3><p>Review delivery patterns and make the next cycle stronger than the last.</p></div></li>
            </ol>
            <Link className="text-link" to="/features">See how the pieces connect<Icon name="arrow" size={17} /></Link>
          </div>
          <div className="workflow-board" aria-label="Illustrative product workflow">
            <div className="workflow-board__header"><div><span>Product launch</span><strong>Delivery board</strong></div><span className="status-pill">On track</span></div>
            <div className="kanban-grid">
              <div className="kanban-column"><span>Planned · 3</span><article><small>Research</small><strong>Map customer journey</strong><div className="avatar-row"><i>AM</i><em>Fri</em></div></article><article><small>Content</small><strong>Draft launch story</strong><div className="avatar-row"><i>SK</i><em>Mon</em></div></article></div>
              <div className="kanban-column"><span>In progress · 2</span><article className="kanban-card--accent"><small>Product</small><strong>Refine onboarding flow</strong><div className="avatar-row"><i>JL</i><em>Today</em></div></article><article><small>Growth</small><strong>Prepare beta invite</strong><div className="avatar-row"><i>NP</i><em>Wed</em></div></article></div>
              <div className="kanban-column"><span>Complete · 2</span><article><small>Strategy</small><strong>Approve positioning</strong><div className="avatar-row"><i>✓</i><em>Done</em></div></article><article><small>Design</small><strong>Finalize visual system</strong><div className="avatar-row"><i>✓</i><em>Done</em></div></article></div>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container split-feature">
          <div className="insight-panel">
            <div className="insight-panel__top"><span>Team pulse</span><small>Updated today</small></div>
            <div className="insight-score"><strong>Healthy</strong><span>Across 8 active projects</span></div>
            <div className="insight-bars"><span style={{ width: "88%" }} /><span style={{ width: "72%" }} /><span style={{ width: "81%" }} /></div>
            <div className="insight-callout"><Icon name="spark" size={18} /><p><strong>Momentum is improving.</strong> Three projects cleared their biggest dependency this week.</p></div>
          </div>
          <div>
            <p className="eyebrow">Useful signals, not noise</p>
            <h2>See what needs attention before it slows the team down.</h2>
            <p>Thoughtful summaries help leaders understand momentum while teams stay focused on delivery—not reporting.</p>
            <ul className="check-list"><li><Icon name="check" />Clear progress summaries</li><li><Icon name="check" />Visible decisions and risks</li><li><Icon name="check" />Flexible views for every role</li></ul>
          </div>
        </div>
      </section>

      <section className="section section--dark">
        <div className="container testimonial-layout">
          <div><p className="eyebrow eyebrow--light">Illustrative customer story</p><blockquote>“FlowPilot gave our team a common language for the work. Planning feels lighter, and everyone knows what happens next.”</blockquote><div className="quote-author"><span>MC</span><div><strong>Maya Chen</strong><small>Example VP of Product, Northstar</small></div></div></div>
          <div className="testimonial-note"><span>Template content</span><p>This testimonial and company are fictional placeholders, ready to replace with an approved customer story.</p></div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <SectionIntro eyebrow="Simple example pricing" title="Start small, then grow with your team." description="A concise three-tier structure that is easy to adapt to your real product and packaging." align="center" />
          <div className="pricing-grid pricing-grid--preview">
            {pricingPlans.map((plan) => (
              <article className={`price-card${plan.featured ? " price-card--featured" : ""}`} key={plan.name}>
                {plan.featured ? <span className="price-card__label">Most popular</span> : null}
                <h3>{plan.name}</h3><div className="price"><strong>{plan.price}</strong>{plan.suffix ? <span>{plan.suffix}</span> : null}</div><p>{plan.description}</p>
                <Link className={plan.featured ? "button" : "button button--secondary"} to={plan.name === "Business" ? "/contact" : "/pricing"}>{plan.cta}</Link>
              </article>
            ))}
          </div>
          <p className="pricing-disclaimer">Illustrative pricing only. Replace with your product’s actual plans and terms.</p>
        </div>
      </section>

      <section className="section section--compact section--tint">
        <div className="container faq-layout">
          <SectionIntro eyebrow="Common questions" title="A flexible starting point for your next SaaS site." description="These answers explain the template itself and make safe, replaceable FAQ content." />
          <FaqList items={faqs} />
        </div>
      </section>
      <CallToAction />
    </>
  );
}
