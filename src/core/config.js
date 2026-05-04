import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

const DEFAULT_CONFIG = {
  mode: 'ai',

  ai_config: {
    api_base: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-3.5-turbo',
    api_keys: [],
    key_rotation: 'round_robin',
    target_rpm: 100,
    max_duration: 300,
    input_strategy: 'random_text',
    user_prompt: '',
    prompt_template: 'short',
    input_token_range: [50, 200],
    stream: false,
    timeout: { connection: 10, read: 60, total: 120 },
  },

  http_config: {
    target_url: '',
    method: 'GET',
    headers: {},
    body: null,
    load_type: 'fixed_qps',
    target_qps: 100,
    concurrency: 50,
    step_config: {
      start_qps: 100,
      step_size: 100,
      step_duration: 60,
      max_qps: 1000,
    },
    assertions: [],
    timeout: { connection: 10, read: 30, total: 60 },
  },

  general: {
    max_workers: 500,
    report_dir: './reports',
    save_raw_data: true,
    dashboard_port: 8080,
    log_level: 'info',
  },

  simple_config: {
    url: 'https://example.com',
    method: 'GET',
    headers: {},
    body: null,
    target_rpm: 100,
    max_duration: 60,
    max_workers: 1000,
    stop_on_error: false,
    timeout: 30,
  },
};

/**
 * 加载并合并配置
 * @param {string} configPath - 配置文件路径 (YAML)
 * @param {Object} cliArgs - CLI 参数覆盖
 * @returns {Object} 最终配置
 */
export function loadConfig(configPath = null, cliArgs = {}) {
  let fileConfig = {};

  if (configPath) {
    const resolved = path.resolve(configPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`配置文件不存在: ${resolved}`);
    }
    const content = fs.readFileSync(resolved, 'utf8');
    fileConfig = yaml.load(content) || {};
  }

  // 深度合并: 默认配置 <- 文件配置 <- CLI 参数
  const config = deepMerge(deepMerge({}, DEFAULT_CONFIG), fileConfig);

  // CLI 参数覆盖
  if (cliArgs.mode) config.mode = cliArgs.mode;
  if (cliArgs.rpm) {
    config.ai_config.target_rpm = Number(cliArgs.rpm);
    config.simple_config.target_rpm = Number(cliArgs.rpm);
  }
  if (cliArgs.model) {
    config.ai_config.model = cliArgs.model;
  }
  if (cliArgs.apiBase) {
    config.ai_config.api_base = cliArgs.apiBase;
  }
  if (cliArgs.apiKeys) {
    const keys = cliArgs.apiKeys.split(',').map(k => k.trim());
    config.ai_config.api_keys = keys;
  }
  if (cliArgs.url) {
    config.http_config.target_url = cliArgs.url;
    config.simple_config.url = cliArgs.url;
  }
  if (cliArgs.method) {
    config.http_config.method = cliArgs.method;
    config.simple_config.method = cliArgs.method;
  }
  if (cliArgs.qps) config.http_config.target_qps = Number(cliArgs.qps);
  if (cliArgs.concurrency) config.http_config.concurrency = Number(cliArgs.concurrency);
  if (cliArgs.duration) {
    config.ai_config.max_duration = Number(cliArgs.duration);
    config.simple_config.max_duration = Number(cliArgs.duration);
  }
  if (cliArgs.stream) config.ai_config.stream = true;
  if (cliArgs.workers) {
    config.general.max_workers = Number(cliArgs.workers);
    config.simple_config.max_workers = Number(cliArgs.workers);
  }
  if (cliArgs.port) config.general.dashboard_port = Number(cliArgs.port);

  return config;
}

/**
 * 保存配置到文件
 */
export function saveConfig(config, filePath) {
  const content = yaml.dump(config, { lineWidth: 120, noRefs: true });
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

/**
 * 生成示例配置文件
 */
export function generateSampleConfig() {
  return yaml.dump(DEFAULT_CONFIG, { lineWidth: 120, noRefs: true });
}

function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === 'object'
    ) {
      target[key] = deepMerge({ ...target[key] }, source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}
