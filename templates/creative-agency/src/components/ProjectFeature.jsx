import React from "react";
import { Link } from "react-router-dom";
import { Arrow } from "./Brand.jsx";
import { ProjectArtwork } from "./ProjectArtwork.jsx";

export function ProjectFeature({ project, index, featured = false }) {
  return (
    <article className={`project-feature${featured ? " project-feature--featured" : ""}`}>
      <Link
        className="project-feature__visual"
        to="/work"
        aria-label={`View ${project.name} project`}
      >
        <ProjectArtwork variant={project.variant} title={project.name} />
      </Link>
      <div className="project-feature__meta">
        <span>{String(index + 1).padStart(2, "0")}</span>
        <div>
          <h3>{project.name}</h3>
          <p>{project.category}</p>
        </div>
        <span>{project.year}</span>
        <Link to="/work" aria-label={`Read about ${project.name}`}>
          <Arrow diagonal />
        </Link>
      </div>
    </article>
  );
}
