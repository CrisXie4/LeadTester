# LoadTester — API 并发测压软件设计文档

> 版本：v1.0  
> 日期：2026-05-03  
> 用途：支持 AI 接口（RPM 控制）与通用 HTTP 接口（QPS/TPS 控制）的并发压力测试

---

## 1. 项目概述

### 1.1 背景
在 API 服务运维与模型部署场景中，需验证服务端在并发请求下的承载能力。本软件提供两种测压模式：

- **AI 接口测压模式**：针对 LLM / 生成式 AI API，按 **RPM（Requests Per Minute）** 控制请求速率，达到设定阈值后自动停止，统计延迟、丢包率及 Token 级指标。
- **通用 HTTP 测压模式**：针对任意 REST / WebSocket / gRPC 服务，按 **QPS/TPS** 或并发连接数控制压力，评估服务极限。

### 1.2 设计目标

| 目标 | 说明 |
|------|------|
| 精确速率控制 | AI 模式按 RPM 精确调度，HTTP 模式按 QPS/TPS 或并发数调度 |
| 实时观测 | 提供 WebSocket 实时仪表盘，展示延迟分布、吞吐量、错误率 |
| 自动熔断 | 达到设定 RPM / QPS / 错误阈值后自动停止，防止过度压测 |
| 结果可导出 | 支持 JSON / CSV / HTML 报告导出，含 P50/P90/P95/P99 延迟分位 |
| 轻量易部署 | 单文件可执行，零依赖或内嵌依赖 |

---

## 2. 系统架构

### 2.1 整体架构图

```
+---------------------------------------------------------------------+
|                        LoadTester 主控层                               |
|  +--------------+  +--------------+  +--------------------------+   |
|  |   CLI 入口    |  |  Web GUI 入口 |  |    配置文件解析器         |   |
|  +------+-------+  +------+-------+  +-----------+--------------+   |
|         +-----------------+----------------------+                 |
|                              |                                       |
|  +---------------------------+-----------------------------------+  |
|  |                      模式调度器 (Mode Router)                   |  |
|  |  +---------------------+      +-----------------------------+  |  |
|  |  |   AI 测压模式       |      |     HTTP 测压模式            |  |  |
|  |  |   (RPM 控制)        |      |     (QPS/TPS/并发控制)       |  |  |
|  |  +----------+----------+      +--------------+--------------+  |  |
|  +------------+-----------------------------------+---------------+  |
|                              |                                       |
|  +---------------------------+-----------------------------------+  |
|  |                      并发调度与速率控制层                        |  |
|  |  +--------------+  +--------------+  +------------------+    |  |
|  |  |  协程/线程池   |  |  令牌桶限流器   |  |   连接池管理器      |    |  |
|  |  |  (Worker Pool) |  | (Token Bucket) |  | (HTTP/WS/gRPC)   |    |  |
|  |  +--------------+  +--------------+  +------------------+    |  |
|  +---------------------------------------------------------------+  |
|                              |                                       |
|  +---------------------------+-----------------------------------+  |
|  |                      指标采集与存储层                            |  |
|  |  +--------------+  +--------------+  +------------------+    |  |
|  |  |  请求级采样器   |  |  聚合统计引擎   |  |   时序数据库       |    |  |
|  |  | (Latency/Status|  | (Histogram/   |  | (内存/SQLite/    |    |  |
|  |  |  /Error/Retry) |  |  Counter)      |  |  InfluxDB可选)   |    |  |
|  |  +--------------+  +--------------+  +------------------+    |  |
|  +---------------------------------------------------------------+  |
|                              |                                       |
|  +---------------------------+-----------------------------------+  |
|  |                      结果分析与展示层                              |  |
|  |  +--------------+  +--------------+  +------------------+    |  |
|  |  |  实时仪表盘    |  |  报告生成器     |  |   历史对比工具      |    |  |
|  |  | (WebSocket)   |  | (JSON/CSV/HTML|  | (多轮压测对比)    |    |  |
|  |  +--------------+  +--------------+  +------------------+    |  |
|  +---------------------------------------------------------------+  |
+---------------------------------------------------------------------+
```

### 2.2 模块职责

