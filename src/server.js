import express from 'express';
import { config } from './config.js';
import { router } from './routes.js';
import { startPoller } from './poller.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json());
app.use(router);

app.use((err, req, res, next) => {
  console.error('[server]', err.message ?? err);
  if (res.headersSent) return next(err);
  res.status(err.status ?? 500).json({ error: err.status ? err.message : 'internal_error' });
});

app.listen(config.port, () => {
  console.log(`[server] listening on :${config.port} (public: ${config.publicBaseUrl})`);
  startPoller();
});
