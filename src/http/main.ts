import { createSitesVersionApi } from "./create-sites-version-api.js";
import { productionStartupFailure } from "./production-readiness.js";

async function main() {
  const api = createSitesVersionApi();
  await api.start();
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await api.close();
  };
  process.once("SIGINT", () => {
    void close().catch(() => {
      process.exitCode = 1;
    });
  });
  process.once("SIGTERM", () => {
    void close().catch(() => {
      process.exitCode = 1;
    });
  });
}

void main().catch((error: unknown) => {
  productionStartupFailure(error);
  process.exitCode = 1;
});
