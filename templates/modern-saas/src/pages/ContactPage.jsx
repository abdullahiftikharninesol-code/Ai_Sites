import React, { useState } from "react";
import { Icon } from "../components/Icon.jsx";
import { PageHero } from "../components/PageHero.jsx";

export function ContactPage() {
  const [submitted, setSubmitted] = useState(false);

  function handleSubmit(event) {
    event.preventDefault();
    setSubmitted(true);
  }

  return (
    <>
      <PageHero eyebrow="Start a conversation" title="Tell us what your team is working toward." description="This page demonstrates a polished SaaS contact experience. The form stays entirely in the browser and does not send data anywhere." actionLabel="Prefer to explore first? View features" actionTo="/features" />
      <section className="section section--compact contact-section">
        <div className="container contact-grid">
          <div className="contact-aside">
            <p className="eyebrow">What to expect</p>
            <h2>A useful first conversation.</h2>
            <p>Use this space to set expectations for prospects and route them toward the right next step.</p>
            <ul className="contact-points">
              <li><span><Icon name="target" /></span><div><strong>Share your goals</strong><p>Tell us what you want to improve and where the current workflow feels difficult.</p></div></li>
              <li><span><Icon name="workflow" /></span><div><strong>Explore a fit</strong><p>Walk through the product story and identify the most relevant capabilities.</p></div></li>
              <li><span><Icon name="users" /></span><div><strong>Plan the next step</strong><p>Leave with a clear recommendation—without pressure or an external action.</p></div></li>
            </ul>
            <div className="contact-note"><strong>Demo behavior</strong><p>Submitting this form only shows a local success message. No details are transmitted or stored.</p></div>
          </div>
          <div className="form-card">
            {submitted ? (
              <div className="form-success" role="status">
                <span><Icon name="check" size={28} /></span>
                <p className="eyebrow">Demo submitted</p>
                <h2>Thanks—your example message is ready.</h2>
                <p>No information was sent. In a real implementation, connect this state to your approved form workflow.</p>
                <button className="button button--secondary" type="button" onClick={() => setSubmitted(false)}>Send another demo message</button>
              </div>
            ) : (
              <form onSubmit={handleSubmit}>
                <div className="form-heading"><h2>How can we help?</h2><p>All fields are presentational template inputs.</p></div>
                <div className="field-row">
                  <label htmlFor="first-name">First name<input id="first-name" name="firstName" type="text" autoComplete="given-name" required placeholder="Avery" /></label>
                  <label htmlFor="last-name">Last name<input id="last-name" name="lastName" type="text" autoComplete="family-name" required placeholder="Morgan" /></label>
                </div>
                <label htmlFor="work-email">Work email<input id="work-email" name="email" type="email" autoComplete="email" required placeholder="avery@example.com" /></label>
                <label htmlFor="company">Company<input id="company" name="company" type="text" autoComplete="organization" required placeholder="Example company" /></label>
                <label htmlFor="team-size">Team size<select id="team-size" name="teamSize" defaultValue="" required><option value="" disabled>Select a range</option><option>1–10</option><option>11–50</option><option>51–250</option><option>251+</option></select></label>
                <label htmlFor="message">What would you like to improve?<textarea id="message" name="message" rows="4" required placeholder="Share a little about your workflow and goals." /></label>
                <button className="button form-submit" type="submit">Submit demo inquiry<Icon name="arrow" size={17} /></button>
                <small className="form-disclaimer">Presentational form only. No network request will be made.</small>
              </form>
            )}
          </div>
        </div>
      </section>
    </>
  );
}
