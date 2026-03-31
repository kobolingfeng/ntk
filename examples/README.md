# NTK Examples

NTK 的使用示例，帮助你快速上手。

## 运行前准备

```bash
# 从项目根目录安装依赖
cd ..
npm install

# 本地验证整个项目（可选，耗时 ~30 秒）
npm run verify

# 配置环境变量
cp .env.example .env
# 编辑 .env，填入你的 API Key
```

## 示例列表

| 示例 | 说明 |
|------|------|
| [shared.ts](./shared.ts) | 公共配置加载器（所有示例共用） |
| [basic-usage.ts](./basic-usage.ts) | 基础用法 — 创建 Pipeline 运行单个任务 |
| [custom-agents.ts](./custom-agents.ts) | 自定义 Agent — 单独使用各个智能体 |
| [http-server.ts](./http-server.ts) | HTTP API 服务 — 启动 REST 服务 |

## 运行示例

```bash
# 使用 tsx 直接运行（无需编译）
npx tsx examples/basic-usage.ts

npx tsx examples/custom-agents.ts

npx tsx examples/http-server.ts
```
