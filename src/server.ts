import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config';
import { authRouter } from './auth/routes';
import { itemsRouter } from './items/routes';
import { errorHandler } from './middleware/errors';

export const app = express();

app.use(
  express.json({
    // Keep the exact request bytes: idempotency request_hash is SHA-256 of the raw body.
    verify: (req, _res, buf) => {
      (req as unknown as Request).rawBody = Buffer.from(buf);
    },
  })
);

// Malformed JSON bodies are a client error, not a server error. Sits right
// after express.json(); everything that is not a body-parse SyntaxError is
// delegated to the final errorHandler.
app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } });
    return;
  }
  next(err);
});

// Liveness probe.
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.use(authRouter);
app.use(itemsRouter);

// Production: serve the built frontend (web/dist); in dev the Vite server
// proxies API calls instead (see web/vite.config.ts). Skipped when the build
// is absent, so `tsx src/server.ts` during development is unaffected.
const webDist = path.join(__dirname, '..', 'web', 'dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  // SPA fallback: any other GET (not /auth, /me, /items, /health) -> index.html.
  app.use((req, res, next) => {
    if (req.method === 'GET' && !/^\/(auth|me|items|health)(\/|$)/.test(req.path)) {
      res.sendFile(path.join(webDist, 'index.html'));
      return;
    }
    next();
  });
}

// Error handler must be registered last.
app.use(errorHandler);

// Only bind a port when this file is the process entry point
// (node dist/server.js / tsx src/server.ts). Importing `app` in tests must not listen.
if (require.main === module) {
  app.listen(config.PORT, () => {
    console.log(`Newtonite Ops API listening on port ${config.PORT}`);
  });
}
