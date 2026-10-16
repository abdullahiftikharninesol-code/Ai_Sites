import React from "react";
import { Link } from "react-router-dom";
import { Arrow } from "../components/Brand.jsx";
import { ProjectArtwork } from "../components/ProjectArtwork.jsx";
import { ProjectFeature } from "../components/ProjectFeature.jsx";
import { projects, services } from "../data/projects.js";

export function HomePage() {
  return (
    <>
      <section className="home-hero">
        <div className="shell home-hero__grid">
          <div className="home-hero__copy">
            <p className="kicker">
              <span>Independent creative studio</span>
              <span>London · Everywhere</span>
            </p>
            <h1>
              Brands and digital experiences built to <em>move.</em>
            </h1>
            <div className="hero-actions">
              <p>
                Northline Studio helps ambitious teams find a sharper story and bring it to life
                through brand, product, and digital design.
              </p>
              <div>
                <Link className="text-button" to="/work">
                  View our work <Arrow />
                </Link>
                <Link className="text-button text-button--quiet" to="/contact">
                  Start a project <Arrow diagonal />
                </Link>
              </div>
            </div>
          </div>
          <div className="hero-composition">
            <div className="hero-composition__stamp">
              Selected work
              <br />
              2024—2026
            </div>
            <ProjectArtwork variant="arc" title="Arc House" />
            <div className="hero-composition__caption">
              <span>01 / Arc House</span>
              <span>Brand identity · Digital</span>
            </div>
          </div>
        </div>
        <div className="shell hero-footnote">
          <span>Strategy</span>
          <span>Identity</span>
          <span>Digital</span>
          <span>Direction</span>
        </div>
      </section>

      <section className="work-preview section-pad">
        <div className="shell section-heading">
          <div>
            <p className="kicker">Selected work</p>
            <h2>
              A few things we&apos;ve
              <br />
              helped <em>take shape.</em>
            </h2>
          </div>
          <Link className="index-link" to="/work">
            All projects <Arrow diagonal />
          </Link>
        </div>
        <div className="shell project-grid">
          {projects.slice(0, 3).map((project, index) => (
            <ProjectFeature
              key={project.slug}
              project={project}
              index={index}
              featured={index === 0}
            />
          ))}
        </div>
      </section>

      <section className="studio-statement">
        <div className="shell statement-grid">
          <p className="kicker kicker--light">What we believe</p>
          <div>
            <h2>
              Good design creates clarity.
              <br />
              <em>Great design creates momentum.</em>
            </h2>
            <p>
              We work where strategy and expression meet—helping businesses say what matters, look
              unmistakable, and move with confidence.
            </p>
            <Link className="text-button text-button--light" to="/about">
              Inside the studio <Arrow />
            </Link>
          </div>
        </div>
      </section>

      <section className="services-preview section-pad">
        <div className="shell section-heading section-heading--compact">
          <div>
            <p className="kicker">What we do</p>
            <h2>
              Built around the
              <br />
              problem, <em>not a package.</em>
            </h2>
          </div>
          <p className="section-note">
            From early positioning to the final responsive detail, we bring the right disciplines
            together around one clear idea.
          </p>
        </div>
        <div className="shell service-list">
          {services.slice(0, 4).map((service) => (
            <Link className="service-row" to="/services" key={service.number}>
              <span>{service.number}</span>
              <h3>{service.title}</h3>
              <p>{service.description}</p>
              <Arrow diagonal />
            </Link>
          ))}
        </div>
      </section>

      <section className="process-band">
        <div className="shell">
          <div className="process-lead">
            <p className="kicker">How we work</p>
            <h2>A clear path from first question to final detail.</h2>
          </div>
          <ol className="process-steps">
            {[
              ["01", "Discover", "Listen closely and find the real opportunity."],
              ["02", "Define", "Build the strategic idea that holds it together."],
              ["03", "Design", "Explore boldly, refine carefully, make it useful."],
              ["04", "Deliver", "Launch with clarity and tools built to last."],
            ].map(([n, title, text]) => (
              <li key={n}>
                <span>{n}</span>
                <h3>{title}</h3>
                <p>{text}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="testimonial section-pad">
        <div className="shell testimonial-grid">
          <p className="kicker">Illustrative client perspective</p>
          <blockquote>
            “Northline found the idea we had been circling for years—and made it feel obvious,
            distinct, and completely our own.”
          </blockquote>
          <div className="testimonial-person">
            <span>MK</span>
            <p>
              <strong>Mara Klein</strong>
              <br />
              Founder, Arc House · Fictional profile
            </p>
          </div>
        </div>
      </section>
    </>
  );
}
