/**
 * 模板变量替换 — 支持 ${VAR} 语法
 */

const TEMPLATE_VARS = {
  '${NOW}': () => Date.now(),
  '${TIMESTAMP}': () => new Date().toISOString(),
  '${UUID}': () => crypto.randomUUID(),
  '${RANDOM_INT}': () => Math.floor(Math.random() * 1000000),
  '${RANDOM_FLOAT}': () => Math.random().toFixed(6),
  '${DATE}': () => new Date().toISOString().slice(0, 10),
  '${TIME}': () => new Date().toISOString().slice(11, 19),
};

/**
 * 替换字符串中的模板变量
 * @param {string} str
 * @returns {string}
 */
export function resolveVariables(str) {
  if (typeof str !== 'string') return str;

  let result = str;
  for (const [varName, generator] of Object.entries(TEMPLATE_VARS)) {
    // 只替换存在的变量
    while (result.includes(varName)) {
      result = result.replace(varName, String(generator()));
    }
  }
  return result;
}

/**
 * 递归替换对象中的所有模板变量
 */
export function resolveObject(obj) {
  if (typeof obj === 'string') return resolveVariables(obj);
  if (Array.isArray(obj)) return obj.map(resolveObject);
  if (obj && typeof obj === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = resolveObject(value);
    }
    return result;
  }
  return obj;
}
