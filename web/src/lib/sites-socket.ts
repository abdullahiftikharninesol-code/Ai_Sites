import {
  createLocalSitesSocket,
  SitesSocketTransport,
  type SitesSocketConnection,
} from "../sites-socket-transport";
import { sitesEnvironment } from "./environment";

export interface SitesSocketBootstrap {
  readonly connection: SitesSocketConnection;
  readonly transport: SitesSocketTransport;
}

export const createStandaloneSitesSocket = (): SitesSocketBootstrap => {
  const connection = createLocalSitesSocket(sitesEnvironment.socketUrl);
  return { connection, transport: new SitesSocketTransport(connection) };
};
