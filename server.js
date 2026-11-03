'use strict';

require('dotenv').config();
const http = require('node:http');
const path = require('node:path');
const express = require('express');
const { loadConfig } = require('./src/config');
const { createRelay } = require('./src/relay');

const config = loadConfig();

if (!config.apiKey) {
  console.error('VELMA_API_KEY is not set. Copy .env.example to .env and add your key.');
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')));
app.use('/fixtures', express.static(path.join(__dirname, 'fixtures'), { extensions: [] }));

const relay = createRelay(config);
const server = http.createServer(app);

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/stream') relay.handleUpgrade(req, socket, head);
  else socket.destroy();
});

server.listen(config.port, () => {
  console.log(`Server is running at http://localhost:${config.port}`);
});

function shutdown() {
  relay.close().then(() => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
