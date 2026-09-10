import 'dotenv/config';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { readConfig } from './config.js';
import { createDatabase } from './db.js';

const config = readConfig();
const db = createDatabase(config);
const app = createApp({ db, config });
const server = serve(
  { fetch: app.fetch, hostname: config.host, port: config.port },
  () => {
    console.log(`MineTenant Hono API: http://${config.host}:${config.port}`);
  },
);

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close(() => {
    void db.close().then(() => process.exit(0));
  });
  setTimeout(() => {
    if ('closeAllConnections' in server) server.closeAllConnections();
    process.exit(1);
  }, 10_000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
