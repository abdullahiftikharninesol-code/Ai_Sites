/**
 * Backward-compatible export name for callers of the former local persistence
 * composition root. Persistent Sites products are Mongo-backed.
 */
export {
  createMongoPersistentSitesProduct as createLocalPersistentSitesProduct,
  type MongoPersistentSitesProductOptions as LocalPersistentSitesProductOptions,
} from "./create-mongo-persistent-sites-product.js";
