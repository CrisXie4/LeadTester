/**
 * Prompt 生成器 — 支持随机文本、自定义、模板、动态长度
 */

const CHAR_POOL = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

const TEMPLATES = {
  short: [
    '请简要介绍人工智能的发展历史。',
    '用一句话解释什么是机器学习。',
    '写一个简单的 Python Hello World 程序。',
    '什么是 RESTful API？',
    '解释 HTTP 和 HTTPS 的区别。',
  ],
  code: [
    '用 Python 实现一个快速排序算法。',
    '写一个 JavaScript 函数，实现数组去重。',
    '用 Go 实现一个简单的 HTTP 服务器。',
    '实现一个 LRU 缓存，支持 get 和 put 操作。',
    '写一个 TypeScript 泛型函数，实现深拷贝。',
  ],
  long: [
    '请详细分析微服务架构的优缺点，并给出在实际项目中的最佳实践建议。需要涵盖服务拆分、通信方式、数据一致性、部署策略、监控告警等方面。不少于500字。',
    '从零开始设计一个高并发秒杀系统，需要考虑库存预扣减、限流降级、消息队列异步处理、分布式锁、缓存策略等关键技术点。请给出完整的架构设计和技术选型方案。',
    '对比分析 MySQL、PostgreSQL、MongoDB 三种数据库在不同业务场景下的适用性。需要从数据模型、查询性能、扩展性、事务支持、运维成本等多个维度进行详细对比。',
  ],
};

export class PromptGenerator {
  constructor(config) {
    this.strategy = config.input_strategy || 'random_text';
    this.userPrompt = config.user_prompt || '';
    this.template = config.prompt_template || 'short';
    this.tokenRange = config.input_token_range || [50, 200];
  }

  /**
   * 生成一条 prompt
   * @returns {string}
   */
  generate() {
    switch (this.strategy) {
      case 'random_text':
        return this._randomText();
      case 'user_defined':
        return this.userPrompt || this._randomText();
      case 'template':
        return this._fromTemplate();
      case 'dynamic_length':
        return this._dynamicLength();
      default:
        return this._randomText();
    }
  }

  /** 生成随机无意义文本 */
  _randomText() {
    const len = 10 + Math.floor(Math.random() * 90); // 10~100 字符
    let result = '';
    for (let i = 0; i < len; i++) {
      result += CHAR_POOL[Math.floor(Math.random() * CHAR_POOL.length)];
    }
    return result;
  }

  /** 从模板库随机选取 */
  _fromTemplate() {
    const pool = TEMPLATES[this.template] || TEMPLATES.short;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /** 动态长度填充文本 */
  _dynamicLength() {
    const [minTokens, maxTokens] = this.tokenRange;
    const targetTokens = minTokens + Math.floor(Math.random() * (maxTokens - minTokens));
    // 粗略估算 1 token ≈ 4 字符
    const charCount = targetTokens * 4;
    let result = '';
    for (let i = 0; i < charCount; i++) {
      result += CHAR_POOL[Math.floor(Math.random() * CHAR_POOL.length)];
      if (i > 0 && i % 100 === 0) result += ' ';
    }
    return result;
  }
}

/**
 * 构造 AI 请求体
 */
export function buildAIRequest(model, prompt, stream = false) {
  return {
    model,
    messages: [{ role: 'user', content: prompt }],
    stream,
  };
}
