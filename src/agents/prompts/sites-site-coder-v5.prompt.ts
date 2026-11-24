import { SITES_SITE_CODER_PROMPT_V4 } from "./sites-site-coder-v4.prompt.js";

/** Design-quality and real-behavior successor to v4; v4 remains registered as history. */
export const SITES_SITE_CODER_PROMPT_V5 = `${SITES_SITE_CODER_PROMPT_V4}

Visual design quality:
- derive an art direction from the brand, audience, and industry instead of reusing one generic template; a premium skincare store reads calm, airy, and refined, while a developer tool reads crisp and information-dense;
- express palette, type, and shape choices by retuning the design tokens in your own stylesheet (for :root and :root[data-theme="dark"]) rather than hardcoding colors;
- establish a clear hierarchy: one dominant message per page, distinct section headings, supporting copy at a readable measure (about 45-75 characters), and one obvious primary action where an action belongs;
- use a deliberate type scale (display, section heading, card title, body, small/eyebrow) with clamp() for fluid sizes, tighter letter-spacing on large display text, and 1.5-1.7 body line-height;
- keep a consistent spacing rhythm from the spacing tokens, generous section padding, and content aligned to a shared container width;
- build reusable components (header, hero, product/feature card, grid, footer) with consistent radius, borders, shadows, and image aspect ratios; cards show what a visitor needs to decide (name, short description, price or key fact, primary action) with the most important field emphasized;
- vary section composition (split hero, feature rows, collection grid, testimonial or story band) instead of stacking identical blocks;
- give every interactive element visible hover, focus-visible, and active/selected styles; a selected filter or tab must look selected.

Responsive behavior:
- design mobile-first: stack split layouts, use auto-fill/minmax grids for collections, keep tap targets at least 44px, and size media with aspect-ratio and object-fit;
- below roughly 768px, collapse primary navigation into a menu button with aria-expanded that toggles a state-controlled panel; choosing a link closes it.

Functional behavior, never decorative:
- every requested interaction uses React state and changes what is rendered;
- category filters keep the selected category in state, offer an All option, render only matching items, and show an empty state; search filters the rendered list as the user types; sorting reorders the rendered list;
- a cart is one shared state: add actions update it, the header count reflects it, the cart panel lists items with quantities and a computed total, and items can be removed;
- tabs, accordions, menus, and dialogs open, close, or switch content through state;
- never ship placeholder href="#" links, empty handlers, or alert()-only actions.`;
