import { TokenBucket } from '../core/rate-limiter.js';
import { WorkerPool } from '../core/worker-pool.js';
import { MetricsCollector } from '../core/metrics.js';
import { resolveObject } from '../utils/helpers.js';

/**
 * 通用 HTTP 测压模式 — 支持固定QPS、固定并发、阶梯加压
 */
export class HTTPMode {
  constructor(config, onSnapshot = null) {
    this.config = config;
    this.onSnapshot = onSnapshot;
    this.onLog = null; // 由 TestRunner 注入
    this.metrics = new MetricsCollector();
    this._snapshotTimer = null;
    this._stopped = false;
  }

  async start() {
    const { config } = this;
    this._log(`[HTTP 模式] 开始测压`);
    this._log(`  目标: ${config.method} ${config.target_url}`);
    this._log(`  加压类型: ${config.load_type}`);

    switch (config.load_type) {
      case 'fixed_qps':
        this._log(`  目标 QPS: ${config.target_qps}`);
        return this._runFixedQPS();
      case 'fixed_concurrency':
        this._log(`  并发数: ${config.concurrency}`);
        return this._runFixedConcurrency();
      case 'step':
        this._log(`  阶梯: ${config.step_config.start_qps} -> ${config.step_config.max_qps} (步长 ${config.step_config.step_size}, 每阶段 ${config.step_config.step_duration}s)`);
        return this._runStep();
      case 'ramp':
        this._log(`  渐进加压: ${config.ramp_config.start_qps} -> ${config.ramp_config.max_qps} (${config.ramp_config.duration}s)`);
        return this._runRamp();
      default:
        throw new Error(`不支持的加压类型: ${config.load_type}`);
    }
  }

  stop() {
    this._stopped = true;
    if (this._pool) this._pool.stop();
    this._log('[HTTP 模式] 收到停止信号...');
  }

  _log(msg) {
    if (this.onLog) this.onLog(msg);
  }

  /** 固定 QPS 模式 */
  async _runFixedQPS() {
    const { config } = this;
    const limiter = new TokenBucket({
      rate: config.target_qps,
      capacity: Math.max(1, Math.ceil(config.target_qps / 10)),
    });

    this._pool = new WorkerPool({
      maxWorkers: config.max_workers || 500,
      duration: config.timeout?.total || 60,
      targetRps: config.target_qps,
    });

    this._startSnapshot();
    try {
      await this._pool.run(
        (workerId) => this._sendRequest(workerId),
        limiter,
      );
    } finally {
      this._stopSnapshot();
    }
    return this.metrics.getSnapshot();
  }

  /** 固定并发模式 */
  async _runFixedConcurrency() {
    const { config } = this;
    const concurrency = config.concurrency;
    const duration = (config.timeout?.total || 60) * 1000;
    const endTime = Date.now() + duration;

    this._startSnapshot();

    const workers = Array.from({ length: concurrency }, (_, i) => {
      return (async () => {
        while (Date.now() < endTime && !this._stopped) {
          await this._sendRequest(i);
        }
      })();
    });

    await Promise.allSettled(workers);
    this._stopSnapshot();
    return this.metrics.getSnapshot();
  }

  /** 阶梯加压模式 */
  async _runStep() {
    const { config } = this;
    const { start_qps, step_size, step_duration, max_qps } = config.step_config;
    let currentQps = start_qps;

    this._startSnapshot();

    while (currentQps <= max_qps && !this._stopped) {
      this._log(`[阶梯] 当前 QPS: ${currentQps}，持续 ${step_duration}s`);

      const limiter = new TokenBucket({
        rate: currentQps,
        capacity: Math.max(1, Math.ceil(currentQps / 10)),
      });

      this._pool = new WorkerPool({
        maxWorkers: config.max_workers || 500,
        duration: step_duration,
        targetRps: currentQps,
      });

      await this._pool.run(
        (workerId) => this._sendRequest(workerId),
        limiter,
      );

      // 检查错误率，决定是否继续
      const errorRate = this.metrics.getErrorRate();
      if (errorRate > 0.5) {
        this._log(`[阶梯] 错误率 ${(errorRate * 100).toFixed(1)}% > 50%，停止加压`);
        break;
      }

      currentQps += step_size;
    }

    this._stopSnapshot();
    return this.metrics.getSnapshot();
  }

  /** 渐进加压模式 */
  async _runRamp() {
    const { config } = this;
    const ramp = config.ramp_config || {};
    const startQps = Math.max(1, Number(ramp.start_qps || 1));
    const maxQps = Math.max(startQps, Number(ramp.max_qps || config.target_qps || startQps));
    const duration = Math.max(1, Number(ramp.duration || config.timeout?.total || 60));
    const startedAt = Date.now();

    const limiter = new RampRateLimiter({
      startRate: startQps,
      endRate: maxQps,
      durationSec: duration,
      startedAt,
    });

    this._pool = new WorkerPool({
      maxWorkers: config.max_workers || 500,
      duration,
      targetRps: maxQps,
    });

    this._startSnapshot();
    try {
      await this._pool.run(
        (workerId) => this._sendRequest(workerId),
        limiter,
      );
    } finally {
      this._stopSnapshot();
    }

    return this.metrics.getSnapshot();
  }