| 模块 | 职责 |
|------|------|
| **模式调度器** | 根据用户选择加载 AI 模式或 HTTP 模式，初始化对应配置与限流器 |
| **并发调度器** | 管理 Worker Pool，控制同时运行的请求协程/线程数量 |
| **速率控制器** | 基于令牌桶（Token Bucket）或漏桶（Leaky Bucket）算法实现精确速率限制 |
| **指标采集器** | 对每次请求采样：延迟、状态码、响应大小、错误类型、重试次数 |
| **聚合统计引擎** | 实时计算分位延迟、吞吐量、错误率，维护滑动窗口统计 |
| **实时仪表盘** | 通过 WebSocket 向前端推送实时数据，渲染折线图/直方图/仪表盘 |
| **报告生成器** | 压测结束后生成结构化报告，含时序曲线、错误分类、优化建议 |

---

## 3. 核心功能设计

### 3.1 AI 接口测压模式

#### 3.1.1 工作原理

以 **RPM（Requests Per Minute）** 为核心控制指标：

1. 用户设定目标 RPM（如 1000 RPM）。
2. 系统将 RPM 转换为 **RPS（Requests Per Second）** = RPM / 60。
3. 使用令牌桶算法，每秒均匀发放 RPS 个令牌，每个请求需获取令牌后方可执行。
4. 持续发送请求并累计计数，当实际 RPM 达到或超过设定值时，自动停止新请求发送。
5. 等待所有在途请求完成，汇总结果。

#### 3.1.2 请求构造规则 — 输入（Prompt）策略

> **核心原则：只需确保请求能被 API 正常接收并处理，不关注语义质量或输出内容。**
> 
> 调用 AI 接口时，输入（Prompt）仅需满足"能被 API 正常解析"的最低要求即可。输出内容无需校验其正确性、相关性或质量，只要接口返回 HTTP 200 且响应格式正常，即视为一次成功的调用。

| 策略 | 说明 | 适用场景 |
|------|------|---------|
| **默认随机文本** | 软件内置随机字符串生成器，产生 10~100 字无意义文本作为 messages[0].content | 快速启动，无需配置 |
| **用户自定义 Prompt** | 在配置界面提供文本框，允许用户输入任意内容作为固定 Prompt | 需要模拟真实业务输入 |
| **Prompt 模板库** | 内置若干常用模板（短文本生成、代码补全、长文本续写），用户可选 | 模拟不同长度/类型的负载 |
| **动态长度控制** | 支持设置输入 Token 范围（如 50~500 tokens），软件自动生成长度可控的填充文本 | 测试不同输入长度下的性能 |

**输入内容示例（随机文本模式）：**
```json
{
  "model": "gpt-3.5-turbo",
  "messages": [
    {"role": "user", "content": "xK9mP2vL7nQ4wR8tY6bF3hJ5gK1dS9aC2eX7mP4vN8qW2rT6yU1iO5pL3kD7jH4fG9bV2cX6nM1wQ8rY4tU7iO3pA5sD2fG8hJ4kL6zX9cV3bN7mQ1wE5rT2yU8iO4pL6kD3jH9fG5bV2xC7nM4wQ8r"}
  ]
}
```

**输出处理策略：**

- 无需解析或校验输出内容的正确性、语义质量或相关性。
- 仅采集以下技术指标：
  - 首字节时间（TTFB）
  - 流式首 Token 时间（TTFT，若支持 SSE/WebSocket 流式）
  - 总响应时间（从发起到收到完整响应）
  - 响应体大小 / 生成 Token 数（若响应头或体中包含 usage 字段则提取）

#### 3.1.3 API Key 轮询机制

```python
class KeyRotator:
    def __init__(self, keys):
        self.keys = keys
        self.index = 0
        self.failure_count = {k: 0 for k in keys}

    def get_key(self):
        key = self.keys[self.index % len(self.keys)]
        self.index += 1
        return key

    def report_failure(self, key, status_code):
        self.failure_count[key] += 1
        if self.failure_count[key] >= 3:
            # 标记为不可用，进入冷却期
            pass
```

| 策略 | 说明 |
|------|------|
| 轮询（Round Robin） | 依次使用 Key 池中的 Key，均匀分配负载 |
| 失败降级 | 某 Key 连续返回 429 / 401 / 403 时，自动暂停使用该 Key 5 分钟 |
| 权重分配 | 支持为不同 Key 设置权重（如付费 Key 权重高，免费 Key 权重低） |

#### 3.1.4 停止条件

| 条件 | 说明 |
|------|------|
| RPM 达标 | 累计请求数 / 经过时间 * 60 >= 设定 RPM，停止发送新请求 |
| 手动停止 | 用户点击停止按钮，立即终止调度器，等待在途请求完成 |
| 错误阈值 | 连续错误率超过设定值（如 50%）时自动熔断停止 |
| 时间上限 | 即使 RPM 未达标，运行超过最大时长（如 10 分钟）也强制停止 |

