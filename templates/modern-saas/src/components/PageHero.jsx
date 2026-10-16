import React from "react";
import { Link } from "react-router-dom";
import { Icon } from "./Icon.jsx";

export function PageHero({ eyebrow, title, description, actionLabel = "Start a conversation", actionTo = "/contact", aside }) {
  return (
    <section className="page-hero">
      <div className={`container page-hero__grid${aside ? " page-hero__grid--aside" : ""}`}>
        <div className="page-hero__copy">
          <p className="eyebrow">{eyebrow}</p>
          <h1>{title}</h1>
          <p>{description}</p>
          <Link className="text-link" to={actionTo}>{actionLabel}<Icon name="arrow" size={17} /></Link>
        </div>
        {aside ? <div className="page-hero__aside">{aside}</div> : null}
      </div>
    </section>
  );
}
