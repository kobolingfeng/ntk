# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] — 2026-03-31

### 新增
- 自适应 4 级深度管线 (direct / light / standard / full)
- 信息密度路由 — 每个 Agent 只接收完成任务所需的最少信息
- 双模型成本分离 — 95%+ token 使用廉价模型
- 5 个专职 Agent: Planner, Scout, Executor, Verifier, Summarizer
- CLI 工具: run, interactive, serve, test, baseline, ablation, optimize
- MCP Server 集成 (VS Code, Claude Desktop)
- HTTP API 服务
- 130 个单元测试
- Biome linter/formatter 集成
- CI/CD (GitHub Actions)

### 架构
- Pipeline 按深度拆分为独立子模块 (classifier, depth-direct/light/standard/full, helpers)
- CLI benchmarks 按功能拆分 (baseline, ablation, optimize, test-suite)
- 信息路由器实现 need-to-know 原则
- 自适应压缩器 (minimal/standard/aggressive)
