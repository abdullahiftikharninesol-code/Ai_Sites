import { SITES_SITE_CODER_PROMPT_V2 } from "./sites-site-coder-v2.prompt.js";

/** Asset-aware successor; v2 remains registered for rollback. */
export const SITES_SITE_CODER_PROMPT_V3 = `${SITES_SITE_CODER_PROMPT_V2}

Asset rules:
- use only public paths provided by the Asset manifest for website media;
- do not invent remote image URLs, data-image URIs, or stock-provider URLs;
- do not write, replace, or remove Sites-managed asset binaries under public/__sites/assets;
- use the supplied asset alt-text and decorative metadata faithfully.`;
