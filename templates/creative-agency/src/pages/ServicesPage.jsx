import React from "react";
import { Link } from "react-router-dom";
import { Arrow } from "../components/Brand.jsx";
import { PageIntro } from "../components/PageIntro.jsx";
import { services } from "../data/projects.js";

export function ServicesPage() {
  return (
    <>
      <PageIntro
        number="02"
        eyebrow="Capabilities"
        title={
          <>
            Thinking and making,
            <br />
            <em>under one roof.</em>
          </>
        }
        description="We shape the idea, the identity, and the experience as one connected story—building teams around what the work actually needs."
      />
      <section className="services-detail section-pad--bottom">
        <div className="shell detailed-services">
          {services.map((service) => (
            <article key={service.number}>
              <div className="detailed-services__title">
                <span>{service.number}</span>
                <h2>{service.title}</h2>
              </div>
              <p>{service.description}</p>
              <div>
                <small>Typical deliverables</small>
                <ul>
                  {service.deliverables.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            </article>
          ))}
        </div>
      </section>
      <section className="method-section">
        <div className="shell method-grid">
          <div>
            <p className="kicker">Our approach</p>
            <h2>
              Close collaboration.
              <br />
              Clear decisions.
              <br />
              <em>No theatre.</em>
            </h2>
          </div>
          <div className="method-copy">
            <p>
              Every engagement begins with the same thing: listening. We get close to the people,
              product, and ambition behind the brief before deciding what the work should become.
            </p>
            <p>
              From there, we work in focused stages with the people who can shape the outcome. You
              see the work early, understand why decisions are being made, and always know what
              happens next.
            </p>
            <dl>
              <div>
                <dt>01</dt>
                <dd>Senior attention from start to finish</dd>
              </div>
              <div>
                <dt>02</dt>
                <dd>Small, purpose-built project teams</dd>
              </div>
              <div>
                <dt>03</dt>
                <dd>Useful systems, not precious presentations</dd>
              </div>
            </dl>
          </div>
        </div>
      </section>
      <section className="inline-cta">
        <div className="shell">
          <p>Not sure where to begin?</p>
          <h2>Bring us the messy version.</h2>
          <Link
            className="circle-link circle-link--dark"
            to="/contact"
            aria-label="Start a conversation"
          >
            <Arrow diagonal />
          </Link>
        </div>
      </section>
    </>
  );
}
