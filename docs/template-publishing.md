# Internal template publishing

Templates are published with `npm run template:publish -- --dir <template-directory> --dry-run` before any live publication. Authoring source must include `site-template.json`, `package.json`, a supported lockfile, and `src/`; authors do not supply a `previews/` directory.

The publisher copies clean source into a temporary workspace, installs and builds it, serves only the production `dist/` directory on a dynamic loopback port, runs mandatory Browser QA over every manifest route at desktop, tablet, and mobile sizes, and generates fixed-viewport `desktop.webp`, `tablet.webp`, and `mobile.webp` previews from `/`. The source ZIP excludes generated previews.

Dry-run performs the local build, Browser QA, screenshot generation, ZIP/hash calculation, and object-path planning. It does not access GCS or write Mongo or Redis. Live publication is a separate invocation without `--dry-run` and requires `SITES_TEMPLATE_GCS_BUCKET` plus the existing persistence configuration.

Artifacts use the deterministic `sites/templates/<templateKey>/v<version>/` prefix in the configured bucket. Mongo stores only catalog metadata, `sourceObject`, `sourceSha256`, and preview object paths; provider, bucket, ZIP size, and source bytes remain outside template documents. Public catalog responses omit source metadata and resolve preview object paths to `https://storage.googleapis.com/<bucket>/<object>` using centralized configuration.
