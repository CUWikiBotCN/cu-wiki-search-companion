// SPDX-License-Identifier: MPL-2.0
import { spawn, execFileSync } from 'node:child_process';
import { lstat, mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const executable = process.env.CU_WIKI_BROWSER_PATH || 'google-chrome';
const profile = resolve(project, process.env.CU_WIKI_BROWSER_PROFILE || '.local/browser-profile');
const portText = process.env.CU_WIKI_CDP_PORT || '9222';

try {
  if (!/^[1-9]\d*$/.test(portText) || Number(portText) > 65535) {
    throw new Error('CU_WIKI_CDP_PORT 必须为 1–65535 的整数');
  }
  const withinProject = relative(project, profile);
  if (withinProject !== '..' && !withinProject.startsWith(`..${sep}`) && !isAbsolute(withinProject)) {
    // A profile contains credentials; refuse an accidentally public repository path.
    try {
      execFileSync('git', ['check-ignore', '--quiet', '--', profile], { cwd: project });
    } catch {
      throw new Error('仓库内的浏览器 profile 必须先加入 .gitignore');
    }
  }
  const lock = await lstat(resolve(profile, 'SingletonLock')).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (lock) throw new Error('profile 已占用或留有 SingletonLock；先核查原浏览器进程，不自动删除锁');
  // Refuse an occupied endpoint instead of silently attaching to another browser.
  await new Promise((accept, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(Number(portText), '127.0.0.1', () => probe.close(accept));
  });
  await mkdir(profile, { recursive: true, mode: 0o700 });
  const browser = spawn(executable, [
    `--user-data-dir=${profile}`,
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${portText}`,
    '--no-first-run', '--no-default-browser-check', 'about:blank',
  ], { stdio: 'inherit' });
  browser.once('spawn', () => {
    console.log(`浏览器 PID ${browser.pid}；profile：${profile}`);
    console.log(`CDP：http://127.0.0.1:${portText}；关闭该浏览器窗口结束，profile 保留。`);
  });
  browser.once('error', error => {
    console.error(`无法启动浏览器，请检查 CU_WIKI_BROWSER_PATH：${error.message}`);
    process.exitCode = 1;
  });
  browser.once('exit', code => { process.exitCode = code ?? 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => browser.kill(signal));
} catch (error) {
  console.error(`浏览器未启动：${error.message}`);
  process.exitCode = 1;
}
