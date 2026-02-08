#!/bin/bash
# Unison 双向同步脚本
# 本地: ~/Code/macaron-rebuild/remote-code
# 远程: 通过 SSH config 中的 Host 别名连接（见 ~/.ssh/config）

set -e

PROFILE="remote-code"
INTERVAL="${1:-5}"  # 默认 5 秒检查一次，可通过参数修改

echo "=========================================="
echo "  Unison 双向同步"
echo "=========================================="
echo "配置文件: ~/.unison/${PROFILE}.prf"
echo "同步间隔: ${INTERVAL} 秒"
echo "按 Ctrl+C 停止同步"
echo "=========================================="
echo ""

# 执行同步
unison "$PROFILE" -repeat "$INTERVAL"
