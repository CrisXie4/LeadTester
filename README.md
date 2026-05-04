# LeadTester

LeadTester 是一个本地 API 压测工具，提供 Web Dashboard 和 CLI 两种使用方式。它可以用来对 AI 接口、普通 HTTP 接口、简单 HTTP 场景进行并发压测，并实时展示 RPS、RPM、成功数、失败数、错误率、延迟分位数和状态码分布。

Made By [CrisXie](https://github.com/CrisXie4/LeadTester)

## 功能特性

- AI 接口压测：支持接口地址、模型、API Key 列表、Key 轮询策略、目标 RPM、流式输出和超时设置。
- HTTP 接口压测：支持 URL、请求方法、Headers、Body、固定 QPS、固定并发、阶梯加压、渐进加压和状态码断言。
- 简易 HTTP 压测：适合快速填写目标地址、RPM、持续时间、并发数和超时时间。
- 实时监控：展示 RPS、RPM、总请求数、成功/失败数、错误率、平均延迟、P50/P90/P95/P99。
- 详细日志：按压测运行时间记录每次请求的 worker、方法、URL、状态码、耗时、错误类型和响应摘要。
- 错误详情：记录最近错误、状态码、错误类型、延迟和响应内容预览。
- 历史报告：压测完成后生成 JSON、HTML、CSV、Markdown 报告。
- 配置文件：支持在 Web 页面中读取和保存 `config/config.yaml`。
- CLI 模式：可以不打开浏览器，直接在命令行执行压测。

## 安装

```bash
npm install
```

## 启动 Web Dashboard

```bash
npm run dashboard
```

启动后打开：

```text
http://localhost:8080
```

在 Dashboard 中可以填写参数、从配置文件加载、启动压测、停止压测、查看实时监控和历史报告。

## 配置文件

真实配置文件为：

```text
config/config.yaml
```

为了避免泄露 API Key，`config/config.yaml` 默认不会提交到 GitHub。你可以参考：

```text
config/config.example.yaml
```

复制一份作为本地配置：

```bash
copy config\config.example.yaml config\config.yaml
```

然后把里面的接口地址、模型、API Key、RPM、QPS 等参数改成自己的。

## CLI 用法

```bash
npm run ai
npm run http
npm start
```

也可以直接使用 CLI 参数：

```bash
node src/cli.js run --mode http --url https://example.com --qps 100 --duration 60
```

## 注意事项

- 请只压测你自己拥有或明确授权的接口。
- 不要把真实 API Key 提交到公开仓库。
- 压测会消耗目标服务资源，请合理设置 RPM、QPS、并发和持续时间。
- 本项目需要本地 Node 后端运行，不能作为纯静态页面直接在线发压。
