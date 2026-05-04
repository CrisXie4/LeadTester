# LeadTester

LeadTester 是一个 API 压测配置与分享工具，支持 AI 接口 RPM、通用 HTTP QPS、简易 HTTP 压测等场景。项目可以部署到 Vercel 作为纯静态页面使用，不依赖后端即可生成和分享压测配置链接。

Made By [CrisXie](https://github.com/CrisXie4/LeadTester)

## 功能特性

- AI 接口压测配置：支持接口地址、模型、RPM、Key 轮询策略、流式输出、超时时间等参数。
- HTTP 接口压测配置：支持 URL、请求方法、Headers、Body、固定 QPS、固定并发、阶梯加压和状态码断言。
- 简易 HTTP 压测配置：适合快速填写目标地址、RPM、持续时间、并发数和超时时间。
- 分享压测链接：把当前表单参数编码到 URL 中，别人打开链接后会自动恢复配置。
- 静态部署友好：Vercel 上不需要数据库、WebSocket 或后端服务即可分享配置。
- 本地 Dashboard：在本地运行 Node 服务时，可以启动真实压测、查看实时监控并生成报告。
- CLI 模式：支持直接通过命令行运行 AI、HTTP 或默认压测流程。

## Vercel 静态部署

项目已经包含 `vercel.json`，部署到 Vercel 后会直接打开 `src/web/ui.html`。

静态部署模式主要用于编辑和分享压测配置：

1. 在页面填写压测参数。
2. 点击“分享压测链接”。
3. 将复制出的链接发给别人。
4. 对方打开链接后会自动恢复同一套配置。

为了避免密钥泄露，分享链接不会包含 API Key。对方需要在自己的页面里填写 Key。

## 本地运行 Dashboard

如果需要真正启动压测、实时监控、停止任务和生成报告，请在本地运行 Dashboard：

```bash
npm install
npm run dashboard
```

## CLI 用法

```bash
npm run ai
npm run http
npm start
```

## 注意事项

- Vercel 静态页面不能执行服务器侧压测，也不会保存历史报告。
- `config/config.yaml` 可能包含本地密钥，默认不会提交到 GitHub。
- 不要把真实 API Key 写进公开仓库、截图或分享链接。
- 真正发压建议在你自己的本地环境或可信服务器上运行。
