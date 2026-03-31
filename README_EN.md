<div align="center">

# 🔒 NTK

### Need To Know

**Know less. Do more.**

*While every multi-agent framework tries to give AI more context,*
*we asked a different question: what if we give AI less?*

[![TypeScript](https://img.shields.io/badge/TypeScript-ESM-blue)]()
[![License](https://img.shields.io/badge/License-AGPL--3.0-red)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-Compatible-purple)]()
[![LINUX DO](https://img.shields.io/badge/LINUX%20DO-Community-orange)](https://linux.do)

中文 | **English**

</div>

---

## What Is This

Every multi-agent framework does the same thing: give each agent as much context as possible. Longer conversation histories, bigger memory stores, more complex tool chains — hoping AI will find the answer in a sea of information.

**NTK does the opposite.**

In military intelligence, there's a principle called "Need-to-Know Basis" — even with top-secret clearance, you're only told the minimum information required to complete your mission. NTK brings this principle to multi-agent systems:

> **Each agent receives only the minimum information it needs to complete its task. Not a single word more.**

This isn't a limitation — it's an advantage. Cognitive science tells us that **selective attention** is the essence of focus — not seeing more, but ignoring more. LLMs work the same way: they're more precise, more instruction-following, and less prone to hallucination with shorter context. Give less, get more.

### Core Technology

- **Adaptive Complexity Routing** — Automatically evaluates task complexity via regex fast path + lightweight LLM classifier. Complex tasks go through multi-stage pipelines; simple tasks get single-step execution.
- **Selective Forgetting** — Agents don't pass raw context to each other. Instead, information is density-compressed and delivered on a need-to-know basis.
- **Zero-Overhead Classification** — 63% of tasks are classified via regex fast path in microseconds, completely bypassing the LLM classifier with zero additional token cost.
- **Progressive Pipeline Depth** — Four-level adaptive depth: direct → light → standard → full. Like TCP slow start, complexity only escalates when necessary.
- **Dual-Model Cost Isolation** — 95%+ tokens go through the cheap model. Only 2-5% of high-density reasoning decisions use the strong model — a cost structure similar to mixed-precision training.

## Why NTK

### 🎯 Adaptive, Not Excessive

Most "smart" frameworks run every task through the same complex pipeline. Writing a Fibonacci function? Still goes through plan → research → execute → verify.

NTK doesn't do that. It first uses a **zero-overhead regex classifier** (handles 63% of common tasks) to judge complexity, only activating deeper pipelines when necessary:

| Your Task | NTK's Approach | Cost |
|-----------|---------------|------|
| "Write a sort function" | Single-step output | **~400 tok, 4s** |
| "Design a REST API" | Research → Execute | ~2500 tok, 19s |
| "Microservice architecture" | Full pipeline | ~3000 tok, 20s |

Writing Fibonacci and designing microservice architecture **shouldn't cost the same**. NTK ensures they don't.

### 💰 95%+ Cost Savings, Zero Quality Loss

NTK's secret weapon is the **dual-model strategy**: 95% of work goes to the cheap model. Only planning steps that require deep reasoning (~2-5% of tokens) use the strong model.

Benchmark data (9 task categories, 9/9 passed, 0 bugs):

| | Traditional (All Strong) | NTK |
|---|---|---|
| Avg tokens | ~2000 | **1098** |
| Strong model token % | 100% | **< 5%** |
| Avg execution time | ~37s | **10.5s** |
| Code quality (bugs) | — | **0** |

### 🧪 Battle-Tested, Not a Demo

This isn't a proof of concept. NTK has been through 50+ systematic experiments including:

- **6 configurations × multi-complexity tasks** optimization matrix
- **Manual code review** quality validation (line-by-line bug and requirement checks)
- **Ablation studies** proving each module's necessity
- **Discovery**: complex pipelines actually introduce bugs on simple tasks (over-decomposition)

The most compelling dataset — the same function (mergeIntervals, 6 requirements), three depths:

| Depth | Tokens | Time | Bugs | Requirements |
|-------|--------|------|------|-------------|
| Direct (NTK recommended) | **654** | **4.2s** | **0** | 6/6 |
| Full (complete pipeline) | 13,216 | 63.5s | 1 | 6/6 |

Direct used **1/20th of Full's tokens** with zero bugs. Full introduced 1 bug due to over-decomposition. **Simpler tasks shouldn't use complex pipelines** — that's exactly why adaptive routing exists.

## Quick Start

```bash
git clone https://github.com/kobolingfeng/ntk.git
cd ntk && npm install
cp .env.example .env  # Add your API keys
```

### One Command

```bash
npx tsx src/cli.ts run "Write an LRU cache in Python"
```

### MCP Integration

NTK natively supports the [MCP protocol](https://modelcontextprotocol.io), plugging directly into VS Code Copilot, Claude Desktop, OpenClaw, or any MCP-compatible client.

**Option 1: npm global install (recommended)**

```bash
npm install -g ntk
```

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

**Option 2: Run from source**

```bash
git clone https://github.com/kobolingfeng/ntk.git
cd ntk && npm install
```

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

Three tools available after integration:
- **ntk_run** — Adaptive pipeline (auto-selects optimal depth)
- **ntk_run_fast** — Turbo mode (direct execution, minimal overhead)
- **ntk_compress** — Information-density compression

### Platform-Specific Setup

<details>
<summary><b>VS Code Copilot (GitHub Copilot Chat)</b></summary>

Create `.vscode/mcp.json` in your project root:

```json
{
  "servers": {
    "ntk": {
      "command": "npx",
      "args": ["tsx", "src/mcp/server.ts"],
      "cwd": "/path/to/ntk"
    }
  }
}
```

Restart VS Code and the `ntk_run` tools will be available in Copilot Chat.

</details>

<details>
<summary><b>Claude Desktop</b></summary>

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

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

Requires `npm install -g ntk` first.

</details>

<details>
<summary><b>OpenClaw / Other MCP Clients</b></summary>

Add NTK server to your MCP configuration. Any client supporting MCP protocol can connect via stdio transport:

```json
{
  "mcpServers": {
    "ntk": {
      "command": "ntk",
      "args": ["mcp"],
      "env": {
        "API_ENDPOINT_1_KEY": "sk-your-key",
        "API_ENDPOINT_1_URL": "https://your-api.com/v1"
      }
    }
  }
}
```

Environment variables can be passed via the `env` field or configured in the `.env` file in the ntk project directory.

</details>

### Tool Usage Examples

After MCP integration, use in any AI client:

```
// Adaptive execution — auto-selects optimal depth
ntk_run({ task: "Write a Python LRU cache with TTL support" })

// Fast execution — single step for simple tasks
ntk_run_fast({ task: "Write a merge intervals function" })

// Force specific depth
ntk_run({ task: "Design microservice architecture", forceDepth: "full" })

// Information compression
ntk_compress({ text: "Long text...", level: "aggressive" })
```

### Other Ways to Run

```bash
npx tsx src/cli.ts interactive                # Interactive mode
npx tsx src/cli.ts serve --port 3210          # HTTP API server
npx tsx src/cli.ts mcp                        # MCP stdio server
```

## Configuration

NTK requires you to bring your own OpenAI-compatible API endpoint. **No API keys are included** — you must provide your own.

### Basic Setup

Copy the example file and edit:

```bash
cp .env.example .env
```

**Minimal config** (single endpoint + single model):

```env
API_ENDPOINT_1_KEY=sk-your-api-key
API_ENDPOINT_1_URL=https://api.openai.com/v1
API_ENDPOINT_1_NAME=openai
MODEL=gpt-4o
```

Setting `MODEL` makes all agents use the same model.

### Dual-Model Strategy (Recommended)

NTK's core advantage: **only planning uses a strong model; everything else uses a cheap model**:

```env
API_ENDPOINT_1_KEY=sk-your-api-key
API_ENDPOINT_1_URL=https://api.openai.com/v1
API_ENDPOINT_1_NAME=openai

PLANNER_MODEL=gpt-4o          # Strong model — only used for full-depth planning
COMPRESSOR_MODEL=gpt-4o-mini  # Cheap model — Scout/Executor/Verifier all use this
```

63% of tasks take the Direct path and never trigger the Planner, so most requests run on the cheap model.

### Multi-Endpoint Failover

Configure multiple API endpoints. NTK probes them in parallel at startup and auto-selects the fastest:

```env
API_ENDPOINT_1_KEY=sk-key-a
API_ENDPOINT_1_URL=https://api.openai.com/v1
API_ENDPOINT_1_NAME=openai

API_ENDPOINT_2_KEY=sk-key-b
API_ENDPOINT_2_URL=https://your-backup.com/v1
API_ENDPOINT_2_NAME=backup

PLANNER_MODEL=gpt-4o
COMPRESSOR_MODEL=gpt-4o-mini
```

If the current endpoint goes down, NTK automatically fails over to the next one.

### Compatible API Providers

Any OpenAI-compatible API works, including but not limited to:

| Provider | Example URL | Notes |
|----------|-------------|-------|
| OpenAI | `https://api.openai.com/v1` | Official API |
| Azure OpenAI | `https://your-resource.openai.azure.com/v1` | Enterprise |
| Ollama (local) | `http://localhost:11434/v1` | Free, runs models locally |
| LM Studio (local) | `http://localhost:1234/v1` | Free, GUI model manager |
| DeepSeek | `https://api.deepseek.com/v1` | Cost-effective |
| Any proxy | `https://your-proxy.com/v1` | Any OpenAI-compatible relay |

### Configuration in MCP Clients

When connecting via MCP, you can pass API config directly in the `env` field — no `.env` file needed:

```json
{
  "mcpServers": {
    "ntk": {
      "command": "ntk",
      "args": ["mcp"],
      "env": {
        "API_ENDPOINT_1_KEY": "sk-your-key",
        "API_ENDPOINT_1_URL": "https://api.openai.com/v1",
        "API_ENDPOINT_1_NAME": "openai",
        "PLANNER_MODEL": "gpt-4o",
        "COMPRESSOR_MODEL": "gpt-4o-mini"
      }
    }
  }
}
```

### Debug

```env
DEBUG=true  # Enable verbose logging — shows routing decisions and agent call chains
```

## Architecture

```
User Request
  ↓
🔀 Adaptive Classifier (Regex fast path / LLM)
  │
  ├── direct  →  🔧 Executor → Result       ← 63% of tasks go here
  ├── light   →  🔧 Executor → Result
  ├── standard → 🔍 Scout → 🔧 Executor → Result
  └── full    →  🧠 Planner(strong) → 🔧 Executor×N → ✅ Verifier → Result
```

5 Agent types, organized by information density:
- **Planner** — Only agent using strong model, handles high-density decisions (full depth only)
- **Scout / Summarizer** — Cheap model, information gathering & compression
- **Executor** — Cheap model, core task execution
- **Verifier** — Cheap model, result validation

## Benchmarks

NTK includes a complete benchmarking toolkit:

```bash
npx tsx src/cli.ts test       # 9-task regression test
npx tsx src/cli.ts baseline   # NTK vs direct LLM comparison
npx tsx src/cli.ts ablation   # Ablation study (module contribution)
npx tsx src/cli.ts optimize   # 6-config optimization matrix
```

See [SKILL.md](SKILL.md) for detailed skill documentation.

## Community

Thanks to the [LINUX DO](https://linux.do) community for their support.

## Sponsors

If NTK helps you, consider supporting the project:

<div align="center">
<table>
<tr>
<td align="center"><b>WeChat</b></td>
<td align="center"><b>LDXP Store</b></td>
<td align="center"><b>PayPal</b></td>
</tr>
<tr>
<td align="center"><img src="assets/wechat-sponsor.png" width="200" /></td>
<td align="center"><img src="assets/ldxp-sponsor.png" width="200" /></td>
<td align="center"><a href="https://paypal.me/koboling">paypal.me/koboling</a></td>
</tr>
</table>
</div>

## License

[AGPL-3.0](LICENSE) — Free to use, modify, and distribute, but any modified version or network service based on this project must be open-sourced under the same license.
