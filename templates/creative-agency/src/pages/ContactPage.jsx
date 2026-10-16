import React, { useState } from "react";
import { Link } from "react-router-dom";
import { Arrow } from "../components/Brand.jsx";

export function ContactPage() {
  const [sent, setSent] = useState(false);
  return (
    <section className="contact-page">
      <div className="shell contact-layout">
        <div className="contact-intro">
          <p className="kicker">Start a project</p>
          <h1>
            Tell us what
            <br />
            you&apos;re <em>building.</em>
          </h1>
          <p>
            Share the rough version, the important deadline, or the question keeping you up. This
            fictional inquiry stays entirely in your browser.
          </p>
          <div className="contact-details">
            <div>
              <span>New projects</span>
              <strong>hello@northline.example</strong>
            </div>
            <div>
              <span>Elsewhere</span>
              <strong>London · Working globally</strong>
            </div>
          </div>
          <Link className="index-link" to="/work">
            View selected work <Arrow diagonal />
          </Link>
        </div>
        <div className="inquiry-panel">
          {sent ? (
            <div className="form-success" role="status">
              <span>✓</span>
              <p className="kicker">Demo inquiry complete</p>
              <h2>Thanks for sharing the beginning.</h2>
              <p>This is a template-only success state. No details were submitted or stored.</p>
              <button className="text-button" type="button" onClick={() => setSent(false)}>
                Send another note <Arrow />
              </button>
            </div>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                setSent(true);
              }}
            >
              <div className="field">
                <label htmlFor="name">Your name</label>
                <input id="name" name="name" autoComplete="name" required placeholder="Name" />
              </div>
              <div className="field-pair">
                <div className="field">
                  <label htmlFor="email">Email</label>
                  <input
                    id="email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    required
                    placeholder="you@company.com"
                  />
                </div>
                <div className="field">
                  <label htmlFor="company">Company</label>
                  <input
                    id="company"
                    name="company"
                    autoComplete="organization"
                    placeholder="Company or studio"
                  />
                </div>
              </div>
              <div className="field-pair">
                <div className="field">
                  <label htmlFor="projectType">Project type</label>
                  <select id="projectType" name="projectType" defaultValue="">
                    <option value="" disabled>
                      Select one
                    </option>
                    <option>Brand strategy</option>
                    <option>Visual identity</option>
                    <option>Website</option>
                    <option>Digital product</option>
                    <option>Something else</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="budget">Budget range</label>
                  <select id="budget" name="budget" defaultValue="">
                    <option value="" disabled>
                      Select a range
                    </option>
                    <option>Under $25k</option>
                    <option>$25k–$50k</option>
                    <option>$50k–$100k</option>
                    <option>$100k+</option>
                    <option>Still defining</option>
                  </select>
                </div>
              </div>
              <div className="field">
                <label htmlFor="details">A little about the project</label>
                <textarea
                  id="details"
                  name="details"
                  rows="5"
                  required
                  placeholder="What are you hoping to change or create?"
                />
              </div>
              <button className="submit-button" type="submit">
                Send project inquiry <Arrow diagonal />
              </button>
              <p className="form-note">Presentational form only. Nothing is transmitted.</p>
            </form>
          )}
        </div>
      </div>
    </section>
  );
}
