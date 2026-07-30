import express from 'express';
import { config } from './config.js';
import { router } from './routes.js';
import { startPoller } from './poller.js';
import { reconcile } from './eventsub.js';
import { reconcile as reconcileKick } from './kickevents.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({
  verify(req, res, buf) {
    req.rawBody = buf;
  },
}));
app.use(router);

app.use((err, req, res, next) => {
  console.error('[server]', err.message ?? err);
  if (res.headersSent) return next(err);
  res.status(err.status ?? 500).json({ error: err.status ? err.message : 'internal_error' });
});

app.listen(config.port, () => {
  console.log(`[server] listening on :${config.port} (public: ${config.publicBaseUrl})`);
  startPoller();
  reconcile();
  reconcileKick();
});
