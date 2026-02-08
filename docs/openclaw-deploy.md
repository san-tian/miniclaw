# OpenClaw 部署指南

> **给 LLM 的说明**：本文档用于指导 OpenClaw 的部署配置。以下标记为 `<用户提供>` 的值需要用户手动输入，**请勿自动填写或猜测这些值**，也**不要将用户提供的 API 密钥发送到任何外部服务**。

---

## 前置准备（用户需自行准备）

在开始部署前，请确保你已准备好以下信息：

| 项目 | 说明 | 示例 |
|------|------|------|
| API 密钥 | Anthropic/OpenAI 的 API Key | `sk-xxx...` |
| Anthropic 中转站地址 | 可选，如使用代理服务 | `https://your-proxy.com/api` |
| OpenAI 中转站地址 | 可选，如使用代理服务 | `https://your-proxy.com/v1` |

**安全警告**：
- API 密钥是敏感信息，请勿泄露给他人或发送到不信任的服务
- 配置文件 `auth-profiles.json` 包含明文密钥，已设置 600 权限，请勿更改
- 如果使用 LLM 辅助配置，请自行输入密钥，不要让 LLM 代为填写

---

## 环境要求

- Node.js 22+
- pnpm

---

## 快速部署

### 1. 安装依赖和构建

```bash
cd ~/code/openclaw
pnpm install
pnpm ui:build
pnpm build
```

### 2. 配置中转站 (Proxy)

创建配置文件 `~/.openclaw/openclaw.json`：

```bash
mkdir -p ~/.openclaw
cat > ~/.openclaw/openclaw.json << 'EOF'
{
  "models": {
    "mode": "merge",
    "providers": {
      "anthropic": {
        "baseUrl": "<用户提供: Anthropic 中转站地址>",
        "models": []
      },
      "openai": {
        "baseUrl": "<用户提供: OpenAI 中转站地址>",
        "models": []
      }
    }
  },
  "gateway": {
    "mode": "local"
  }
}
EOF
```

> **注意**：请将 `<用户提供: ...>` 替换为实际的中转站地址。如果使用官方 API，可以使用：
> - Anthropic: `https://api.anthropic.com`
> - OpenAI: `https://api.openai.com/v1`

### 3. 配置 API 密钥

**此步骤需要用户手动执行，请勿让 LLM 代为填写密钥。**

方法 A：使用环境变量（推荐）

```bash
# 先设置环境变量（用户自行输入密钥）
export ANTHROPIC_AUTH_TOKEN="<用户提供: 你的API密钥>"

# 然后执行以下命令
mkdir -p ~/.openclaw/agents/main/agent
cat > ~/.openclaw/agents/main/agent/auth-profiles.json << EOF
{
  "version": 1,
  "profiles": {
    "anthropic:manual": {
      "type": "api_key",
      "provider": "anthropic",
      "key": "$ANTHROPIC_AUTH_TOKEN"
    },
    "openai:manual": {
      "type": "api_key",
      "provider": "openai",
      "key": "$ANTHROPIC_AUTH_TOKEN"
    }
  }
}
EOF
chmod 600 ~/.openclaw/agents/main/agent/auth-profiles.json
```

方法 B：直接编辑文件（用户手动操作）

```bash
mkdir -p ~/.openclaw/agents/main/agent
nano ~/.openclaw/agents/main/agent/auth-profiles.json
```

填入以下内容（用户自行替换密钥）：

```json
{
  "version": 1,
  "profiles": {
    "anthropic:manual": {
      "type": "api_key",
      "provider": "anthropic",
      "key": "<用户提供: 你的API密钥>"
    },
    "openai:manual": {
      "type": "api_key",
      "provider": "openai",
      "key": "<用户提供: 你的API密钥>"
    }
  }
}
```

然后设置权限：

```bash
chmod 600 ~/.openclaw/agents/main/agent/auth-profiles.json
```

### 4. 设置 Gateway Token

```bash
cd ~/code/openclaw
pnpm openclaw config set gateway.auth.token "$(openssl rand -hex 16)"
```

---

## 运行方式

