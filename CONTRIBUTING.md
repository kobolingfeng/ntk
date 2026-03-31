# 贡献指南

感谢你对 NTK 项目的兴趣！以下是参与贡献的方式。

## 开发环境

```bash
git clone https://github.com/kobolingfeng/ntk.git
cd ntk
npm install
```

## 开发流程

1. Fork 本仓库并创建分支
2. 安装依赖: `npm install`
3. 开发 & 写测试
4. 运行检查:
   ```bash
   npm run typecheck   # 类型检查
   npm run lint        # 代码风格
   npm test            # 单元测试
   ```
5. 提交 PR

## 代码规范

- 使用 [Biome](https://biomejs.dev/) 进行代码格式化和 lint
- 运行 `npm run lint:fix` 自动修复风格问题
- Git commit message 使用中文

## 项目结构

```
src/
├── agents/      # 各角色 Agent (Planner, Scout, Executor, Verifier, Summarizer)
├── api/         # HTTP API 服务
├── cli/         # CLI 入口和基准测试命令
├── core/        # 核心组件 (Router, Compressor, LLM Client, Protocol)
├── mcp/         # MCP Server
└── pipeline/    # 自适应管线引擎 (4 级深度路由)
```

## 测试

- 单元测试: `npm test`
- 集成测试 (需要 API Key): `npm run test:run`
- 基准测试: `npx tsx src/cli.ts baseline`

## 报告 Bug

请使用 GitHub Issues，并包含:
- 复现步骤
- 期望行为 vs 实际行为
- 环境信息 (Node 版本、模型配置)

## 许可证

贡献的代码将以 [AGPL-3.0](LICENSE) 许可发布。
