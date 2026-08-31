import { Hono } from 'hono';
import { HttpError } from './api/auth.js';
import { getAutomation } from './api/get-automation.js';
import { startAutomation } from './api/start-automation.js';
import { submitDecision } from './api/submit-decision.js';
import { orderStore } from './domain/order-store.js';
import { exampleSource } from './sandbox/example-source.js';

const app = new Hono();

app.get('/api/example-source', c => c.json({ source: exampleSource }));

app.post('/api/automations', async c => await startAutomation(c.req.raw));

app.get('/api/automations/:automationId', async c => {
  const runId = c.req.query('runId');
  if (!runId) throw new HttpError(400, 'runId is required.');
  return await getAutomation(c.req.raw, c.req.param('automationId'), runId);
});

app.post(
  '/api/automations/:automationId/decision',
  async c => await submitDecision(c.req.raw, c.req.param('automationId')),
);

app.get('/api/orders/stats', c => c.json(orderStore.stats()));

app.onError((error, c) => {
  if (error instanceof HttpError) {
    return c.json({ error: error.message }, error.status as 400 | 403 | 404);
  }
  console.error(error);
  return c.json({ error: 'Internal server error.' }, 500);
});

export default app;
