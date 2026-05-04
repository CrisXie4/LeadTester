#!/usr/bin/env node

import { Command } from 'commander';
import { loadConfig, generateSampleConfig } from './core/config.js';
import { TestRunner } from './index.js';
import { WebServer } from './web/server.js';
import fs from 'fs';
import path from 'path';

const program = new Command();

program
  .name('loadtester')
  .description('LoadTester — API 并发测压工具 (Web UI)')
  .version('1.0.0');

// === 启动 Web 服务 (默认命令) ===
program
  .command('serve', { isDefault: true })
  .description('启动 Web 服务 (浏览器操作)')
  .option('-p, --port <port>', '服务端口', '8080')
  .action(async (opts) => {
    const runner = new TestRunner();
    const server = new WebServer({ port: Number(opts.port), testRunner: runner });
    await server.start();
    console.log(`\n  打开浏览器访问: http://localhost:${opts.port}\n`);
    console.log('  按 Ctrl+C 退出\n');
  });

// === CLI 测压 (不需要浏览器) ===
program
  .command('run')
  .description('命令行直接启动测压 (不启动 Web UI)')
  .option('-c, --config <path>', '配置文件路径 (YAML)')
  .option('-m, --mode <mode>', '测压模式: ai | http')
  .option('--api-base <url>', 'API 基础地址')
  .option('--model <name>', '模型名称')
  .option('--api-keys <keys>', 'API Key 列表，逗号分隔')
  .option('--rpm <n>', '目标 RPM')
  .option('--stream', '使用流式输出')
  .option('--url <url>', '目标 URL')
  .option('--method <method>', 'HTTP 方法')
  .option('--qps <n>', '目标 QPS')
  .option('--concurrency <n>', '并发连接数')
  .option('-d, --duration <seconds>', '最大运行时长(秒)')
  .option('-w, --workers <n>', '最大 Worker 数')
  .option('--no-report', '不生成报告')
  .action(async (opts) => {
    try {
      const config = loadConfig(opts.config, opts);
      if (opts.report === false) config.general.save_raw_data = false;

      const runner = new TestRunner();

      runner.on('snapshot', (snap) => {
        process.stdout.write(
          `\r  RPS: ${snap.currentRps} | 延迟: ${snap.avgLatencyMs}ms | 错误: ${snap.errorRate}% | 总请求: ${snap.totalRequests}  `
        );
      });

      runner.on('completed', (snap) => {
        console.log('\n');
        printSummary(snap);
      });

      runner.on('report', (files) => {
        console.log('[报告] 已生成:');
        for (const [fmt, p] of Object.entries(files)) {
          console.log(`  ${fmt}: ${p}`);
        }
      });

      // 处理 Ctrl+C
      process.on('SIGINT', () => {
        console.log('\n[停止] 正在终止...');
        try { runner.stop(); } catch {}
      });

      runner.start(config);

      // 保持进程运行直到测试完成
      await new Promise((resolve) => {
        runner.on('completed', resolve);
        runner.on('error', resolve);
      });
    } catch (err) {
      console.error(`[错误] ${err.message}`);
      process.exit(1);
    }
  });

// === 生成示例配置 ===
program
  .command('init')
  .description('生成示例配置文件 config.yaml')
  .option('-o, --output <path>', '输出路径', './config/config.yaml')
  .action((opts) => {
    const outputPath = path.resolve(opts.output);
    if (fs.existsSync(outputPath)) {
      console.error(`[错误] 文件已存在: ${outputPath}`);
      process.exit(1);
    }
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, generateSampleConfig(), 'utf8');
    console.log(`[完成] 已生成配置文件: ${outputPath}`);
  });

function printSummary(snap) {
  console.log('='.repeat(50));
  console.log('  压测结果');
  console.log('='.repeat(50));
  console.log(`  持续时间:   ${Math.round(snap.elapsedSec)}s`);
  console.log(`  总请求数:   ${snap.totalRequests}`);
  console.log(`  成功数:     ${snap.successCount}`);
  console.log(`  失败数:     ${snap.failureCount}`);
  console.log(`  实际 RPS:   ${snap.currentRps}`);
  console.log(`  实际 RPM:   ${snap.currentRpm}`);
  console.log(`  平均延迟:   ${snap.avgLatencyMs}ms`);
  console.log(`  P50:        ${snap.p50Ms}ms`);
  console.log(`  P90:        ${snap.p90Ms}ms`);
  console.log(`  P95:        ${snap.p95Ms}ms`);
  console.log(`  P99:        ${snap.p99Ms}ms`);
  console.log(`  错误率:     ${snap.errorRate}%`);
  console.log('='.repeat(50));
}

program.parse();
