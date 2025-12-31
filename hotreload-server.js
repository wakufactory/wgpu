#!/usr/bin/env node
// Simple WebSocket hot-reload notifier for a single watched file.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_PORT = 8787;
const argv = process.argv.slice(2);
const portIndex = argv.indexOf('--port');
const fileIndex = argv.indexOf('--file');

const port = portIndex !== -1 && argv[portIndex + 1] ? Number(argv[portIndex + 1]) : DEFAULT_PORT;
const filePath = fileIndex !== -1 && argv[fileIndex + 1]
  ? path.resolve(argv[fileIndex + 1])
  : path.resolve(__dirname, 'compute-assets.js');

if (!Number.isFinite(port)) {
  console.error('Invalid --port value.');
  process.exit(1);
}

const sockets = new Set();
let reloadTimer = null;

function sendWsText(socket, message) {
  const payload = Buffer.from(message);
  const payloadLength = payload.length;
  let header;

  if (payloadLength < 126) {
    header = Buffer.alloc(2);
    header[1] = payloadLength;
  } else if (payloadLength < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(payloadLength, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payloadLength), 2);
  }

  header[0] = 0x81; // FIN + text frame
  socket.write(Buffer.concat([header, payload]));
}

function broadcast(message) {
  for (const socket of sockets) {
    sendWsText(socket, message);
  }
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('hot reload server\n');
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n` +
    '\r\n'
  );

  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('end', () => sockets.delete(socket));
  socket.on('error', () => sockets.delete(socket));

  sendWsText(socket, 'connected');
});

fs.watch(filePath, { persistent: true }, () => {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    console.log(`change detected: ${filePath}`);
    broadcast('reload');
  }, 100);
});

server.listen(port, () => {
  console.log(`watching: ${filePath}`);
  console.log(`ws://localhost:${port}`);
});
