/**
 * 令牌桶限流器 — 用于 AI 模式(RPM)和固定 QPS 模式
 */
export class TokenBucket {
  constructor({ rate, capacity = null }) {
    this.rate = rate;                    // 每秒产生的令牌数
    this.capacity = capacity ?? rate;    // 桶容量，默认等于 rate
    this.tokens = this.capacity;
    this.lastRefill = Date.now();
  }

  /**
   * 尝试获取一个令牌，若不足则等待
   * @returns {Promise<number>} 实际等待时间(ms)
   */
  async acquire() {
    this._refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }

    // 计算需要等待的时间
    const deficit = 1 - this.tokens;
    const waitMs = (deficit / this.rate) * 1000;
    await sleep(waitMs);

    this._refill();
    this.tokens -= 1;
    return waitMs;
  }

  /** 按时间补充令牌 */
  _refill() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.rate);
    this.lastRefill = now;
  }

  /** 重置限流器 */
  reset() {
    this.tokens = this.capacity;
    this.lastRefill = Date.now();
  }
}

/**
 * 漏桶限流器 — 用于需要严格平滑流量的场景
 */
export class LeakyBucket {
  constructor({ leakRate }) {
    this.leakRate = leakRate;  // 每秒漏出的请求数
    this.water = 0;            // 当前积压量
    this.lastLeak = Date.now();
  }

  async add() {
    this._leak();

    if (this.water < 1) {
      this.water += 1;
      return 0;
    }

    const waitMs = ((this.water - 1) / this.leakRate) * 1000;
    await sleep(waitMs);
    this.water += 1;
    return waitMs;
  }

  _leak() {
    const now = Date.now();
    const elapsed = (now - this.lastLeak) / 1000;
    this.water = Math.max(0, this.water - elapsed * this.leakRate);
    this.lastLeak = now;
  }

  reset() {
    this.water = 0;
    this.lastLeak = Date.now();
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
