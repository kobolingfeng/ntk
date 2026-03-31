# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.1] — 2026-03-31

### 新增
- 两阶段信息压缩系统
  - 确定性预过滤层（9 种零 token 策略）
  - 智能输出类型检测（test/json/log/build/general）
  - 代码块注释压缩
  - JSON 紧凑化
  - URL 缩短
  - 样板信息过滤
- Tee 机制（压缩回溯）
- 响应缓存（重复任务零 token）
- 投机执行（管线级分支预测）
- 深度预测器（基于历史数据）
- 提示词分带选择（code/analysis/general）
- 动态 temperature 调度
- 智能输入截断（超长输入保留首尾）
- `ntk gain` 累计统计命令
- `ntk compare` 三方对比基准测试（11 个用例）
- CLI 流式输出（direct + standard 深度实时逐 token 显示）
- 自定义错误类型系统（NTKError 层级）
- API server 限流（每 IP 每分钟 30 请求）
- 持久化 probe 缓存（~/.ntk/）
- exports map（子路径导出）
- CI badge + Node.js 24 支持

### 性能
- 自适应 max_tokens（短任务限 512，中等 1024）
- 分类器快速路径扩展（CJK 感知阈值）
- 精简 executor 提示词（direct 深度 -84% token）
- MCP server 初始化优化（避免重复 probe）

### 修复
- 去重函数推入归一化文本而非原始文本
- 缓存 key 未区分 force-depth
- 投机执行未处理 Promise 异常
- CJK 分类器阈值过高导致复杂任务误判
- preFilterStats 无限增长
- 预过滤正则 false positive

### 测试
- 192 个测试（+62），11 个测试文件
- 覆盖所有 Agent、核心模块、管线集成
- 覆盖率阈值从 10% 提高到 60%

### 架构
- run* 函数签名统一为 options object
- 磁盘缓存路径统一使用 os.homedir()
- 惰性加载 probe 缓存
- package.json 添加 repository 字段

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
