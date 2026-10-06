// SPDX-License-Identifier: MPL-2.0
/// <reference types="node" />
// @vitest-environment node
import { execFile } from 'node:child_process';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const temporary: string[] = [];
const source = resolve('scripts');

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'cu-browser-test-'));
  temporary.push(root);
  return root;
}

async function listen(body = '{}') {
  const server = createServer((_request, response) => response.end(body));
  await new Promise<void>((accept) => server.listen(0, '127.0.0.1', accept));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  return {
    port: address.port,
    close: () => new Promise<void>((accept) => server.close(() => accept())),
  };
}

// These contracts exercise the Bash entrypoints with local stub commands, never a real browser.
describe.skipIf(process.platform === 'win32')(
  'browser environment commands',
  () => {
    it('passes a spaced executable/profile as single arguments and refuses an occupied port', async () => {
      const root = await workspace();
      const binary = join(root, 'fake chrome');
      await writeFile(
        binary,
        `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));`,
        { mode: 0o700 },
      );
      const free = await listen();
      await free.close();
      const env = {
        ...process.env,
        CU_WIKI_BROWSER_PATH: binary,
        CU_WIKI_BROWSER_PROFILE: join(root, 'private profile'),
        CU_WIKI_CDP_PORT: String(free.port),
      };
      const result = await exec(
        process.execPath,
        [join(source, 'start-browser.mjs')],
        { env },
      );
      const args: string[] = JSON.parse(
        result.stdout.split('\n').find((line) => line.startsWith('['))!,
      );
      expect(args).toContain(`--user-data-dir=${env.CU_WIKI_BROWSER_PROFILE}`);
      expect(args).toContain('--remote-debugging-address=127.0.0.1');
      expect(
        args.some((arg) =>
          /disable-background|disable-renderer|no-sandbox/.test(arg),
        ),
      ).toBe(false);
      const occupied = await listen();
      try {
        await expect(
          exec(process.execPath, [join(source, 'start-browser.mjs')], {
            env: { ...env, CU_WIKI_CDP_PORT: String(occupied.port) },
          }),
        ).rejects.toMatchObject({
          code: 1,
          stderr: expect.stringContaining('EADDRINUSE'),
        });
      } finally {
        await occupied.close();
      }
      await expect(
        exec(process.execPath, [join(source, 'start-browser.mjs')], {
          env: { ...env, CU_WIKI_CDP_PORT: 'invalid' },
        }),
      ).rejects.toMatchObject({ code: 1 });
      await expect(
        exec(process.execPath, [join(source, 'start-browser.mjs')], {
          env: {
            ...env,
            CU_WIKI_BROWSER_PROFILE: join(source, 'unsafe-profile'),
          },
        }),
      ).rejects.toMatchObject({ code: 1 });
      await expect(
        exec(process.execPath, [join(source, 'start-browser.mjs')], {
          env: { ...env, CU_WIKI_BROWSER_PROFILE: resolve('..unsafe-profile') },
        }),
      ).rejects.toMatchObject({ code: 1 });
      await symlink(
        'test-host-12345',
        join(env.CU_WIKI_BROWSER_PROFILE, 'SingletonLock'),
      );
      await expect(
        exec(process.execPath, [join(source, 'start-browser.mjs')], { env }),
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('SingletonLock'),
      });
    });

    it.each([
      [false, false],
      [true, false],
      [false, true],
    ])(
      'cleans only its own server after run-code failure (existing: %s, printed error: %s)',
      async (existing, printedError) => {
        const root = await workspace();
        const scripts = join(root, 'scripts');
        const bin = join(root, 'bin');
        await Promise.all([
          mkdir(scripts),
          mkdir(bin),
          mkdir(join(root, 'dist')),
        ]);
        for (const file of [
          'install-userscript.sh',
          'run-browser-playwright.sh',
          'install-userscript.playwright.js',
        ]) {
          await copyFile(join(source, file), join(scripts, file));
        }
        const build = '// @version 0.3.5\n// CU_WIKI_BUILD_ID:fixture\n';
        await writeFile(join(root, 'dist/cu-wiki-local-search.user.js'), build);
        await writeFile(join(bin, 'npm'), '#!/bin/sh\nexit 0\n', {
          mode: 0o700,
        });
        await writeFile(
          join(bin, 'playwright-cli'),
          `#!${process.execPath}
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.CALL_LOG, JSON.stringify(process.argv.slice(2))+'\\n');
if (process.argv.includes('run-code')) {
  if (process.env.PRINTED_ERROR === 'true') console.log('### Error\\nError: fixture');
  else process.exit(17);
}
`,
          { mode: 0o700 },
        );
        const cdp = await listen();
        const served = await listen(build);
        if (!existing) await served.close();
        const log = join(root, 'calls.jsonl');
        try {
          await expect(
            exec('bash', [join(scripts, 'install-userscript.sh')], {
              env: {
                ...process.env,
                PATH: `${bin}:${process.env.PATH}`,
                CALL_LOG: log,
                PRINTED_ERROR: String(printedError),
                CU_WIKI_DEV_SERVER_HOST: '127.0.0.1',
                CU_WIKI_DEV_SERVER_PORT: String(served.port),
                CU_WIKI_USERSCRIPT_URL: '',
                CU_WIKI_PLAYWRIGHT_SESSION: 'fixture',
                CU_WIKI_CDP_ENDPOINT: `http://127.0.0.1:${cdp.port}`,
              },
              timeout: 10000,
            }),
          ).rejects.toMatchObject({ code: printedError ? 1 : 17 });
          const calls: string[][] = (await readFile(log, 'utf8'))
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));
          expect(calls.map((args) => args[1])).toEqual([
            'detach',
            'attach',
            'run-code',
            'detach',
          ]);
          expect(calls.flat()).not.toContain('close');
          if (existing)
            expect(
              await (await fetch(`http://127.0.0.1:${served.port}`)).text(),
            ).toBe(build);
          else
            await expect(
              fetch(`http://127.0.0.1:${served.port}`),
            ).rejects.toThrow();
        } finally {
          await cdp.close();
          if (existing) await served.close();
        }
      },
    );
  },
);
