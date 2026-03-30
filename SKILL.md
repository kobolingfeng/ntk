---
name: ntk
description: 基于信息密度路由的多智能体框架，MCP 协议接入，自适应任务复杂度
---

# NTK Multi-Agent Skill

NTK (NeedToKnow) 是一个基于信息密度路由的多智能体框架。它可以作为 MCP server 集成到任何支持 MCP 协议的 AI 客户端（VS Code Copilot、Claude Desktop、OpenClaw 等）。

## 快速接入

### MCP 配置（VS Code / Claude Desktop / OpenClaw）

**方式一：npm 全局安装后**

```json
{
  "mcpServers": {
    "ntk": {
      "command": "ntk",
      "args": ["mcp"]
    }
  }
}
```

**方式二：从源码运行**

```json
{
  "mcpServers": {
    "ntk": {
      "command": "npx",
      "args": ["tsx", "src/mcp/server.ts"],
      "cwd": "/path/to/ntk"
    }
  }
}
```

### 前置条件
1. 项目目录下有 `.env` 文件配置 API endpoints
2. 已安装依赖: `npm install`

## 可用工具

### ntk_run
通过自适应管线执行任务。自动根据复杂度路由到最优深度。

参数:
- `task` (string, 必须): 要执行的任务
- `forceDepth` (string, 可选): 强制指定深度 — `direct` | `light` | `standard` | `full`
- `skipScout` (boolean, 可选): 跳过调研阶段

适用: 所有类型任务（代码生成、翻译、分析、架构设计等）

### ntk_run_fast
最小开销执行。强制 direct 深度，全部使用低成本模型。

参数:
- `task` (string, 必须): 要执行的任务

适用: 简单代码生成、翻译、bug修复、单函数实现

### ntk_compress
信息密度压缩。提取关键信息，压缩长文本。

参数:
- `text` (string, 必须): 要压缩的文本
- `level` (string, 可选): `minimal` | `standard` | `aggressive`

适用: 在处理前压缩长文档、API 响应、日志等

## 深度路由说明

| 深度 | 触发条件 | 流程 | 适用场景 |
|------|---------|------|---------|
| direct | 简单编码/翻译/计算 | executor 直接执行 | 写函数、翻译、修bug |
| light | 中等复杂度 | executor 执行 | 一般问答 |
| standard | 需要调研的任务 | planner→scout→executor→verifier | API设计、技术对比 |
| full | 高度复杂任务 | planner(强模型)→scout→executor→verifier | 架构设计、系统设计 |

## 性能参考

- 简单任务 (direct): ~400 tokens, ~4s
- 中等任务 (standard): ~1500 tokens, ~15s
- 复杂任务 (full): ~3000 tokens, ~20s
- 全部使用低成本模型，仅 full 深度使用强模型做规划
