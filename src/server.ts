import express from 'express';
import { config } from './config';

export const app = express();

app.use(express.json());

// Liveness probe. Auth and item routes arrive in later phases.
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Only bind a port when this file is the process entry point
// (node dist/server.js / tsx src/server.ts). Importing `app` in tests must not listen.
if (require.main === module) {
  app.listen(config.PORT, () => {
    console.log(`Newtonite Ops API listening on port ${config.PORT}`);
  });
}