#### 3.1.5 核心指标

| 指标 | 英文 | 说明 |
|------|------|------|
| 目标 RPM | Target RPM | 用户设定的每分钟请求数目标 |
| 实际 RPM | Actual RPM | 压测期间实际达到的每分钟请求数 |
| 请求总数 | Total Requests | 发送的请求总量 |
| 成功数 | Success Count | HTTP 2xx 且未超时的请求数 |
| 失败数 | Failure Count | 超时、连接失败、4xx、5xx 的请求数 |
| 丢包率 | Packet Loss Rate | 失败数 / 请求总数 * 100% |
| P50/P90/P95/P99 延迟 | Latency Percentiles | 响应时间的分位值 |
| 平均延迟 | Avg Latency | 总响应时间 / 成功请求数 |
| 首 Token 时间 | TTFT | 从请求发送到收到第一个生成 Token 的时间（流式模式） |
| 每 Token 耗时 | TPOT | 总生成时间 / 生成 Token 数 |
| 限流触发次数 | Rate Limit Hits | 收到 HTTP 429 状态码的次数 |
| 输入 Token 数 | Input Tokens | 请求中携带的 Token 数量（估算或实际） |
| 输出 Token 数 | Output Tokens | 响应中生成的 Token 数量 |

---

### 3.2 通用 HTTP 测压模式

#### 3.2.1 工作原理

以 **QPS（Queries Per Second）**、**并发连接数** 或 **阶梯加压** 为核心控制手段：

1. **固定 QPS 模式**：以恒定速率发送请求，观察服务稳定性。
2. **固定并发模式**：维持 N 个并发连接，每个连接循环发送请求，观察吞吐量与延迟变化。
3. **阶梯加压模式**：每阶段增加一定 QPS/并发数，持续一段时间后进入下一阶段，直到服务出现明显性能拐点或错误率飙升。

#### 3.2.2 请求构造

| 配置项 | 说明 |
|--------|------|
| URL | 目标接口地址，支持 HTTP/HTTPS/WebSocket/gRPC |
| Method | GET / POST / PUT / DELETE / PATCH 等 |
| Headers | 自定义请求头，支持动态变量（如随机 ID、时间戳） |
| Body | 请求体，支持 JSON / Form / Raw / 文件上传，支持模板变量 |
| 断言规则 | 可选配置响应校验规则（如状态码 = 200、响应体包含某字段） |

#### 3.2.3 停止条件

| 条件 | 说明 |
|------|------|
| QPS 达标 | 累计请求数达到目标 QPS * 持续时间 |
| 时间到达 | 达到设定的压测时长 |
| 请求总数 | 发送请求数达到设定上限 |
| 错误熔断 | 错误率连续 30 秒超过设定阈值（如 10%） |
| 延迟熔断 | P99 延迟连续 30 秒超过设定阈值（如 5 秒） |
| 手动停止 | 用户主动终止 |

#### 3.2.4 核心指标

| 指标 | 说明 |
|------|------|
| QPS / TPS | 每秒查询/事务数 |
| 并发连接数 | 同时保持的连接数 |
| 吞吐量 | 每秒传输的数据量（MB/s） |
| P50/P90/P95/P99 延迟 | 响应时间分位值 |
| 错误率 | 失败请求占比 |
| 状态码分布 | 2xx / 3xx / 4xx / 5xx 占比 |
| 连接错误 | DNS 失败、TCP 超时、SSL 握手失败等 |
| 带宽占用 | 上行/下行带宽峰值与均值 |

---

## 4. 速率控制算法

### 4.1 令牌桶算法（Token Bucket）

适用于 AI 模式（RPM 控制）与固定 QPS 模式：

```python
import asyncio
import time

class TokenBucket:
    def __init__(self, rate, capacity):
        # rate: 每秒产生令牌数（如 RPM=1000 时，rate=1000/60≈16.67）
        # capacity: 桶容量，允许一定突发流量
        self.rate = rate
        self.capacity = capacity
        self.tokens = capacity
        self.last_update = time.monotonic()
        self._lock = asyncio.Lock()

    async def acquire(self, tokens=1.0):
        async with self._lock:
            now = time.monotonic()
            elapsed = now - self.last_update
            # 补充令牌
            self.tokens = min(self.capacity, self.tokens + elapsed * self.rate)
            self.last_update = now

            if self.tokens >= tokens:
                self.tokens -= tokens
                return True
            else:
                # 计算需要等待的时间
                wait_time = (tokens - self.tokens) / self.rate
                await asyncio.sleep(wait_time)
                self.tokens -= tokens
                return True
```