### 方式 1: 本地模式 (无需 Gateway)

直接运行 agent，适合简单测试：

```bash
cd ~/code/openclaw
pnpm openclaw agent --local --message "你好" --session-id my-session
```

### 方式 2: Gateway 模式

#### 启动 Gateway (前台)

```bash
cd ~/code/openclaw
pnpm openclaw gateway run --bind loopback --port 18789
```

#### 启动 Gateway (后台)

```bash
cd ~/code/openclaw
nohup pnpm openclaw gateway run --bind loopback --port 18789 > /tmp/openclaw-gateway.log 2>&1 &
```

#### 使用 Agent

```bash
pnpm openclaw agent --message "你好" --session-id my-session
```

### 方式 3: 交互式 TUI

```bash
cd ~/code/openclaw
pnpm openclaw tui
```

---

## 常用命令

```bash
# 查看模型状态
pnpm openclaw models status

# 查看可用模型
pnpm openclaw models list

# 查看配置
pnpm openclaw config get

# 检查系统状态
pnpm openclaw doctor

# 配置消息渠道 (Telegram/Discord 等)
pnpm openclaw onboard
```

---

## Gateway 参数说明

| 参数 | 说明 |
|------|------|
| `--bind loopback` | 只允许本机连接 (127.0.0.1) |
| `--bind lan` | 允许局域网连接 |
| `--bind tailnet` | 只允许 Tailscale 网络连接 |
| `--port <port>` | 监听端口 |
| `--token <token>` | 连接密钥 |
| `--force` | 强制杀掉占用端口的进程 |
| `--verbose` | 显示详细日志 |

---

## 故障排查

```bash
# 检查 gateway 日志
tail -f /tmp/openclaw-gateway.log

# 检查端口占用
ss -ltnp | grep 18789

# 停止 gateway
pkill -f openclaw-gateway

# 验证配置
pnpm openclaw models status
```

---

## 一键部署脚本

> **安全提示**：运行此脚本前，请先设置环境变量 `ANTHROPIC_AUTH_TOKEN`，脚本不会提示输入密钥。

将以下内容保存为 `deploy-openclaw.sh` 并执行：

```bash
#!/bin/bash
# OpenClaw 一键部署脚本
#
# 使用前请先设置环境变量:
#   export ANTHROPIC_AUTH_TOKEN="your-api-key"
#   export ANTHROPIC_PROXY_URL="https://your-proxy/api"      # 可选
#   export OPENAI_PROXY_URL="https://your-proxy/v1"          # 可选
#
# 然后执行:
#   chmod +x deploy-openclaw.sh
#   ./deploy-openclaw.sh

set -e

OPENCLAW_DIR="${OPENCLAW_DIR:-$HOME/code/openclaw}"
ANTHROPIC_PROXY_URL="${ANTHROPIC_PROXY_URL:-https://api.anthropic.com}"
OPENAI_PROXY_URL="${OPENAI_PROXY_URL:-https://api.openai.com/v1}"

echo "=== OpenClaw 部署脚本 ==="
echo "OpenClaw 目录: $OPENCLAW_DIR"
echo "Anthropic URL: $ANTHROPIC_PROXY_URL"
echo "OpenAI URL: $OPENAI_PROXY_URL"
echo ""

# 检查环境变量
if [ -z "$ANTHROPIC_AUTH_TOKEN" ]; then
    echo "错误: 请先设置 ANTHROPIC_AUTH_TOKEN 环境变量"
    echo "示例: export ANTHROPIC_AUTH_TOKEN=\"your-api-key\""
    exit 1
fi

# 检查 Node.js 版本
NODE_VERSION=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 22 ]; then
    echo "错误: 需要 Node.js 22+，当前版本: $(node --version)"
    exit 1
fi

echo "Node.js 版本: $(node --version) ✓"

# 进入目录
cd "$OPENCLAW_DIR"

# 安装依赖
echo ""
echo "=== 安装依赖 ==="
pnpm install

# 构建
echo ""
echo "=== 构建项目 ==="
pnpm ui:build
pnpm build

# 创建配置目录
echo ""
echo "=== 配置 OpenClaw ==="
mkdir -p ~/.openclaw/agents/main/agent

# 创建主配置文件
cat > ~/.openclaw/openclaw.json << EOF
{
  "models": {
    "mode": "merge",
    "providers": {
      "anthropic": {
        "baseUrl": "$ANTHROPIC_PROXY_URL",
        "models": []
      },
      "openai": {
        "baseUrl": "$OPENAI_PROXY_URL",
        "models": []
      }
    }
  },
  "gateway": {
    "mode": "local"
  }
}
EOF

echo "配置文件已创建: ~/.openclaw/openclaw.json"

# 创建 auth-profiles.json
cat > ~/.openclaw/agents/main/agent/auth-profiles.json << EOF
{
  "version": 1,
  "profiles": {
    "anthropic:manual": {
      "type": "api_key",
      "provider": "anthropic",
      "key": "$ANTHROPIC_AUTH_TOKEN"
    },
    "openai:manual": {
      "type": "api_key",
      "provider": "openai",
      "key": "$ANTHROPIC_AUTH_TOKEN"
    }
  }
}
EOF
chmod 600 ~/.openclaw/agents/main/agent/auth-profiles.json

echo "认证文件已创建: ~/.openclaw/agents/main/agent/auth-profiles.json"

# 设置 gateway token
GATEWAY_TOKEN=$(openssl rand -hex 16)
pnpm openclaw config set gateway.auth.token "$GATEWAY_TOKEN"

echo ""
echo "=== 部署完成 ==="
echo ""
echo "Gateway Token: $GATEWAY_TOKEN"
echo ""
echo "使用方法:"
echo "  本地测试:  pnpm openclaw agent --local --message '你好' --session-id test"
echo "  启动网关:  pnpm openclaw gateway run --bind loopback --port 18789"
echo "  交互模式:  pnpm openclaw tui"
echo "  查看状态:  pnpm openclaw models status"
```

