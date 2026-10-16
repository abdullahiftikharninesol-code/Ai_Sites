import React from "react";

export function SectionIntro({ eyebrow, title, description, align = "left" }) {
  return (
    <div className={`section-intro section-intro--${align}`}>
      {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
      <h2>{title}</h2>
      {description ? <p className="section-intro__description">{description}</p> : null}
    </div>
  );
}
