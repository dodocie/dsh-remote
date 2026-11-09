import http from 'node:http';
import { WebSocketServer } from 'ws';

export async function startMockBackend(port = 3444) {
  const server = http.createServer((req, res) => {
    if (req.url === '/hello') {
      res.writeHead(200, { 'content-type': 'application/json', 'x-mock': 'hello' });
      res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers }));
      return;
    }
    if (req.url === '/echo') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'x-mock': 'echo' });
        res.end(Buffer.concat(chunks));
      });
      return;
    }
    if (req.url === '/cookies') {
      res.writeHead(200, {
        'content-type': 'text/plain',
        'set-cookie': [
          'a=1; Path=/; Secure; HttpOnly; SameSite=None',
          'b=2; Path=/; HttpOnly',
        ],
      });
      res.end('cookies');
      return;
    }
    if (req.url === '/big') {
      const body = Buffer.alloc(1024 * 1024, 7);
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length });
      res.end(body);
      return;
    }
    if (req.url === '/slow') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('one');
      setTimeout(() => {
        res.write('two');
        res.end('three');
      }, 100);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('mock: not found');
  });

  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const wsClients = new Set();
  // A manual handleUpgrade does not emit 'connection' on a noServer server; the
  // upgrade callback is the only place that sees every accepted socket.
  const track = (ws) => {
    wsClients.add(ws);
    ws.on('close', () => {
      wsClients.delete(ws);
    });
  };
  server.on('upgrade', (req, socket, head) => {
    if (req.url === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        track(ws);
        ws.on('message', (data, isBinary) => ws.send(data, { binary: isBinary }));
      });
      return;
    }
    if (req.url === '/ws-headers') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        track(ws);
        ws.send(JSON.stringify({ host: req.headers.host, origin: req.headers.origin }));
      });
      return;
    }
    if (req.url === '/ws-reject') {
      socket.write('HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: 5\r\nConnection: close\r\n\r\nnope\n');
      socket.destroy();
      return;
    }
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  return {
    port,
    wsClients,
    async close() {
      await new Promise((resolve) => wss.close(() => resolve()));
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
