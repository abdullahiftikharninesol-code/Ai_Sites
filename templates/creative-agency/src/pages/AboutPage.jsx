import React from "react";
import { Link } from "react-router-dom";
import { Arrow } from "../components/Brand.jsx";
import { PageIntro } from "../components/PageIntro.jsx";

const team = [
  ["EP", "Elena Park", "Strategy Director", "team-a"],
  ["JM", "Jonah Mercer", "Creative Director", "team-b"],
  ["AR", "Amina Rahal", "Design Director", "team-c"],
  ["LC", "Leo Chen", "Digital Lead", "team-d"],
];

export function AboutPage() {
  return (
    <>
      <PageIntro
        number="03"
        eyebrow="About Northline"
        title={
          <>
            Independent by choice.
            <br />
            <em>Collaborative by nature.</em>
          </>
        }
        description="Northline is a fictional strategy and design studio built around a simple belief: the best work happens when thinking and making stay close."
      />
      <section className="about-story section-pad--bottom">
        <div className="shell story-layout">
          <div className="story-art" aria-hidden="true">
            <span>N</span>
            <i />
            <b>
              STUDIO
              <br />
              NOTES
              <br />
              VOL. 01
            </b>
          </div>
          <div className="story-copy">
            <p className="kicker">The studio</p>
            <h2>
              Small enough to stay close.
              <br />
              Experienced enough to go deep.
            </h2>
            <p>
              We imagined Northline as the kind of studio we would want to work with: curious,
              direct, and more interested in the right answer than the familiar one.
            </p>
            <p>
              Our fictional team brings together brand strategy, identity, digital design, and
              creative direction. We partner with founders and established teams at moments of
              change—when the story needs focus and the experience needs a new point of view.
            </p>
          </div>
        </div>
      </section>
      <section className="values-section">
        <div className="shell">
          <p className="kicker kicker--light">What keeps us honest</p>
          <div className="value-lines">
            {[
              ["01", "Clarity over noise", "Make the important thing impossible to miss."],
              [
                "02",
                "Ideas before aesthetics",
                "A strong visual choice should carry a strong reason.",
              ],
              ["03", "Useful is beautiful", "Design earns attention by helping people move."],
              ["04", "Generous collaboration", "The best idea can come from anywhere in the room."],
            ].map(([n, title, text]) => (
              <article key={n}>
                <span>{n}</span>
                <h3>{title}</h3>
                <p>{text}</p>
              </article>
            ))}
          </div>
        </div>
      </section>
      <section className="team-section section-pad">
        <div className="shell section-heading">
          <div>
            <p className="kicker">Small team, broad perspective</p>
            <h2>
              Meet the fictional
              <br />
              <em>Northline team.</em>
            </h2>
          </div>
          <p className="section-note">
            Senior practitioners stay close to every project, supported by a trusted network of
            makers and specialists.
          </p>
        </div>
        <div className="shell team-grid">
          {team.map(([initials, name, role, style]) => (
            <article key={name}>
              <div className={`team-portrait ${style}`}>
                <span>{initials}</span>
                <i />
              </div>
              <h3>{name}</h3>
              <p>{role}</p>
              <small>Fictional profile</small>
            </article>
          ))}
        </div>
      </section>
      <section className="about-close">
        <div className="shell">
          <p className="kicker">Working together</p>
          <h2>
            We like ambitious briefs,
            <br />
            plain language, and <em>open doors.</em>
          </h2>
          <Link className="text-button" to="/contact">
            Meet us at the beginning <Arrow />
          </Link>
        </div>
      </section>
    </>
  );
}
