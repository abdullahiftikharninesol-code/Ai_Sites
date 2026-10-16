import React, { useEffect, useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { Arrow, Brand } from "./Brand.jsx";

const links = [
  ["/work", "Work"],
  ["/services", "Services"],
  ["/about", "About"],
  ["/contact", "Contact"],
];

function useMobileNavigation() {
  const query = "(max-width: 960px)";
  const [mobile, setMobile] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMobile(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return mobile;
}

function Header() {
  const [open, setOpen] = useState(false);
  const mobile = useMobileNavigation();
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname]);
  useEffect(() => {
    if (!mobile) setOpen(false);
  }, [mobile]);

  return (
    <header className="site-header">
      <div className="site-header__inner shell">
        <Brand />
        <nav className="desktop-nav" aria-label="Primary navigation">
          {links.map(([to, label]) => (
            <NavLink key={to} to={to}>
              {label}
            </NavLink>
          ))}
        </nav>
        <Link className="header-cta" to="/contact">
          Start a project <Arrow diagonal />
        </Link>
        {mobile ? (
          <button
            className="menu-toggle"
            type="button"
            aria-expanded={open}
            aria-controls="mobile-navigation"
            onClick={() => setOpen((value) => !value)}
          >
            <span>{open ? "Close" : "Menu"}</span>
            <i aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {mobile ? (
        <nav
          id="mobile-navigation"
          className="mobile-nav"
          aria-label="Mobile navigation"
          hidden={!open}
        >
          <div className="shell mobile-nav__inner">
            {links.map(([to, label], index) => (
              <NavLink key={to} to={to}>
                <span>0{index + 1}</span>
                {label}
              </NavLink>
            ))}
            <p>
              Independent design studio
              <br />
              Working across brand and digital.
            </p>
          </div>
        </nav>
      ) : null}
    </header>
  );
}

function Footer() {
  return (
    <footer className="site-footer">
      <div className="shell footer-lead">
        <p className="kicker kicker--light">New business · 2026</p>
        <h2>
          Let&apos;s make something
          <br />
          <em>worth noticing.</em>
        </h2>
        <Link className="circle-link" to="/contact" aria-label="Start a project">
          <Arrow diagonal />
        </Link>
      </div>
      <div className="shell footer-meta">
        <Brand inverse />
        <div>
          <strong>Studio</strong>
          <span>17 Northline Yard</span>
          <span>London · Fictional address</span>
        </div>
        <div>
          <strong>Explore</strong>
          {links.map(([to, label]) => (
            <Link key={to} to={to}>
              {label}
            </Link>
          ))}
        </div>
        <div>
          <strong>Follow</strong>
          <span>Instagram ↗</span>
          <span>LinkedIn ↗</span>
          <span>Behance ↗</span>
        </div>
      </div>
      <div className="shell footer-bottom">
        <span>© 2026 Northline Studio</span>
        <span>Fictional brand and project content</span>
      </div>
    </footer>
  );
}

export function SiteShell({ children }) {
  const location = useLocation();
  useEffect(() => window.scrollTo({ top: 0, behavior: "auto" }), [location.pathname]);
  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <Header />
      <main id="main-content">{children}</main>
      <Footer />
    </>
  );
}
