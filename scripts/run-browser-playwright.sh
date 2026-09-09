#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
session_name="${CU_WIKI_PLAYWRIGHT_SESSION:-cu_wiki_search_browser}"
cdp_endpoint="${CU_WIKI_CDP_ENDPOINT:-http://127.0.0.1:${CU_WIKI_CDP_PORT:-9222}}"

if [[ $# -ne 1 ]]; then
  echo "用法：$0 <run-code 脚本>" >&2
  exit 2
fi
script_path="$1"
if [[ "$script_path" != /* ]]; then
  script_path="$project_dir/$script_path"
fi
if [[ ! -f "$script_path" ]]; then
  echo "Playwright 脚本不存在：$script_path" >&2
  exit 2
fi
if ! curl --connect-timeout 2 --max-time 3 -fsS \
  "${cdp_endpoint%/}/json/version" --output /dev/null; then
  echo "浏览器 CDP 不可达：$cdp_endpoint；先运行 npm run browser:start，或配置已有 CDP 地址。" >&2
  exit 1
fi

detach() {
  playwright-cli -s="$session_name" detach >/dev/null 2>&1 || true
}
trap detach EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# The browser may belong to the user; session cleanup only detaches this connection.
detach
playwright-cli -s="$session_name" attach --cdp="$cdp_endpoint"
# Some CLI versions print a tool error but still exit zero.
run_output="$(playwright-cli -s="$session_name" run-code --filename="$script_path")" || {
  run_status=$?
  printf '%s\n' "$run_output"
  exit "$run_status"
}
printf '%s\n' "$run_output"
if [[ "$run_output" == '### Error'* || "$run_output" == *$'\n### Error\n'* ]]; then
  exit 1
fi
