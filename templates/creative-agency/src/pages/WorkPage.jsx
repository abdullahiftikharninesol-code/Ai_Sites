import React from "react";
import { Link } from "react-router-dom";
import { Arrow } from "../components/Brand.jsx";
import { PageIntro } from "../components/PageIntro.jsx";
import { ProjectArtwork } from "../components/ProjectArtwork.jsx";
import { projects } from "../data/projects.js";

export function WorkPage() {
  return (
    <>
      <PageIntro
        number="01"
        eyebrow="Selected work · 2024—2026"
        title={
          <>
            Work made to be <em>remembered.</em>
          </>
        }
        description="A selection of fictional brand and digital projects showing how a clear idea can stretch from identity to experience."
      />
      <section className="work-index section-pad--bottom">
        <div className="shell work-list">
          {projects.map((project, index) => (
            <article className={`work-entry work-entry--${index % 3}`} key={project.slug}>
              <div className="work-entry__visual">
                <ProjectArtwork variant={project.variant} title={project.name} />
              </div>
              <div className="work-entry__content">
                <p>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  {project.category}
                </p>
                <h2>{project.name}</h2>
                <p>{project.summary}</p>
                <div>
                  <span>{project.year}</span>
                  <Link to="/contact">
                    Discuss a similar project <Arrow diagonal />
                  </Link>
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>
      <section className="work-close">
        <div className="shell">
          <p className="kicker kicker--light">The next one</p>
          <h2>
            Your project could start
            <br />
            with a <em>good conversation.</em>
          </h2>
          <Link className="text-button text-button--light" to="/contact">
            Tell us what&apos;s next <Arrow />
          </Link>
        </div>
      </section>
    </>
  );
}
