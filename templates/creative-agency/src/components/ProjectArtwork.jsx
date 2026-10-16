import React from "react";

export function ProjectArtwork({ variant, title, compact = false }) {
  return (
    <div
      className={`project-art project-art--${variant}${compact ? " project-art--compact" : ""}`}
      aria-hidden="true"
    >
      {variant === "arc" && (
        <>
          <div className="arc-poster">
            <small>Stay curious</small>
            <strong>
              ARC
              <br />
              HOUSE
            </strong>
            <span>36°</span>
          </div>
          <div className="arc-disc">
            <i>AH</i>
          </div>
          <p>
            Good rooms.
            <br />
            Great company.
          </p>
        </>
      )}
      {variant === "noma" && (
        <>
          <div className="noma-word">NOMA</div>
          <div className="noma-card">
            <span>
              Tomorrow,
              <br />
              made tangible.
            </span>
            <b>NF / 26</b>
          </div>
          <svg viewBox="0 0 240 120">
            <path
              d="M8 103 C45 90 52 48 86 59 S130 94 154 47 S196 32 232 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
            />
          </svg>
        </>
      )}
      {variant === "forma" && (
        <>
          <div className="forma-type">FORMA</div>
          <div className="forma-object">
            <i />
            <i />
            <i />
          </div>
          <p>
            Objects for
            <br />
            everyday rituals.
          </p>
        </>
      )}
      {variant === "solis" && (
        <>
          <div className="solis-sun">
            <span />
          </div>
          <strong>SOLIS</strong>
          <div className="solis-note">
            Care, made clear
            <br />
            for every day.
          </div>
        </>
      )}
      {variant === "fieldnote" && (
        <>
          <div className="fieldnote-index">
            ISSUE
            <br />
            <b>07</b>
          </div>
          <div className="fieldnote-title">
            FIELD
            <br />
            NOTE
          </div>
          <div className="fieldnote-line">People / Places / Practice</div>
        </>
      )}
      <span className="sr-only">Concept artwork for {title}</span>
    </div>
  );
}
