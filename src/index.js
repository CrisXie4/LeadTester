import { EventEmitter } from 'events';
import { AIMode } from './modes/ai-mode.js';
import { HTTPMode } from './modes/http-mode.js';
import { SimpleMode } from './modes/simple-mode.js';
import { ReportGenerator } from './utils/report.js';

/**
 * 测试运行器 — 可被 API 控制的测压引擎
 */
export class TestRunner extends EventEmitter {
  constructor() {
    super();
    this.mode = null;
    this.status = 'idle';       // idle | running | stopping | completed
    this.currentConfig = null;
    this.snapshot = null;
    this.reportFiles = null;
    this._logs = [];
    this._maxLogs = 2000;
  }

  /**
   * 启动测压 (非阻塞，返回立即)
   */
  start(config) {
    if (this.status === 'running') {
      throw new Error('已有测试在运行中');
    }

    this.currentConfig = config;
    this.status = 'running';
    this.snapshot = null;
    this.reportFiles = null;
    this._logs = [];

    const onSnapshot = (snap) => {
      this.snapshot = snap;
      this.emit('snapshot', snap);
    };

    const onLog = (msg) => {
      this._addLog(msg);
    };

    switch (config.mode) {
      case 'ai':
        this.mode = new AIMode(
          { ...config.ai_config, max_workers: config.general?.max_workers },
          onSnapshot,
        );
        break;
      case 'http':
        this.mode = new HTTPMode(
          { ...config.http_config, max_workers: config.general?.max_workers },
          onSnapshot,
        );
        break;
      case 'simple':
        this.mode = new SimpleMode(
          { ...config.simple_config, max_workers: config.general?.max_workers },
          onSnapshot,
        );
        break;
      default:
        this.status = 'idle';
        throw new Error(`不支持的模式: ${config.mode}`);
    }

    // 绑定日志
    this.mode.onLog = onLog;

    // 异步执行，不阻塞
    this.mode.start()
      .then(async (snap) => {
        this.snapshot = snap;
        this.status = 'completed';
        this.emit('completed', snap);

        // 生成报告
        if (config.general?.save_raw_data !== false) {
          const reporter = new ReportGenerator(config.general?.report_dir || './reports');
          const records = this.mode.metrics.records;
          this.reportFiles = await reporter.generate(snap, config, records);
          this.emit('report', this.reportFiles);
        }
      })
      .catch((err) => {
        this.status = 'completed';
        this.emit('error', err.message);
        this._addLog(`[错误] ${err.message}`);
      });

    return { status: this.status };
  }

  stop() {
    if (this.status === 'stopping') {
      return { status: this.status, message: '测试正在停止中' };
    }
    if (this.status !== 'running' || !this.mode) {
      throw new Error('没有正在运行的测试');
    }
    this.status = 'stopping';
    this.mode.stop();
    this._addLog('[系统] 收到停止信号，等待在途请求完成...');
    return { status: this.status };
  }

  getStatus() {
    return {
      status: this.status,
      config: this.currentConfig ? {
        mode: this.currentConfig.mode,
        target: this.currentConfig.mode === 'ai'
          ? this.currentConfig.ai_config?.api_base
          : this.currentConfig.http_config?.target_url,
      } : null,
      snapshot: this.snapshot,
      reportFiles: this.reportFiles,
      logCount: this._logs.length,
    };
  }

  getLogs(offset = 0) {
    return this._logs.slice(offset);
  }

  _addLog(msg) {
    const entry = {
      time: new Date().toLocaleTimeString('zh-CN'),
      message: msg,
    };
    this._logs.push(entry);
    if (this._logs.length > this._maxLogs) {
      this._logs = this._logs.slice(-this._maxLogs);
    }
    this.emit('log', entry);
  }
}
