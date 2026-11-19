import { createSitesVersionApi } from "./create-sites-version-api.js";
import { runProductionProcess } from "./production-process.js";
import { productionStartupFailure } from "./production-readiness.js";

// Construction is synchronous (configuration validation only); signal handlers are
// installed by runProductionProcess before any asynchronous startup work begins.
let api: ReturnType<typeof createSitesVersionApi> | undefined;
try {
  api = createSitesVersionApi();
} catch (error) {
  productionStartupFailure(error);
  process.exitCode = 1;
}
if (api) runProductionProcess(api);
