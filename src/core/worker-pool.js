import { EventEmitter } from 'events';

/**
 * 并发 Worker Pool — 基于 Promise 并发控制
 */
export class WorkerPool extends EventEmitter {
  constructor({ maxWorkers = 100, targetRps = 0, duration = 60 }) {
    super();
    this.maxWorkers = maxWorkers;
    this.targetRps = targetRps;
    this.duration = duration;
    this.activeCount = 0;
    this.results = [];
    this._running = false;
    this._aborted = false;
  }

  /**
   * 执行压测任务
   * @param {Function} taskFn - 异步任务函数 (workerId) => Promise<result>
   * @param {Object} limiter - 限流器实例 (TokenBucket / LeakyBucket)
   * @returns {Promise<Array>} 所有任务结果
   */
  async run(taskFn, limiter = null) {
    this._running = true;
    this._aborted = false;
    this.results = [];

    const endTime = Date.now() + this.duration * 1000;
    const promises = [];
    let workerId = 0;

    while (Date.now() < endTime && !this._aborted) {
      if (this.activeCount >= this.maxWorkers) {
        await sleep(1);
        continue;
      }

      // 限流等待
      if (limiter) {
        await limiter.acquire();
      } else if (this.targetRps > 0) {
        await sleep(1000 / this.targetRps);
      }

      if (this._aborted) break;

      const id = workerId++;
      this.activeCount++;
      this.emit('task:start', id);

      const p = this._execute(taskFn, id)
        .then(result => {
          this.results.push(result);
          this.activeCount--;
          this.emit('task:done', result);
          return result;
        });

      promises.push(p);
    }

    // 等待所有在途任务完成
    await Promise.allSettled(promises);
    this._running = false;
    return this.results;
  }

  async _execute(taskFn, workerId) {
    const start = Date.now();
    try {
      const result = await taskFn(workerId);
      return {
        workerId,
        status: 'success',
        latency: Date.now() - start,
        data: result,
        timestamp: start,
        error: null,
      };
    } catch (err) {
      return {
        workerId,
        status: 'error',
        latency: Date.now() - start,
        data: null,
        timestamp: start,
        error: err.message || String(err),
      };
    }
  }

  /** 停止调度，等待在途任务完成 */
  stop() {
    this._aborted = true;
  }

  get isRunning() {
    return this._running;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
