import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import yaml from 'js-yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 完整 Web 服务器 — REST API + WebSocket + UI
 */
export class WebServer {
  constructor({ port = 8080, testRunner }) {
    this.port = port;
    this.runner = testRunner;
    this._server = null;
    this._wss = null;
    this._clients = new Set();
  }

  async start() {
    await this._createServer();
    this._bindRunnerEvents();
    console.log(`[WebServer] 已启动: http://localhost:${this.port}`);
  }

  _createServer() {
    return new Promise((resolve, reject) => {
      this._server = http.createServer((req, res) => {
        this._handleRequest(req, res);
      });

      this._wss = new WebSocketServer({ server: this._server });
      this._wss.on('connection', (ws) => {
        this._clients.add(ws);
        ws.on('close', () => this._clients.delete(ws));
        ws.on('error', () => this._clients.delete(ws));

        // 连接时推送当前状态
        ws.send(JSON.stringify({
          type: 'status',
          data: this.runner.getStatus(),
        }));
      });

      this._server.listen(this.port, () => resolve());
      this._server.on('error', reject);
    });
  }

  _bindRunnerEvents() {
    this.runner.on('snapshot', (snap) => {
      this._broadcast({ type: 'snapshot', data: snap });
    });

    this.runner.on('log', (entry) => {
      this._broadcast({ type: 'log', data: entry });
    });

    this.runner.on('completed', (snap) => {
      this._broadcast({ type: 'completed', data: snap });
    });

    this.runner.on('error', (msg) => {
      this._broadcast({ type: 'error', data: { message: msg } });
    });

    this.runner.on('report', (files) => {
      this._broadcast({ type: 'report', data: files });
    });
  }

  _broadcast(msg) {
    const str = JSON.stringify(msg);
    for (const ws of this._clients) {
      if (ws.readyState === 1) ws.send(str);
    }
  }

  async _handleRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    // === 页面路由 ===
    if (pathname === '/' || pathname === '/index.html') {
      return this._serveFile(res, path.join(__dirname, 'ui.html'), 'text/html; charset=utf-8');
    }

    // === API 路由 ===
    if (pathname === '/api/status' && req.method === 'GET') {
      return this._json(res, this.runner.getStatus());
    }

    if (pathname === '/api/start' && req.method === 'POST') {
      return this._withBody(req, res, (body) => {
        try {
          const result = this.runner.start(body);
          this._json(res, { ok: true, ...result });
        } catch (err) {
          this._json(res, { ok: false, error: err.message }, 400);
        }
      });
    }

    if (pathname === '/api/stop' && req.method === 'POST') {
      try {
        const result = this.runner.stop();
        this._json(res, { ok: true, ...result });
      } catch (err) {
        this._json(res, { ok: false, error: err.message }, 400);
      }
      return;
    }

    if (pathname === '/api/logs' && req.method === 'GET') {
      const offset = Number(url.searchParams.get('offset')) || 0;
      return this._json(res, { logs: this.runner.getLogs(offset) });
    }

    if (pathname === '/api/reports' && req.method === 'GET') {
      return this._listReports(res);
    }

    if (pathname.startsWith('/api/reports/') && req.method === 'GET') {
      const filename = pathname.slice('/api/reports/'.length);
      return this._serveReport(res, filename);
    }

    if (pathname === '/api/config/default' && req.method === 'GET') {
      return this._getDefaultConfig(res);
    }

    if (pathname === '/api/config/save' && req.method === 'POST') {
      return this._withBody(req, res, (body) => {
        try {
          this._saveConfig(body.yaml);
          this._json(res, { ok: true });
        } catch (err) {
          this._json(res, { ok: false, error: err.message }, 400);
        }
      });
    }

    if (pathname === '/api/config/parsed' && req.method === 'GET') {
      return this._getParsedConfig(res);
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  }

  _json(res, data, status = 200) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  }

  _withBody(req, res, handler) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        handler(JSON.parse(body));
      } catch (err) {
        this._json(res, { ok: false, error: '请求体格式错误' }, 400);
      }
    });
  }

  _serveFile(res, filePath, contentType) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    } catch {
      res.writeHead(500);
      res.end('文件读取失败');
    }
  }

  _listReports(res) {
    const reportDir = path.resolve('./reports');
    if (!fs.existsSync(reportDir)) {
      return this._json(res, { reports: [] });
    }

    const files = fs.readdirSync(reportDir)
      .filter(f => f.endsWith('.json') || f.endsWith('.html') || f.endsWith('.csv') || f.endsWith('.md'))
      .sort()
      .reverse()
      .map(f => ({
        name: f,
        size: fs.statSync(path.join(reportDir, f)).size,
        time: fs.statSync(path.join(reportDir, f)).mtime.toISOString(),
      }));

    this._json(res, { reports: files });
  }

  _serveReport(res, filename) {
    const filePath = path.resolve(path.join('./reports', filename));
    // 安全检查：防止路径遍历
    if (!filePath.startsWith(path.resolve('./reports'))) {
      return this._json(res, { error: 'Forbidden' }, 403);
    }
    if (!fs.existsSync(filePath)) {
      return this._json(res, { error: 'Not Found' }, 404);
    }

    const ext = path.extname(filename);
    const types = {
      '.json': 'application/json',
      '.html': 'text/html; charset=utf-8',
      '.csv': 'text/csv',
      '.md': 'text/markdown; charset=utf-8',
    };
    this._serveFile(res, filePath, types[ext] || 'text/plain');
  }

  _getDefaultConfig(res) {
    const configPath = path.resolve('./config/config.yaml');
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf8');
      this._json(res, { yaml: content });
    } else {
      this._json(res, { yaml: '' });
    }
  }

  _saveConfig(yamlStr) {
    const configPath = path.resolve('./config/config.yaml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, yamlStr, 'utf8');
  }

  _getParsedConfig(res) {
    const configPath = path.resolve('./config/config.yaml');
    if (!fs.existsSync(configPath)) {
      return this._json(res, { config: null });
    }
    try {
      const content = fs.readFileSync(configPath, 'utf8');
      const config = yaml.load(content);
      this._json(res, { config });
    } catch (err) {
      this._json(res, { error: 'YAML 解析失败: ' + err.message }, 400);
    }
  }

  async stop() {
    for (const ws of this._clients) ws.close();
    this._clients.clear();
    if (this._wss) this._wss.close();
    if (this._server) {
      await new Promise(resolve => this._server.close(resolve));
    }
  }
}
