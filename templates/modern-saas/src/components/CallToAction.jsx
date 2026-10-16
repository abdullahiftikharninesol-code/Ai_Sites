import React from "react";
import { Link } from "react-router-dom";
import { Icon } from "./Icon.jsx";

export function CallToAction({ title = "Give your team a clearer way to move forward.", description = "Use this flexible template to present your product with confidence, clarity, and a focused next step." }) {
  return (
    <section className="cta-section">
      <div className="container cta-panel">
        <div>
          <p className="eyebrow eyebrow--light">Ready when you are</p>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        <div className="cta-panel__actions">
          <Link className="button button--light" to="/contact">Start a conversation<Icon name="arrow" size={17} /></Link>
          <Link className="button button--ghost-light" to="/pricing">View example pricing</Link>
        </div>
      </div>
    </section>
  );
}
