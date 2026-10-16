import React, { useEffect, useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { navigation } from "../data/content.js";
import { Brand } from "./Brand.jsx";
import { Icon } from "./Icon.jsx";

function Header() {
  const [menuOpen, setMenuOpen] = useState(false);
  const { pathname } = useLocation();

  useEffect(() => setMenuOpen(false), [pathname]);

  return (
    <header className="site-header">
      <div className="container site-header__inner">
        <Brand />
        <nav className="desktop-nav" aria-label="Primary navigation">
          {navigation.map((item) => (
            <NavLink key={item.to} to={item.to} className={({ isActive }) => isActive ? "nav-link nav-link--active" : "nav-link"}>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <Link className="button button--small desktop-cta" to="/contact">Get started</Link>
        <button
          className="mobile-menu-button"
          type="button"
          aria-controls="mobile-navigation"
          aria-label={menuOpen ? "Close navigation" : "Open navigation"}
          aria-pressed={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <Icon name={menuOpen ? "close" : "menu"} size={22} />
        </button>
      </div>
      <nav
        id="mobile-navigation"
        className={`mobile-nav${menuOpen ? " mobile-nav--open" : ""}`}
        aria-label="Mobile navigation"
        hidden={!menuOpen}
      >
        <div className="container mobile-nav__inner">
          {navigation.map((item) => <NavLink key={item.to} to={item.to}>{item.label}</NavLink>)}
          <Link className="button" to="/contact">Get started</Link>
        </div>
      </nav>
    </header>
  );
}

function Footer() {
  return (
    <footer className="site-footer">
      <div className="container footer-grid">
        <div className="footer-brand">
          <Brand inverse />
          <p>A flexible foundation for modern software teams and the products they build.</p>
        </div>
        <div>
          <h2>Product</h2>
          <Link to="/features">Features</Link>
          <Link to="/pricing">Pricing</Link>
          <Link to="/contact">Contact</Link>
        </div>
        <div>
          <h2>Company</h2>
          <Link to="/about">About</Link>
          <Link to="/features">Our approach</Link>
          <Link to="/contact">Get in touch</Link>
        </div>
        <div>
          <h2>Template note</h2>
          <p>FlowPilot is a fictional brand. Replace this demo content before launch.</p>
        </div>
      </div>
      <div className="container footer-bottom">
        <span>© 2026 FlowPilot template.</span>
        <span>Designed for clarity and momentum.</span>
      </div>
    </footer>
  );
}

export function SiteLayout({ children }) {
  return (
    <div className="site-shell">
      <Header />
      <main>{children}</main>
      <Footer />
    </div>
  );
}