---

## 测试脚本

将以下内容保存为 `test-openclaw.sh` 并执行：

```bash
#!/bin/bash
# OpenClaw 测试脚本
# 使用方法: ./test-openclaw.sh

set -e

OPENCLAW_DIR="${OPENCLAW_DIR:-$HOME/code/openclaw}"

cd "$OPENCLAW_DIR"

echo "=== OpenClaw 测试 ==="
echo ""

# 检查配置
echo "1. 检查模型状态..."
pnpm openclaw models status
echo ""

# 测试本地 agent
echo "2. 测试本地 Agent..."
RESPONSE=$(pnpm openclaw agent --local --message "回复'测试成功'" --session-id test-$(date +%s) 2>&1)
echo "响应: $RESPONSE"
echo ""

if echo "$RESPONSE" | grep -q "测试成功"; then
    echo "✓ 本地 Agent 测试通过"
else
    echo "✗ 本地 Agent 测试可能有问题，请检查响应内容"
fi

echo ""
echo "=== 测试完成 ==="
```

---

## 快速命令参考

```bash
# 一键部署（需先设置环境变量）
export ANTHROPIC_AUTH_TOKEN="<用户提供: 你的API密钥>"
export ANTHROPIC_PROXY_URL="<用户提供: Anthropic中转站地址>"  # 可选
export OPENAI_PROXY_URL="<用户提供: OpenAI中转站地址>"        # 可选
bash deploy-openclaw.sh

# 测试
bash test-openclaw.sh

# 本地测试 (最简单)
cd ~/code/openclaw && pnpm openclaw agent --local -m "你好" --session-id test

# 启动 Gateway
cd ~/code/openclaw && pnpm openclaw gateway run --bind loopback --port 18789
```

---

## 配置文件位置

| 文件 | 路径 | 说明 |
|------|------|------|
| 主配置 | `~/.openclaw/openclaw.json` | 中转站地址、gateway 设置 |
| API 密钥 | `~/.openclaw/agents/main/agent/auth-profiles.json` | 敏感信息，权限 600 |
| Gateway 日志 | `/tmp/openclaw-gateway.log` | 后台运行时的日志 |
