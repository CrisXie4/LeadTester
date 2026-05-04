import { TokenBucket } from '../core/rate-limiter.js';
import { WorkerPool } from '../core/worker-pool.js';

/**
 * 纯 HTTP 压测模式 — 只给 URL，只看 RPM 和状态码
 */
export class SimpleMode {
  constructor(config, onSnapshot = null) {
    this.config = config;
    this.onSnapshot = onSnapshot;
    this.onLog = null;
    this._snapshotTimer = null;
    this._stopped = false;

    this._counters = { total: 0, success: 0, failure: 0, statusCodes: {}, errors: {} };
    this._startTime = 0;
    this._recentErrors = [];
    this._maxRecentErrors = 50;
  }

  async start() {
    const { config } = this;
    const targetRpm = config.target_rpm || 100;
    const duration = config.max_duration || 60;

    this._log(`[压测] 开始`);
    this._log(`  目标: ${config.method || 'GET'} ${config.url}`);
    this._log(`  RPM: ${targetRpm}`);
    this._log(`  时长: ${duration}s`);
    this._log(`  非200继续: ${config.stop_on_error ? '否' : '是'}`);

    this._startTime = Date.now();
    this._counters = { total: 0, success: 0, failure: 0, statusCodes: {}, errors: {} };
    this._recentErrors = [];

    const limiter = new TokenBucket({
      rate: targetRpm / 60,
      capacity: Math.max(1, Math.ceil(targetRpm / 60)),
    });

    const pool = new WorkerPool({
      maxWorkers: config.max_workers || 1000,
      duration,
    });

    if (this.onSnapshot) {
      this._snapshotTimer = setInterval(() => {
        this.onSnapshot(this._getSnapshot());
      }, 1000);
    }

    try {
      await pool.run(() => this._hit(), limiter);
    } finally {
      if (this._snapshotTimer) clearInterval(this._snapshotTimer);
    }

    return this._getSnapshot();
  }

  stop() {
    this._stopped = true;
    this._log('[压测] 停止中...');
  }

  async _hit() {
    const { config } = this;
    const start = Date.now();
    let statusCode = 0;
    let errorType = null;
    let errorBody = null;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), (config.timeout || 30) * 1000);

    try {
      const opts = {
        method: config.method || 'GET',
        headers: config.headers || {},
        signal: controller.signal,
      };
      if (config.body && !['GET', 'HEAD'].includes(opts.method)) {
        opts.body = config.body;
      }

      const resp = await fetch(config.url, opts);
      statusCode = resp.status;

      if (statusCode >= 200 && statusCode < 300) {
        resp.body?.cancel?.().catch(() => {});
      } else {
        errorType = `http_${statusCode}`;
        errorBody = await resp.text().catch(() => '');
        errorBody = errorBody.slice(0, 2000);
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        errorType = 'timeout';
        errorBody = `超时 (${config.timeout || 30}s)`;
      } else {
        errorType = err.cause?.code || err.code || 'network_error';
        errorBody = err.message;
      }
    } finally {
      clearTimeout(timeout);
    }

    const latencyMs = Date.now() - start;
    const ok = statusCode >= 200 && statusCode < 300;

    this._counters.total++;
    ok ? this._counters.success++ : this._counters.failure++;

    const code = String(statusCode || 'ERR');
    this._counters.statusCodes[code] = (this._counters.statusCodes[code] || 0) + 1;
    if (errorType) {
      this._counters.errors[errorType] = (this._counters.errors[errorType] || 0) + 1;
    }

    if (!ok) {
      this._recentErrors.push({
        time: new Date().toLocaleTimeString('zh-CN'),
        statusCode,
        errorType,
        errorBody,
        latencyMs,
      });
      if (this._recentErrors.length > this._maxRecentErrors) this._recentErrors.shift();
    }

    if (!ok && config.stop_on_error) {
      throw new Error(`HTTP ${statusCode}`);
    }
  }

  _getSnapshot() {
    const elapsedSec = (Date.now() - this._startTime) / 1000;
    const { total, success, failure } = this._counters;
    const rps = elapsedSec > 0 ? total / elapsedSec : 0;

    return {
      timestamp: Date.now(),
      mode: 'simple',
      currentRps: Math.round(rps * 10) / 10,
      currentRpm: Math.round(rps * 60),
      totalRequests: total,
      successCount: success,
      failureCount: failure,
      errorRate: total > 0 ? Math.round((failure / total) * 10000) / 100 : 0,
      elapsedSec,
      statusCodes: { ...this._counters.statusCodes },
      errors: { ...this._counters.errors },
      recentErrors: [...this._recentErrors],
      avgLatencyMs: 0,
      p50Ms: 0, p90Ms: 0, p95Ms: 0, p99Ms: 0,
    };
  }

  _log(msg) {
    if (this.onLog) this.onLog(msg);
  }

  get metrics() {
    return { records: [] };
  }
}
