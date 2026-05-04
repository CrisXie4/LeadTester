import { TokenBucket } from '../core/rate-limiter.js';
import { WorkerPool } from '../core/worker-pool.js';
import { MetricsCollector } from '../core/metrics.js';
import { KeyRotator } from '../core/key-rotator.js';
import { PromptGenerator, buildAIRequest } from '../utils/prompt.js';
import { maskKey } from '../core/key-rotator.js';

/**
 * AI 接口测压模式 — 按 RPM 控制请求速率
 */
export class AIMode {
  constructor(config, onSnapshot = null) {
    this.config = config;
    this.onSnapshot = onSnapshot;
    this.onLog = null; // 由 TestRunner 注入
    this.metrics = new MetricsCollector();
    this.limiter = new TokenBucket({
      rate: config.target_rpm / 60,
      capacity: Math.max(1, Math.ceil(config.target_rpm / 60)),
    });
    this.pool = new WorkerPool({
      maxWorkers: config.max_workers || 500,
      duration: config.max_duration,
    });
    this.keyRotator = new KeyRotator({
      keys: config.api_keys,
      strategy: config.key_rotation,
    });
    this.promptGen = new PromptGenerator(config);
    this._snapshotTimer = null;
    this._stopped = false;
  }

  async start() {
    const { config } = this;
    this._log(`[AI 模式] 开始测压`);
    this._log(`  目标: ${config.api_base}`);
    this._log(`  模型: ${config.model}`);
    this._log(`  RPM: ${config.target_rpm}`);
    this._log(`  Key 数量: ${config.api_keys.length}`);
    this._log(`  最大时长: ${config.max_duration}s`);
    this._log(`  流式输出: ${config.stream ? '是' : '否'}`);

    // 启动定时快照推送
    if (this.onSnapshot) {
      this._snapshotTimer = setInterval(() => {
        this.onSnapshot(this.metrics.getSnapshot());
      }, 1000);
    }

    try {
      const results = await this.pool.run(
        (workerId) => this._sendRequest(workerId),
        this.limiter,
      );
      return this.metrics.getSnapshot();
    } finally {
      if (this._snapshotTimer) clearInterval(this._snapshotTimer);
    }
  }

  stop() {
    this._stopped = true;
    this.pool.stop();
    this._log('[AI 模式] 收到停止信号，等待在途请求完成...');
  }

  _log(msg) {
    if (this.onLog) this.onLog(msg);
  }

  async _sendRequest(workerId) {
    const keyInfo = this.keyRotator.get();
    if (!keyInfo) {
      throw new Error('所有 API Key 均不可用');
    }

    const { key, index: keyIndex } = keyInfo;
    const prompt = this.promptGen.generate();
    const body = buildAIRequest(this.config.model, prompt, this.config.stream);

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      (this.config.timeout?.total || 120) * 1000,
    );

    const start = Date.now();
    let statusCode = 0;
    let isSuccess = false;
    let errorType = null;
    let errorBody = null;
    let responseSize = 0;
    let ttftMs = 0;
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      const resp = await fetch(this.config.api_base, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${key}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      statusCode = resp.status;
      responseSize = Number(resp.headers.get('content-length')) || 0;

      if (this.config.stream) {
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let firstChunk = true;
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (firstChunk) { ttftMs = Date.now() - start; firstChunk = false; }
          buffer += decoder.decode(value, { stream: true });
          responseSize += value.length;
        }

        const usage = extractUsageFromSSE(buffer);
        if (usage) {
          inputTokens = usage.prompt_tokens || 0;
          outputTokens = usage.completion_tokens || 0;
        }

        // 非 2xx 时保留完整响应
        if (statusCode < 200 || statusCode >= 300) {
          errorBody = buffer.slice(0, 2000);
        }
      } else {
        const rawText = await resp.text();
        responseSize = rawText.length;

        if (statusCode >= 200 && statusCode < 300) {
          try {
            const data = JSON.parse(rawText);
            if (data.usage) {
              inputTokens = data.usage.prompt_tokens || 0;
              outputTokens = data.usage.completion_tokens || 0;
            }
          } catch {}
        } else {
          // 非 2xx 保留完整响应体
          errorBody = rawText.slice(0, 2000);
        }
      }

      isSuccess = statusCode >= 200 && statusCode < 300;
      if (!isSuccess) errorType = `http_${statusCode}`;
      this.keyRotator.report(key, isSuccess, statusCode);
    } catch (err) {
      if (err.name === 'AbortError') {
        errorType = 'timeout';
        errorBody = '请求超时，连接被中止';
      } else if (err.code === 'ECONNREFUSED') {
        errorType = 'connection_refused';
        errorBody = `连接被拒绝: ${this.config.api_base}`;
      } else if (err.code === 'ENOTFOUND') {
        errorType = 'dns_error';
        errorBody = `DNS 解析失败: ${err.hostname || this.config.api_base}`;
      } else {
        errorType = err.code || 'unknown';
        errorBody = err.message || String(err);
      }
      isSuccess = false;
      this.keyRotator.report(key, false, statusCode);
    } finally {
      clearTimeout(timeout);
    }

    const latencyMs = Date.now() - start;

    const record = this.metrics.record({
      mode: 'ai',
      latencyMs,
      ttftMs,
      statusCode,
      isSuccess,
      errorType,
      errorBody,
      inputTokens,
      outputTokens,
      responseSizeBytes: responseSize,
      apiKeyIndex: keyIndex,
      retryCount: 0,
    });

    this._log(formatRequestLog({
      elapsedMs: record.timestamp - this.metrics.startTime,
      index: this.metrics.counters.total,
      workerId,
      url: this.config.api_base,
      statusCode,
      isSuccess,
      latencyMs,
      ttftMs,
      keyIndex,
      inputTokens,
      outputTokens,
      errorType,
      errorBody,
    }));

    return { statusCode, isSuccess, latencyMs };
  }
}

/** 从 SSE 数据中提取最后一个 usage 块 */
function extractUsageFromSSE(buffer) {
  try {
    const lines = buffer.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.startsWith('data: ') && line !== 'data: [DONE]') {
        const json = JSON.parse(line.slice(6));
        if (json.usage) return json.usage;
      }
    }
  } catch {}
  return null;
}

function formatRequestLog({ elapsedMs, index, workerId, url, statusCode, isSuccess, latencyMs, ttftMs, keyIndex, inputTokens, outputTokens, errorType, errorBody }) {
  const status = statusCode || 'ERR';
  const result = isSuccess ? 'OK' : `FAIL ${errorType || ''}`.trim();
  const ttft = ttftMs ? ` TTFT=${ttftMs}ms` : '';
  const usage = inputTokens || outputTokens ? ` tokens=${inputTokens}/${outputTokens}` : '';
  const detail = errorBody ? ` | ${truncateOneLine(errorBody, 180)}` : '';
  return `[${formatElapsed(elapsedMs)}] #${index} worker-${workerId} AI key-${keyIndex + 1} POST ${url} -> ${status} ${latencyMs}ms${ttft}${usage} ${result}${detail}`;
}

function formatElapsed(ms) {
  const safe = Math.max(0, Number(ms) || 0);
  const minutes = Math.floor(safe / 60000);
  const seconds = Math.floor((safe % 60000) / 1000);
  const millis = Math.floor(safe % 1000);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

function truncateOneLine(value, maxLen) {
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length > maxLen ? text.slice(0, maxLen - 3) + '...' : text;
}
