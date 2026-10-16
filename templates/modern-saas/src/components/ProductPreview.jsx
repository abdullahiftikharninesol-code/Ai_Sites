import React from "react";

export function ProductPreview() {
  return (
    <div className="product-preview" aria-label="Illustrative FlowPilot dashboard preview">
      <div className="product-preview__topbar">
        <span className="window-dot" />
        <span className="window-dot" />
        <span className="window-dot" />
        <span className="product-preview__address">flowpilot / launch-plan</span>
        <span className="product-preview__demo">Demo data</span>
      </div>
      <div className="product-preview__body">
        <aside className="product-preview__sidebar" aria-hidden="true">
          <div className="preview-logo" />
          <span className="sidebar-line sidebar-line--active" />
          <span className="sidebar-line" />
          <span className="sidebar-line sidebar-line--short" />
          <span className="sidebar-line" />
        </aside>
        <div className="product-preview__content">
          <div className="preview-heading">
            <div><span>Launch workspace</span><strong>Q3 product launch</strong></div>
            <button type="button" tabIndex="-1">Share</button>
          </div>
          <div className="metric-row">
            <div><span>On track</span><strong>84%</strong><small>Plan health</small></div>
            <div><span>Momentum</span><strong>+18%</strong><small>This cycle</small></div>
            <div><span>Focus</span><strong>12</strong><small>Open priorities</small></div>
          </div>
          <div className="preview-lower">
            <div className="progress-card">
              <div className="preview-card-heading"><strong>Weekly progress</strong><span>Last 6 weeks</span></div>
              <div className="chart" aria-hidden="true">
                <span style={{ height: "28%" }} />
                <span style={{ height: "40%" }} />
                <span style={{ height: "35%" }} />
                <span style={{ height: "58%" }} />
                <span style={{ height: "68%" }} />
                <span style={{ height: "82%" }} />
              </div>
            </div>
            <div className="priority-card">
              <div className="preview-card-heading"><strong>Priorities</strong><span>3 active</span></div>
              {["Finalize launch brief", "Review onboarding", "Align enablement"].map((item, index) => (
                <div className="priority-item" key={item}>
                  <span className={`priority-check${index === 0 ? " priority-check--done" : ""}`}>{index === 0 ? "✓" : ""}</span>
                  <span>{item}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
