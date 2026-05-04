/**
 * API Key 轮询器 — 支持轮询、失败降级、权重分配
 */
export class KeyRotator {
  constructor({ keys, strategy = 'round_robin', weights = null, cooldownMs = 300000 }) {
    this.keys = keys;
    this.strategy = strategy;
    this.cooldownMs = cooldownMs;      // Key 冷却时间(默认5分钟)
    this._index = 0;
    this._failures = new Map();        // key -> 连续失败次数
    this._disabledUntil = new Map();   // key -> 恢复可用时间戳
    this._weights = weights || keys.map(() => 1);
  }

  /**
   * 获取一个可用的 API Key
   * @returns {{ key: string, index: number } | null}
   */
  get() {
    const now = Date.now();
    const availableKeys = this.keys
      .map((key, i) => ({ key, index: i }))
      .filter(({ key }) => {
        const disabledUntil = this._disabledUntil.get(key);
        return !disabledUntil || now >= disabledUntil;
      });

    if (availableKeys.length === 0) return null;

    switch (this.strategy) {
      case 'round_robin':
        return this._roundRobin(availableKeys);
      case 'weighted':
        return this._weighted(availableKeys);
      case 'random':
        return this._random(availableKeys);
      default:
        return this._roundRobin(availableKeys);
    }
  }

  /**
   * 报告请求结果
   * @param {string} key
   * @param {boolean} success
   * @param {number} statusCode
   */
  report(key, success, statusCode = null) {
    if (success) {
      this._failures.set(key, 0);
      return;
    }

    const failures = (this._failures.get(key) || 0) + 1;
    this._failures.set(key, failures);

    // 连续失败 3 次或遇到限流/认证错误，进入冷却期
    if (failures >= 3 || [401, 403, 429].includes(statusCode)) {
      this._disabledUntil.set(key, Date.now() + this.cooldownMs);
      console.log(`[KeyRotator] Key ${maskKey(key)} 进入冷却期 ${this.cooldownMs / 1000}s`);
    }
  }

  /** 获取所有 Key 的状态 */
  getStatus() {
    const now = Date.now();
    return this.keys.map((key, i) => ({
      index: i,
      key: maskKey(key),
      failures: this._failures.get(key) || 0,
      available: !(this._disabledUntil.get(key) > now),
    }));
  }

  _roundRobin(available) {
    const item = available[this._index % available.length];
    this._index++;
    return item;
  }

  _weighted(available) {
    const totalWeight = available.reduce((sum, { index }) => sum + this._weights[index], 0);
    let rand = Math.random() * totalWeight;
    for (const item of available) {
      rand -= this._weights[item.index];
      if (rand <= 0) return item;
    }
    return available[0];
  }

  _random(available) {
    return available[Math.floor(Math.random() * available.length)];
  }
}

/** 脱敏显示 Key */
export function maskKey(key) {
  if (!key || key.length <= 8) return '****';
  return key.slice(0, 8) + '****';
}