  async _sendRequest(workerId) {
    const { config } = this;
    const url = resolveVariables(config.target_url);
    const headers = resolveObject(config.headers || {});
    const body = config.body ? resolveVariables(config.body) : null;

    const controller = new AbortController();
    const timeoutMs = (config.timeout?.read || 30) * 1000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const start = Date.now();
    let statusCode = 0;
    let isSuccess = false;
    let errorType = null;
    let errorBody = null;
    let responseSize = 0;

    try {
      const fetchOpts = {
        method: config.method,
        headers,
        signal: controller.signal,
      };

      if (body && !['GET', 'HEAD'].includes(config.method?.toUpperCase())) {
        fetchOpts.body = body;
      }

      const resp = await fetch(url, fetchOpts);
      statusCode = resp.status;

      const rawText = await resp.text().catch(() => '');
      responseSize = rawText.length;

      isSuccess = this._checkAssertions(resp, statusCode);

      if (!isSuccess) {
        errorType = `http_${statusCode}`;
        errorBody = rawText.slice(0, 2000);
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        errorType = 'timeout';
        errorBody = `请求超时 (${timeoutMs}ms): ${url}`;
      } else if (err.code === 'ECONNREFUSED') {
        errorType = 'connection_refused';
        errorBody = `连接被拒绝: ${url}`;
      } else if (err.code === 'ENOTFOUND') {
        errorType = 'dns_error';
        errorBody = `DNS 解析失败: ${err.hostname || url}`;
      } else {
        errorType = err.code || 'unknown';
        errorBody = err.message || String(err);
      }
      isSuccess = false;
    } finally {
      clearTimeout(timeout);
    }

    const latencyMs = Date.now() - start;

    this.metrics.record({
      mode: 'http',
      latencyMs,
      statusCode,
      isSuccess,
      errorType,
      errorBody,
      responseSizeBytes: responseSize,
      workerId,
      retryCount: 0,
    });

    return { statusCode, isSuccess, latencyMs };
  }

  _checkAssertions(resp, statusCode) {
    const assertions = this.config.assertions || [];
    if (assertions.length === 0) {
      return statusCode >= 200 && statusCode < 300;
    }

    for (const assertion of assertions) {
      switch (assertion.type) {
        case 'status_code':
          if (statusCode !== assertion.expected) return false;
          break;
        // json_path 断言需要读取响应体，这里简化处理
        default:
          break;
      }
    }
    return true;
  }

  _startSnapshot() {
    if (this.onSnapshot) {
      this._snapshotTimer = setInterval(() => {
        this.onSnapshot(this.metrics.getSnapshot());
      }, 1000);
    }
  }

  _stopSnapshot() {
    if (this._snapshotTimer) {
      clearInterval(this._snapshotTimer);
      this._snapshotTimer = null;
    }
  }
}

function resolveVariables(str) {
  if (typeof str !== 'string') return str;
  const vars = {
    '${NOW}': () => String(Date.now()),
    '${TIMESTAMP}': () => new Date().toISOString(),
    '${UUID}': () => crypto.randomUUID(),
    '${DATE}': () => new Date().toISOString().slice(0, 10),
  };
  let result = str;
  for (const [k, v] of Object.entries(vars)) {
    while (result.includes(k)) result = result.replace(k, v());
  }
  return result;
}

class RampRateLimiter {
  constructor({ startRate, endRate, durationSec, startedAt }) {
    this.startRate = startRate;
    this.endRate = endRate;
    this.durationSec = durationSec;
    this.startedAt = startedAt;
    this.tokens = Math.max(1, Math.ceil(startRate / 10));
    this.lastRefill = Date.now();
  }

  async acquire() {
    this._refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }

    const rate = this._currentRate();
    const deficit = 1 - this.tokens;
    const waitMs = (deficit / rate) * 1000;
    await sleep(waitMs);

    this._refill();
    this.tokens -= 1;
    return waitMs;
  }

  _currentRate() {
    const elapsedSec = Math.max(0, (Date.now() - this.startedAt) / 1000);
    const progress = Math.min(1, elapsedSec / this.durationSec);
    return this.startRate + (this.endRate - this.startRate) * progress;
  }

  _refill() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    const rate = this._currentRate();
    const capacity = Math.max(1, Math.ceil(rate / 10));
    this.tokens = Math.min(capacity, this.tokens + elapsed * rate);
    this.lastRefill = now;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
