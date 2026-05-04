import fs from 'fs';
import path from 'path';

/**
 * 报告生成器 — 支持 JSON / CSV / HTML / Markdown 格式
 */
export class ReportGenerator {
  constructor(outputDir = './reports') {
    this.outputDir = path.resolve(outputDir);
    fs.mkdirSync(this.outputDir, { recursive: true });
  }

  /**
   * 生成所有格式的报告
   */
  async generate(snapshot, config, records = []) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const baseName = `report_${timestamp}`;

    const files = {};

    files.json = this._writeJSON(baseName, snapshot, config);
    files.csv = this._writeCSV(baseName, records);
    files.html = this._writeHTML(baseName, snapshot, config);
    files.markdown = this._writeMarkdown(baseName, snapshot, config);

    return files;
  }

  _writeJSON(baseName, snapshot, config) {
    const filePath = path.join(this.outputDir, `${baseName}.json`);
    const report = {
      meta: {
        generatedAt: new Date().toISOString(),
        mode: config.mode,
        target: config.mode === 'ai' ? config.ai_config.api_base : config.http_config.target_url,
      },
      snapshot,
    };
    fs.writeFileSync(filePath, JSON.stringify(report, null, 2), 'utf8');
    return filePath;
  }

  _writeCSV(baseName, records) {
    const filePath = path.join(this.outputDir, `${baseName}.csv`);
    if (records.length === 0) {
      fs.writeFileSync(filePath, '无原始数据', 'utf8');
      return filePath;
    }

    const headers = Object.keys(records[0]);
    const lines = [headers.join(',')];
    for (const r of records) {
      lines.push(headers.map(h => JSON.stringify(r[h] ?? '')).join(','));
    }
    fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
    return filePath;
  }

  _writeMarkdown(baseName, snapshot, config) {
    const filePath = path.join(this.outputDir, `${baseName}.md`);
    const mode = config.mode === 'ai' ? 'AI 测压' : 'HTTP 测压';
    const target = config.mode === 'ai'
      ? config.ai_config.api_base
      : config.http_config.target_url;

    const md = `# LoadTester 压测报告

> 生成时间: ${new Date().toISOString()}

## 1. 压测概览

| 项目 | 值 |
|------|-----|
| 模式 | ${mode} |
| 目标 | ${target} |
| 持续时间 | ${Math.round(snapshot.elapsedSec)}s |
| 总请求数 | ${snapshot.totalRequests} |
| 成功数 | ${snapshot.successCount} |
| 失败数 | ${snapshot.failureCount} |

## 2. 性能指标

| 指标 | 值 |
|------|-----|
| 实际 RPS | ${snapshot.currentRps} |
| 实际 RPM | ${snapshot.currentRpm} |
| 平均延迟 | ${snapshot.avgLatencyMs}ms |
| P50 延迟 | ${snapshot.p50Ms}ms |
| P90 延迟 | ${snapshot.p90Ms}ms |
| P95 延迟 | ${snapshot.p95Ms}ms |
| P99 延迟 | ${snapshot.p99Ms}ms |

## 3. 稳定性

| 指标 | 值 |
|------|-----|
| 错误率 | ${snapshot.errorRate}% |
| 状态码分布 | ${JSON.stringify(snapshot.statusCodes)} |
| 错误类型 | ${JSON.stringify(snapshot.errors)} |

---
*由 LoadTester v1.0 生成*
`;
    fs.writeFileSync(filePath, md, 'utf8');
    return filePath;
  }

  _writeHTML(baseName, snapshot, config) {
    const filePath = path.join(this.outputDir, `${baseName}.html`);
    const mode = config.mode === 'ai' ? 'AI 测压' : 'HTTP 测压';
    const target = config.mode === 'ai'
      ? escapeHtml(config.ai_config.api_base)
      : escapeHtml(config.http_config.target_url);

    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>LoadTester 压测报告</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; padding: 20px; }
    .container { max-width: 900px; margin: 0 auto; }
    h1 { color: #333; margin-bottom: 20px; }
    h2 { color: #555; margin: 20px 0 10px; border-bottom: 2px solid #4a90d9; padding-bottom: 5px; }
    table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    th, td { padding: 10px 16px; text-align: left; border-bottom: 1px solid #eee; }
    th { background: #4a90d9; color: #fff; }
    .metric { font-size: 24px; font-weight: bold; color: #4a90d9; }
    .success { color: #27ae60; }
    .error { color: #e74c3c; }
    .footer { text-align: center; color: #999; margin-top: 30px; font-size: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>LoadTester 压测报告</h1>
    <p style="color:#777">生成时间: ${new Date().toLocaleString('zh-CN')}</p>

    <h2>1. 压测概览</h2>
    <table>
      <tr><th>项目</th><th>值</th></tr>
      <tr><td>模式</td><td>${mode}</td></tr>
      <tr><td>目标</td><td>${target}</td></tr>
      <tr><td>持续时间</td><td>${Math.round(snapshot.elapsedSec)}s</td></tr>
      <tr><td>总请求数</td><td class="metric">${snapshot.totalRequests}</td></tr>
      <tr><td>成功数</td><td class="success">${snapshot.successCount}</td></tr>
      <tr><td>失败数</td><td class="error">${snapshot.failureCount}</td></tr>
    </table>

    <h2>2. 性能指标</h2>
    <table>
      <tr><th>指标</th><th>值</th></tr>
      <tr><td>实际 RPS</td><td>${snapshot.currentRps}</td></tr>
      <tr><td>实际 RPM</td><td>${snapshot.currentRpm}</td></tr>
      <tr><td>平均延迟</td><td>${snapshot.avgLatencyMs}ms</td></tr>
      <tr><td>P50 延迟</td><td>${snapshot.p50Ms}ms</td></tr>
      <tr><td>P90 延迟</td><td>${snapshot.p90Ms}ms</td></tr>
      <tr><td>P95 延迟</td><td>${snapshot.p95Ms}ms</td></tr>
      <tr><td>P99 延迟</td><td>${snapshot.p99Ms}ms</td></tr>
    </table>

    <h2>3. 稳定性分析</h2>
    <table>
      <tr><th>指标</th><th>值</th></tr>
      <tr><td>错误率</td><td class="error">${snapshot.errorRate}%</td></tr>
      <tr><td>状态码分布</td><td>${escapeHtml(JSON.stringify(snapshot.statusCodes))}</td></tr>
      <tr><td>错误类型</td><td>${escapeHtml(JSON.stringify(snapshot.errors))}</td></tr>
    </table>

    <div class="footer">由 LoadTester v1.0 生成</div>
  </div>
</body>
</html>`;
    fs.writeFileSync(filePath, html, 'utf8');
    return filePath;
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
