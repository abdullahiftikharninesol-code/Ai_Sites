import { createSitesVersionApi } from "./create-sites-version-api.js";

async function main() {
  const api = createSitesVersionApi();
  const url = await api.start();
  console.log(`Sites HTTP API: ${url}`);
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

void main().catch(() => {
  console.error(
    "[sites][http] Unable to start Sites HTTP API; check configuration and Mongo connectivity",
  );
  process.exitCode = 1;
});
