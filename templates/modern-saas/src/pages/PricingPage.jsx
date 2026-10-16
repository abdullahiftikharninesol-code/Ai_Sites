import React from "react";
import { Link } from "react-router-dom";
import { CallToAction } from "../components/CallToAction.jsx";
import { FaqList } from "../components/FaqList.jsx";
import { Icon } from "../components/Icon.jsx";
import { PageHero } from "../components/PageHero.jsx";
import { faqs, pricingPlans } from "../data/content.js";

export function PricingPage() {
  return (
    <>
      <PageHero eyebrow="Example pricing" title="Straightforward plans for every stage of the journey." description="Use this clear three-tier structure as a starting point, then replace the example pricing and features with your approved offer." actionLabel="Questions? Talk to us" />
      <section className="section section--compact">
        <div className="container">
          <div className="pricing-grid">
            {pricingPlans.map((plan) => <article className={`price-card price-card--full${plan.featured ? " price-card--featured" : ""}`} key={plan.name}>{plan.featured ? <span className="price-card__label">Most popular</span> : null}<h2>{plan.name}</h2><div className="price"><strong>{plan.price}</strong>{plan.suffix ? <span>{plan.suffix}</span> : null}</div><p>{plan.description}</p><Link className={plan.featured ? "button" : "button button--secondary"} to="/contact">{plan.cta}</Link><ul>{plan.features.map((feature) => <li key={feature}><Icon name="check" />{feature}</li>)}</ul></article>)}
          </div>
          <p className="pricing-disclaimer">All names, prices, and package details are illustrative template content.</p>
          <div className="included-strip"><div><Icon name="shield" /><span><strong>Thoughtful controls</strong><small>Permission-ready structure</small></span></div><div><Icon name="users" /><span><strong>Human support</strong><small>Clear service expectations</small></span></div><div><Icon name="spark" /><span><strong>Easy onboarding</strong><small>Simple path to first value</small></span></div></div>
        </div>
      </section>
      <section className="section section--tint section--compact"><div className="container faq-layout"><div><p className="eyebrow">Pricing questions</p><h2>Keep the decision simple.</h2><p>Use concise answers to remove uncertainty without overwhelming visitors at the point of conversion.</p></div><FaqList items={faqs.slice(0, 3)} /></div></section>
      <CallToAction title="Choose the path that fits your team today." description="This demo flow leads to a presentational contact page—no payment or external action is connected." />
    </>
  );
}
