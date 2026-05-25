'use strict';

const functions = require('@google-cloud/functions-framework');
const { route } = require('./src/routes');

// One HTTP entry point — functions-framework registers this; Cloud Run
// invokes it for every request and we route internally on (method, path).
functions.http('app', async (req, res) => {
  try {
    await route(req, res);
  } catch (err) {
    console.error('Top-level handler error:', err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: err.message || 'Internal error' }));
    }
  }
});
