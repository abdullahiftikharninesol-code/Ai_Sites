import React from "react";
import { Link } from "react-router-dom";

export function Brand({ inverse = false }) {
  return (
    <Link
      className={`brand${inverse ? " brand--inverse" : ""}`}
      to="/"
      aria-label="Northline Studio home"
    >
      <span className="brand__mark" aria-hidden="true">
        <i />
        <i />
      </span>
      <span>
        Northline
        <br />
        Studio
      </span>
    </Link>
  );
}

export function Arrow({ diagonal = false }) {
  return (
    <span className="arrow" aria-hidden="true">
      {diagonal ? "↗" : "→"}
    </span>
  );
}
