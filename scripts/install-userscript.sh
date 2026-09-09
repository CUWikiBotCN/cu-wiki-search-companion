#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
served_file="$(mktemp)"
playwright_script="$(mktemp)"
server_host="${CU_WIKI_DEV_SERVER_HOST:-127.0.0.1}"
server_port="${CU_WIKI_DEV_SERVER_PORT:-8788}"
server_url="${CU_WIKI_USERSCRIPT_URL:-http://${server_host}:${server_port}/cu-wiki-local-search.user.js}"
server_pid=""

cleanup() {
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -f "$served_file" "$playwright_script"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cd "$project_dir"
build_id="${CU_WIKI_BUILD_ID:-install-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
export CU_WIKI_BUILD_ID="$build_id"
npm run build

if ! curl --connect-timeout 3 --max-time 15 --fail --silent --show-error "$server_url" --output "$served_file" 2>/dev/null; then
  if [[ -n "${CU_WIKI_USERSCRIPT_URL:-}" ]]; then
    echo "配置的 userscript URL 不可达：$server_url" >&2
    exit 1
  fi
  # Serve only this build and only for this install; never stop a pre-existing server.
  node --input-type=module - "$project_dir/dist/cu-wiki-local-search.user.js" \
    "$server_host" "$server_port" <<'NODE' &
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const [path, host, port] = process.argv.slice(2);
createServer(async (request, response) => {
  if (request.method !== 'GET' || request.url?.split('?')[0] !== '/cu-wiki-local-search.user.js') {
    response.writeHead(404).end();
    return;
  }
  try {
    const source = await readFile(path);
    response.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(source);
  } catch {
    response.writeHead(500).end();
  }
}).listen(Number(port), host);
NODE
  server_pid=$!
  echo "已启动临时安装服务：$server_url（PID $server_pid，退出时清理）"
  for _ in {1..50}; do
    if ! kill -0 "$server_pid" 2>/dev/null; then
      echo "临时安装服务启动失败：$server_url" >&2
      exit 1
    fi
    if curl --connect-timeout 3 --max-time 15 --fail --silent --show-error \
      "$server_url" --output "$served_file" 2>/dev/null; then
      break
    fi
    sleep 0.1
  done
fi

if [[ ! -s "$served_file" ]]; then
  echo "开发服务未能提供 userscript 构建产物：$server_url" >&2
  exit 1
fi
if ! cmp --silent "$served_file" "$project_dir/dist/cu-wiki-local-search.user.js"; then
  echo "开发服务返回内容不是当前 dist/cu-wiki-local-search.user.js：$server_url" >&2
  exit 1
fi

node - "$project_dir/scripts/install-userscript.playwright.js" \
  "$playwright_script" "$server_url" <<'NODE'
const fs = require('node:fs');
const [sourcePath, outputPath, userscriptUrl] = process.argv.slice(2);
const source = fs.readFileSync(sourcePath, 'utf8');
fs.writeFileSync(
  outputPath,
  `async page => (\n${source}\n)(page, ${JSON.stringify(userscriptUrl)})\n`,
);
NODE
bash "$project_dir/scripts/run-browser-playwright.sh" \
  "$playwright_script"