### 4.2 漏桶算法（Leaky Bucket）

适用于需要严格平滑流量的场景，防止突发：

```python
class LeakyBucket:
    def __init__(self, leak_rate):
        self.leak_rate = leak_rate  # 每秒漏出请求数
        self.water = 0              # 当前桶中水量（积压请求数）
        self.last_leak = time.monotonic()
        self._lock = asyncio.Lock()

    async def add(self):
        async with self._lock:
            now = time.monotonic()
            # 先漏水
            leaked = (now - self.last_leak) * self.leak_rate
            self.water = max(0, self.water - leaked)
            self.last_leak = now

            if self.water < 1:
                self.water += 1
                return True
            else:
                # 桶满，等待
                wait = (self.water - 1) / self.leak_rate
                await asyncio.sleep(wait)
                self.water += 1
                return True
```

---

## 5. 并发调度设计

### 5.1 Worker Pool 模型

```python
import asyncio
from dataclasses import dataclass

@dataclass
class TaskConfig:
    target_rps: float
    duration: int           # 秒
    max_workers: int = 1000  # 最大并发协程数

class WorkerPool:
    def __init__(self, config):
        self.config = config
        self.semaphore = asyncio.Semaphore(config.max_workers)
        self.results = []
        self.active_count = 0

    async def run(self, task_func, *args):
        tasks = []
        end_time = time.monotonic() + self.config.duration

        while time.monotonic() < end_time:
            async with self.semaphore:
                self.active_count += 1
                task = asyncio.create_task(
                    self._wrapped_task(task_func, *args)
                )
                tasks.append(task)

                # 速率控制：按 RPS 间隔发请求
                if self.config.target_rps > 0:
                    await asyncio.sleep(1.0 / self.config.target_rps)

        # 等待所有任务完成
        self.results = await asyncio.gather(*tasks, return_exceptions=True)
        return self._aggregate_results()

    async def _wrapped_task(self, task_func, *args):
        start = time.monotonic()
        try:
            result = await task_func(*args)
            status = "success"
            error = None
        except Exception as e:
            result = None
            status = "error"
            error = str(e)
        finally:
            self.active_count -= 1

        latency = time.monotonic() - start
        return {
            "status": status,
            "latency": latency,
            "error": error,
            "timestamp": start
        }
```

### 5.2 连接池管理

| 参数 | 默认值 | 说明 |
|------|--------|------|
| max_connections | 1000 | 单个目标主机的最大连接数 |
| max_keepalive | 100 | 保持连接数 |
| tcp_keepalive | True | 开启 TCP Keep-Alive |
| connection_timeout | 10s | 连接建立超时 |
| read_timeout | 30s | 响应读取超时 |
| http2 | True | 优先使用 HTTP/2 |

---

## 6. 指标采集与存储

### 6.1 请求级采样数据结构

```json
{
  "request_id": "uuid",
  "mode": "ai",
  "timestamp": 1714732800.123,
  "latency_ms": 245.6,
  "ttft_ms": 89.2,
  "status_code": 200,
  "is_success": true,
  "error_type": null,
  "input_tokens": 50,
  "output_tokens": 128,
  "response_size_bytes": 2048,
  "api_key_index": 0,
  "worker_id": 5,
  "retry_count": 0
}
```

### 6.2 聚合统计（滑动窗口）

| 窗口粒度 | 用途 |
|---------|------|
| 1 秒 | 实时仪表盘刷新 |
| 10 秒 | 短期趋势分析 |
| 1 分钟 | 中期稳定性评估 |
| 全量 | 最终报告生成 |

### 6.3 存储策略

| 模式 | 存储介质 | 说明 |
|------|---------|------|
| 轻量模式 | 内存 + 退出时导出 | 适合短时间压测，数据不保留 |
| 标准模式 | SQLite 本地文件 | 支持历史查询与对比 |
| 专业模式 | InfluxDB / Prometheus | 长期监控与 Grafana 集成 |

---

## 7. 实时仪表盘设计

### 7.1 前端技术栈

- **框架**：React + TypeScript（或纯 HTML/JS 内嵌）
- **图表库**：ECharts / Chart.js
- **实时通信**：WebSocket（服务端推送）
- **UI 组件**：Ant Design / 自研轻量组件

### 7.2 面板布局

