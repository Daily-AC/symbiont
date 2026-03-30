#!/bin/bash
# Symbiont 部署脚本 — SSH 到 home 服务器
#
# 用法: ./scripts/deploy.sh [--skip-tests] [--skip-deps]
#
# 安全保证：只通过 git pull 同步已 commit 的代码，不会覆盖运行时数据

set -euo pipefail

HOST="home"
SIA_DIR="~/sia"
SERVICE="sia"

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

# 参数解析
SKIP_TESTS=false
SKIP_DEPS=false
for arg in "$@"; do
  case $arg in
    --skip-tests) SKIP_TESTS=true ;;
    --skip-deps)  SKIP_DEPS=true ;;
  esac
done

step() { echo -e "\n${GREEN}[$1]${NC} $2"; }
warn() { echo -e "${YELLOW}⚠ $1${NC}"; }
fail() { echo -e "${RED}✗ $1${NC}"; exit 1; }

remote() { ssh "$HOST" "$@"; }

# ============================================
echo -e "${GREEN}=== Symbiont Deploy ===${NC}"

# 0. 连通性检查
step "0/7" "检查 SSH 连接..."
remote "echo ok" >/dev/null 2>&1 || fail "无法连接 $HOST"

# 1. 处理 home 本地改动（小希运行时修改的 manifest 等）+ 拉取代码
step "1/7" "拉取代码..."
PULL_OUTPUT=$(remote "cd $SIA_DIR && git stash -q 2>/dev/null; git pull origin master 2>&1; git stash pop -q 2>/dev/null || true")
echo "$PULL_OUTPUT"
if echo "$PULL_OUTPUT" | grep -q "Already up to date"; then
  warn "代码无变化，继续部署（可能是配置/重启需要）"
fi

# 2. 检查是否需要安装依赖
if [ "$SKIP_DEPS" = false ]; then
  if echo "$PULL_OUTPUT" | grep -qE "package(-lock)?\.json"; then
    step "2/7" "依赖有变化，安装中..."
    remote "cd $SIA_DIR && npm install 2>&1 | tail -3"
  else
    step "2/7" "依赖无变化，跳过 npm install"
  fi
else
  step "2/7" "跳过依赖安装 (--skip-deps)"
fi

# 3. 单元测试（启动前预检）
if [ "$SKIP_TESTS" = false ]; then
  step "3/7" "运行单元测试..."
  TEST_OUTPUT=$(remote "cd $SIA_DIR && node --experimental-strip-types --test \$(ls tests/*.test.ts | grep -v -e e2e -e integration) 2>&1 | tail -10" || true)
  echo "$TEST_OUTPUT"
  if echo "$TEST_OUTPUT" | grep -q "fail"; then
    warn "部分测试失败，请确认是否继续"
  fi
else
  step "3/7" "跳过测试 (--skip-tests)"
fi

# 4. 重启服务
step "4/7" "重启 Sia..."
remote "systemctl --user restart $SERVICE"
sleep 3

# 5. 健康检查（Dashboard + Gateway）
step "5/7" "健康检查..."
HEALTH=$(remote "curl -sf http://127.0.0.1:18080/health 2>/dev/null || echo 'FAIL'")
if [ "$HEALTH" = "FAIL" ]; then
  sleep 3
  HEALTH=$(remote "curl -sf http://127.0.0.1:18080/health 2>/dev/null || echo 'FAIL'")
fi
if [ "$HEALTH" = "FAIL" ]; then
  fail "Dashboard 健康检查失败！查看日志: ssh $HOST journalctl --user -u $SERVICE -n 30"
else
  echo -e "  ${GREEN}✓${NC} Dashboard 正常"
fi

GW_HEALTH=$(remote "curl -sf http://127.0.0.1:18090/health 2>/dev/null || echo 'FAIL'")
if [ "$GW_HEALTH" != "FAIL" ]; then
  GW_TOOLS=$(echo "$GW_HEALTH" | grep -o '"tools":[0-9]*' | grep -o '[0-9]*')
  GW_BACKENDS=$(echo "$GW_HEALTH" | grep -o '"backends":\[[^]]*\]' | tr -d '[]"' | sed 's/backends://')
  echo -e "  ${GREEN}✓${NC} Gateway 正常（${GW_TOOLS} 工具，后端: ${GW_BACKENDS}）"
else
  warn "Gateway 健康检查失败（不阻塞部署）"
fi

# 6. 记录 release（含 commit 摘要）
step "6/7" "记录 release..."
GIT_HASH=$(git -C "$(dirname "$0")/.." rev-parse --short HEAD 2>/dev/null || echo "unknown")
VERSION=$(date +%Y.%m.%d)-$GIT_HASH
# 获取自上次 release 以来的 commit 摘要
COMMITS_JSON=$(cd "$(dirname "$0")/.." && git log --oneline -10 --format='%s' 2>/dev/null | head -10 | python3 -c "
import sys, json
commits = [line.strip() for line in sys.stdin if line.strip()]
print(json.dumps(commits))
" 2>/dev/null || echo '[]')
RELEASE_BODY="{\"version\":\"$VERSION\",\"commits\":$COMMITS_JSON,\"git_hash\":\"$GIT_HASH\"}"
remote "curl -sf -X POST http://127.0.0.1:18080/api/releases \
  -H 'Content-Type: application/json' \
  -d '$(echo "$RELEASE_BODY" | sed "s/'/'\\\\''/g")'" >/dev/null 2>&1 \
  && echo "  版本: $VERSION" \
  || warn "release 记录失败（不影响部署）"

# 7. 飞书连接确认
step "7/7" "飞书连接..."
FEISHU_OK=$(remote "journalctl --user -u $SERVICE --no-pager -n 20 2>/dev/null | grep -c 'WSClient connected'" || echo "0")
if [ "$FEISHU_OK" -gt 0 ]; then
  echo -e "  ${GREEN}✓${NC} 飞书 WSClient 已连接"
else
  warn "飞书连接未确认（可能还在初始化）"
fi

echo -e "\n${GREEN}=== 部署完成 ===${NC}"
