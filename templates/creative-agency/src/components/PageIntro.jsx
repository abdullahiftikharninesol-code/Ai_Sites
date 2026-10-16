import React from "react";

export function PageIntro({ number, eyebrow, title, description }) {
  return (
    <section className="page-intro">
      <div className="shell page-intro__grid">
        <div className="page-intro__index">
          <span>{number}</span>
          <p>{eyebrow}</p>
        </div>
        <div className="page-intro__copy">
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
      </div>
    </section>
  );
}