```
+-------------------------------------------------------------+
|  [状态栏] 运行中 | 模式: AI | 目标 RPM: 1000 | 已运行: 03:24   |
+-------------------------------------------------------------+
|  +-------------+  +-------------+  +-------------+          |
|  |  当前 RPM    |  |  平均延迟    |  |  丢包率      |          |
|  |   987       |  |  234ms      |  |   0.3%      |          |
|  +-------------+  +-------------+  +-------------+          |
+-------------------------------------------------------------+
|  [RPS/RPM 实时曲线]                                          |
|    ^                                                        |
| 100+----------------------------------------                |
|    |    /\    /\    /\    /\    /\                       |
|  50+---/  \--/  \--/  \--/  \--/  \--                   |
|    |  /    \/    \/    \/    \/    \/                    |
|   0+------------------------------------------> 时间      |
+-------------------------------------------------------------+
|  [延迟分布直方图]    |  [状态码饼图]    |  [错误类型统计]     |
+-------------------------------------------------------------+
|  [P50/P90/P95/P99 延迟数值展示]                              |
+-------------------------------------------------------------+
|  [日志流] 14:32:01 [OK] 200 245ms | 14:32:01 [ERR] 429 ...  |
+-------------------------------------------------------------+
```

### 7.3 WebSocket 推送协议

```json
{
  "type": "metrics_update",
  "timestamp": 1714732800,
  "data": {
    "current_rpm": 987,
    "total_requests": 2961,
    "success_count": 2952,
    "failure_count": 9,
    "avg_latency_ms": 234,
    "p50_ms": 210,
    "p90_ms": 380,
    "p95_ms": 450,
    "p99_ms": 620,
    "error_rate": 0.003,
    "active_workers": 45,
    "status_codes": {"200": 2952, "429": 5, "500": 4}
  }
}
```

---

## 8. 报告生成

### 8.1 报告内容结构

```
1. 压测概览
   +-- 模式: AI 测压 / HTTP 测压
   +-- 目标: 1000 RPM / 500 QPS
   +-- 实际: 987 RPM / 485 QPS
   +-- 持续时间: 3 分 24 秒
   +-- 总请求数: 2961

2. 性能指标
   +-- 延迟分布表 (P50/P90/P95/P99/Max)
   +-- 吞吐量曲线图
   +-- 延迟趋势图

3. 稳定性分析
   +-- 错误率变化曲线
   +-- 状态码分布
   +-- 异常时刻标注

4. 容量评估
   +-- 是否达到目标 RPM/QPS
   +-- 建议最大安全负载
   +-- 瓶颈推测（网络/服务端/客户端）

5. 原始数据
   +-- 导出 CSV（每条请求明细）
   +-- 导出 JSON（聚合统计）
```

### 8.2 导出格式

| 格式 | 用途 |
|------|------|
| HTML | 可视化报告，可直接浏览器打开 |
| CSV | 导入 Excel 做二次分析 |
| JSON | 程序化读取，接入 CI/CD 流水线 |
| Markdown | 提交到 GitHub / 文档系统 |

---

## 9. 配置系统

### 9.1 配置文件示例（YAML）

```yaml
# config.yaml
mode: "ai"  # ai | http

# ========== AI 模式配置 ==========
ai_config:
  api_base: "https://api.openai.com/v1/chat/completions"
  model: "gpt-3.5-turbo"
  api_keys:
    - "sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
    - "sk-yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy"
  key_rotation: "round_robin"  # round_robin | weighted | random

  # RPM 控制
  target_rpm: 1000
  max_duration: 600  # 秒，最大运行时间

  # 输入策略
  input_strategy: "random_text"  # random_text | user_defined | template
  user_prompt: ""  # input_strategy=user_defined 时生效
  prompt_template: "short"  # short | code | long，input_strategy=template 时生效
  input_token_range: [50, 200]  # 输入 Token 数范围

  # 流式设置
  stream: true  # 是否使用流式输出（用于采集 TTFT）

  # 超时设置
  timeout:
    connection: 10
    read: 60
    total: 120

# ========== HTTP 模式配置 ==========
http_config:
  target_url: "https://api.example.com/v1/data"
  method: "POST"
  headers:
    Content-Type: "application/json"
    Authorization: "Bearer ${TOKEN}"
  body: |
    {
      "query": "test",
      "timestamp": ${NOW}
    }

  # 压力控制
  load_type: "fixed_qps"  # fixed_qps | fixed_concurrency | step
  target_qps: 500
  concurrency: 100  # fixed_concurrency 时生效
  step_config:      # step 时生效
    start_qps: 100
    step_size: 100
    step_duration: 60
    max_qps: 2000

  # 断言
  assertions:
    - type: "status_code"
      expected: 200
    - type: "json_path"
      path: "$.code"
      expected: 0

# ========== 通用配置 ==========
general:
  max_workers: 1000
  report_dir: "./reports"
  save_raw_data: true
  dashboard_port: 8080
  log_level: "info"
```

