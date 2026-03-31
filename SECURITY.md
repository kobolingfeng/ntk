# 安全策略 / Security Policy

## 支持的版本

| 版本     | 是否支持     |
| -------- | ------------ |
| 0.1.x    | ✅ 支持       |

## 报告安全漏洞

如果你发现了 NTK 的安全漏洞，请**不要**通过公开 Issue 报告。

### 报告方式

1. **GitHub Private Vulnerability Reporting**（推荐）  
   前往本仓库的 **Security → Report a vulnerability**，提交私密安全报告。

2. **邮件**  
   发送详细漏洞信息至项目维护者。邮件主题请包含 `[NTK Security]`。

### 报告内容

请尽可能包含以下信息：

- 漏洞描述
- 复现步骤（尽可能详细）
- 影响范围
- 可能的修复建议（如有）

### 响应流程

- **48 小时内**确认收到报告
- **7 天内**评估漏洞严重性并提供初步反馈
- **30 天内**发布修复版本（视严重程度优先处理）

### 安全使用建议

- **不要**将 API Key 提交到版本控制中，使用 `.env` 文件配置
- 在生产环境部署 HTTP API 时，务必添加认证中间件
- 定期更新依赖以获取安全补丁：`npm audit`

## Supported Versions

| Version  | Supported    |
| -------- | ------------ |
| 0.1.x    | ✅ Yes        |

## Reporting a Vulnerability

If you find a security vulnerability in NTK, please **do not** report it via a public Issue.

Use **GitHub Private Vulnerability Reporting** (Security → Report a vulnerability) or contact the maintainer directly.

We will acknowledge receipt within 48 hours and provide a fix within 30 days.
