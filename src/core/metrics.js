import { v4 as uuidv4 } from 'uuid';

/**
 * 指标采集器 — 记录每次请求的详细数据并实时聚合
 */
export class MetricsCollector {
  constructor() {
    this.records = [];           // 原始采样记录
    this.startTime = null;
    this.endTime = null;

    // 聚合计数器
    this.counters = {
      total: 0,
      success: 0,
      failure: 0,
      statusCodes: {},           // { "200": 100, "429": 3 }
      errors: {},                // { "timeout": 2, "connection_refused": 1 }
    };

    // 最近的错误记录（详细）
    this._recentErrors = [];
    this._maxRecentErrors = 50;

    // 延迟采样（用于分位计算）
    this._latencies = [];
    this._latenciesSorted = false;

    // 滑动窗口：每秒桶
    this._secondBuckets = new Map();  // secondTimestamp -> { count, success, failure, latencySum }
  }

  /** 记录一条请求结果 */
  record(entry) {
    const record = {
      id: uuidv4(),
      ...entry,
      timestamp: entry.timestamp || Date.now(),
    };

    this.records.push(record);
    this._latencies.push(record.latencyMs);
    this._latenciesSorted = false;

    // 更新计数器
    this.counters.total++;
    if (record.isSuccess) {
      this.counters.success++;
    } else {
      this.counters.failure++;
    }

    // 状态码统计
    if (record.statusCode) {
      const code = String(record.statusCode);
      this.counters.statusCodes[code] = (this.counters.statusCodes[code] || 0) + 1;
    }

    // 错误类型统计
    if (record.errorType) {
      this.counters.errors[record.errorType] = (this.counters.errors[record.errorType] || 0) + 1;
    }

    // 记录失败请求详情
    if (!record.isSuccess) {
      this._recentErrors.push({
        time: new Date(record.timestamp).toLocaleTimeString('zh-CN'),
        statusCode: record.statusCode,
        errorType: record.errorType,
        errorBody: record.errorBody || null,
        latencyMs: record.latencyMs,
        mode: record.mode,
      });
      if (this._recentErrors.length > this._maxRecentErrors) {
        this._recentErrors.shift();
      }
    }

    // 滑动窗口
    const sec = Math.floor(record.timestamp / 1000);
    const bucket = this._secondBuckets.get(sec) || { count: 0, success: 0, failure: 0, latencySum: 0 };
    bucket.count++;
    if (record.isSuccess) bucket.success++;
    else bucket.failure++;
    bucket.latencySum += record.latencyMs;
    this._secondBuckets.set(sec, bucket);

    if (!this.startTime) this.startTime = record.timestamp;
    this.endTime = record.timestamp;

    return record;
  }

  /** 计算延迟分位值 */
  getPercentiles() {
    if (this._latencies.length === 0) {
      return { p50: 0, p90: 0, p95: 0, p99: 0, max: 0, min: 0, avg: 0 };
    }

    if (!this._latenciesSorted) {
      this._latencies.sort((a, b) => a - b);
      this._latenciesSorted = true;
    }

    const sorted = this._latencies;
    const sum = sorted.reduce((a, b) => a + b, 0);

    return {
      p50: percentile(sorted, 50),
      p90: percentile(sorted, 90),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      max: sorted[sorted.length - 1],
      min: sorted[0],
      avg: sum / sorted.length,
    };
  }

  /** 计算实际 RPS/RPM */
  getThroughput() {
    if (!this.startTime || !this.endTime) return { rps: 0, rpm: 0, elapsedSec: 0 };

    const elapsedSec = (this.endTime - this.startTime) / 1000;
    const total = this.counters.total;
    return {
      rps: elapsedSec > 0 ? total / elapsedSec : 0,
      rpm: elapsedSec > 0 ? (total / elapsedSec) * 60 : 0,
      elapsedSec,
    };
  }

  /** 获取错误率 */
  getErrorRate() {
    if (this.counters.total === 0) return 0;
    return this.counters.failure / this.counters.total;
  }

  /** 获取最近 N 秒的滑动窗口统计 */
  getWindowStats(seconds = 10) {
    const now = Math.floor(Date.now() / 1000);
    let count = 0, success = 0, failure = 0, latencySum = 0;

    for (let i = 0; i < seconds; i++) {
      const bucket = this._secondBuckets.get(now - i);
      if (bucket) {
        count += bucket.count;
        success += bucket.success;
        failure += bucket.failure;
        latencySum += bucket.latencySum;
      }
    }

    return {
      count,
      success,
      failure,
      avgLatency: count > 0 ? latencySum / count : 0,
      errorRate: count > 0 ? failure / count : 0,
    };
  }

  /** 生成实时推送数据 */
  getSnapshot() {
    const p = this.getPercentiles();
    const t = this.getThroughput();
    return {
      timestamp: Date.now(),
      currentRps: Math.round(t.rps * 10) / 10,
      currentRpm: Math.round(t.rpm),
      totalRequests: this.counters.total,
      successCount: this.counters.success,
      failureCount: this.counters.failure,
      avgLatencyMs: Math.round(p.avg * 10) / 10,
      p50Ms: Math.round(p.p50),
      p90Ms: Math.round(p.p90),
      p95Ms: Math.round(p.p95),
      p99Ms: Math.round(p.p99),
      errorRate: Math.round(this.getErrorRate() * 10000) / 100, // 百分比
      elapsedSec: t.elapsedSec,
      statusCodes: { ...this.counters.statusCodes },
      errors: { ...this.counters.errors },
      recentErrors: [...this._recentErrors],
    };
  }

  /** 重置所有指标 */
  reset() {
    this.records = [];
    this._latencies = [];
    this._latenciesSorted = false;
    this._recentErrors = [];
    this._secondBuckets.clear();
    this.startTime = null;
    this.endTime = null;
    this.counters = {
      total: 0, success: 0, failure: 0,
      statusCodes: {}, errors: {},
    };
  }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}
