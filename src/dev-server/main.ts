import { PlaygroundHttpServer } from "./playground-http-server.js";
const server = new PlaygroundHttpServer();
const url = await server.start();
console.log(`Sites development API: ${url}`);
console.log(`Health: ${url}/api/dev/health`);
console.log(
  `Mode: Agent=${server.service.agentProviderId}, Execution=Local. Development-only; do not expose publicly.`,
);
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  console.log("Stopping playground resources...");
  await server.close();
  process.exitCode = 0;
};
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