### 9.2 命令行参数

```bash
# AI 模式
python loadtester.py --mode ai \
  --api-base https://api.openai.com/v1/chat/completions \
  --model gpt-3.5-turbo \
  --api-keys sk-xxx,sk-yyy \
  --rpm 1000 \
  --duration 300 \
  --input-strategy random_text \
  --stream

# HTTP 模式
python loadtester.py --mode http \
  --url https://api.example.com/v1/data \
  --method POST \
  --qps 500 \
  --duration 300 \
  --concurrency 100 \
  --body '{"test": true}'

# 仅启动仪表盘查看历史报告
python loadtester.py --dashboard --port 8080
```

---

## 10. 安全与防护设计

### 10.1 防误伤机制

| 机制 | 说明 |
|------|------|
| 目标确认 | 首次压测某域名时，弹窗确认是否为测试环境 |
| 生产环境黑名单 | 内置常见生产域名黑名单，禁止压测（如 google.com, github.com） |
| 速率上限 | 单实例最高限制 10000 RPM / 5000 QPS，防止资源耗尽 |
| 冷却期 | 同一目标两次压测间隔不得少于 30 秒 |

### 10.2 资源保护

| 机制 | 说明 |
|------|------|
| 内存上限 | 原始数据采样超过 100 万条时自动切换为聚合模式 |
| CPU 限制 | Worker Pool 大小根据 CPU 核心数动态调整 |
| 连接限制 | 防止文件描述符耗尽，超出时告警并降速 |

### 10.3 数据安全

- API Key 存储使用本地加密（AES-256）或系统密钥链。
- 日志中自动脱敏 Key（显示前 8 位 + ****）。
- 报告导出时可选择是否包含原始请求明细（含敏感 Header）。

---

## 11. 技术栈选型

| 组件 | 选型 | 备选 |
|------|------|------|
| 开发语言 | Python 3.10+ | Go 1.21+ |
| 异步框架 | asyncio + aiohttp | asyncio + httpx |
| HTTP 客户端 | httpx (支持 HTTP/2) | aiohttp |
| Web 仪表盘 | FastAPI + WebSocket + Jinja2 | Flask-SocketIO |
| 前端图表 | ECharts (CDN 引入) | Chart.js |
| 数据存储 | SQLite (内置) | InfluxDB |
| 打包工具 | PyInstaller | Nuitka |
| 配置解析 | PyYAML | TOML |

---

## 12. 开发里程碑

| 阶段 | 周期 | 交付物 |
|------|------|--------|
| **MVP** | 1 周 | CLI 版 AI 模式 + 基础 RPM 控制 + CSV 报告导出 |
| **v0.2** | 1 周 | HTTP 模式 + 阶梯加压 + 断言功能 |
| **v0.3** | 1 周 | Web 仪表盘 + 实时曲线 + WebSocket |
| **v0.4** | 1 周 | Key 轮询 + 失败降级 + 多目标同时压测 |
| **v1.0** | 1 周 | 配置系统 + 历史对比 + 完整报告 + 打包发布 |

---

## 13. 附录

### 13.1 术语表

| 术语 | 说明 |
|------|------|
| RPM | Requests Per Minute，每分钟请求数 |
| RPS | Requests Per Second，每秒请求数 |
| QPS | Queries Per Second，每秒查询数 |
| TPS | Transactions Per Second，每秒事务数 |
| TTFT | Time To First Token，首 Token 时间 |
| TPOT | Time Per Output Token，每输出 Token 耗时 |
| TTFB | Time To First Byte，首字节时间 |
| P99 | 99% 分位延迟，即 99% 请求低于该值 |

### 13.2 参考实现

- [locust](https://locust.io/) — Python 负载测试框架
- [k6](https://k6.io/) — Go 编写的现代负载测试工具
- [wrk](https://github.com/wg/wrk/) — 高性能 HTTP 压测工具
- [oha](https://github.com/hatoo/oha) — Rust 编写的 HTTP 压测工具，支持实时仪表盘

---

*文档结束*
