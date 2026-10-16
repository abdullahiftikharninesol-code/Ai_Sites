import React from "react";
import { Link } from "react-router-dom";

export function Brand({ inverse = false }) {
  return (
    <Link className={`brand${inverse ? " brand--inverse" : ""}`} to="/" aria-label="FlowPilot home">
      <span className="brand__mark" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span>FlowPilot</span>
    </Link>
  );
}
