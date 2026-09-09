// SPDX-License-Identifier: MPL-2.0
/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

it.each([true, false])('handles an interrupted bridge navigation without accepting a missing confirmation (ask: %s)', async confirmation => {
  const source = readFileSync('scripts/install-userscript.playwright.js', 'utf8');
  const install = runInNewContext(`(${source})`);
  const created: ReturnType<typeof tab>[] = [];
  const original = tab('about:blank');
  const click = vi.fn();
  const control = { getAttribute: async () => '重新安装', evaluate: click };
  function tab(url: string) {
    let closed = false;
    return {
      url: () => url,
      isClosed: () => closed,
      close: vi.fn(async () => { closed = true; }),
      bringToFront: async () => undefined,
      goto: vi.fn(async (target: string) => {
        url = target;
        if (target.includes('.user.js')) {
          if (confirmation) created.push(tab('chrome-extension://fixture/ask.html?aid=owned'));
          throw new Error('page.goto: net::ERR_NETWORK_CHANGED');
        }
      }),
      waitForTimeout: async () => undefined,
      waitForSelector: async () => undefined,
      locator: () => ({ count: async () => 1, nth: () => control }),
      reload: async () => undefined,
      waitForFunction: vi.fn(async () => undefined),
      evaluate: async () => undefined,
    };
  }
  const context = {
    pages: () => [original, ...created.filter(page => !page.isClosed())],
    newPage: async () => { const page = tab('about:blank'); created.push(page); return page; },
    request: { get: async () => ({ ok: () => true, text: async () => '// @version 0.3.5\n// CU_WIKI_BUILD_ID:fixture' }) },
  };
  const attempt = install({ ...original, context: () => context });
  if (confirmation) {
    await expect(attempt).resolves.toMatchObject({ installed: true });
    expect(click).toHaveBeenCalledOnce();
    expect(created[0]?.waitForFunction).toHaveBeenCalledWith(expect.any(Function), { version: '0.3.5', buildId: 'CU_WIKI_BUILD_ID:fixture' }, { timeout: 60000 });
  } else {
    await expect(attempt).rejects.toThrow('ERR_NETWORK_CHANGED');
    expect(click).not.toHaveBeenCalled();
  }
  expect(original.close).not.toHaveBeenCalled();
  expect(created.every(page => page.isClosed())).toBe(true);
});
