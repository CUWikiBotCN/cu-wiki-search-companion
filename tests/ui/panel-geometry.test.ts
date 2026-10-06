// SPDX-License-Identifier: MPL-2.0
// @vitest-environment jsdom
import { PanelGeometry } from '../../src/ui/panel-geometry';

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('keeps layout and scroll tasks independent and disposes every task and listener', () => {
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  const cancel = vi
    .spyOn(window, 'cancelAnimationFrame')
    .mockImplementation((id) => {
      frames.delete(id);
    });
  const disconnect = vi.fn();
  let resize!: ResizeObserverCallback;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        resize = callback;
      }
      observe = vi.fn();
      disconnect = disconnect;
    },
  );
  const viewport = new EventTarget();
  vi.stubGlobal('visualViewport', viewport);
  const host = document.createElement('div');
  host.innerHTML =
    '<section><header></header><div><article></article><aside></aside></div></section>';
  document.body.append(host);
  const panel = host.querySelector('section')!;
  const handle = host.querySelector('header')!;
  const body = host.querySelector('div')!;
  const first = host.querySelector('article')!;
  const second = host.querySelector('aside')!;
  const onLayout = vi.fn();
  const geometry = new PanelGeometry(
    host,
    panel,
    handle,
    body,
    handle,
    onLayout,
  );
  geometry.scheduleLayoutUpdate();
  geometry.scheduleBodyScroll(first, 'start');
  geometry.scheduleBodyScroll(second, 'nearest');
  window.dispatchEvent(new Event('resize'));
  expect(frames.size).toBe(3);

  const pendingFrames = [...frames.values()];
  const readRect = vi.spyOn(body, 'getBoundingClientRect');
  const pendingIds = [...frames.keys()];
  geometry.destroy();
  geometry.destroy();
  expect(disconnect).toHaveBeenCalledOnce();
  expect(frames.size).toBe(0);
  for (const id of pendingIds) expect(cancel).toHaveBeenCalledWith(id);
  const writeStyle = vi.spyOn(host.style, 'setProperty');
  window.dispatchEvent(new Event('resize'));
  viewport.dispatchEvent(new Event('resize'));
  handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
  resize([], {} as ResizeObserver);
  geometry.scheduleBodyScroll(first, 'start');
  for (const callback of pendingFrames) callback(0);
  expect(frames.size).toBe(0);
  expect(writeStyle).not.toHaveBeenCalled();
  expect(panel.style.left).toBe('');
  expect(onLayout).not.toHaveBeenCalled();
  expect(readRect).not.toHaveBeenCalled();
});

it('keeps the closed launcher clear of late, resized and replaced docks without moving the panel', async () => {
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.set(++id, callback);
    return id;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((key) => {
    frames.delete(key);
  });
  const flush = async () => {
    await Promise.resolve();
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(0));
  };
  let resize!: ResizeObserverCallback;
  const unobserve = vi.fn();
  const disconnect = vi.fn();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        resize = callback;
      }
      observe = vi.fn();
      unobserve = unobserve;
      disconnect = disconnect;
    },
  );
  const host = document.createElement('div');
  host.innerHTML =
    '<button></button><section hidden><header></header><main></main></section>';
  document.body.append(host);
  const panel = host.querySelector('section')!;
  const launcher = host.querySelector('button')!;
  vi.spyOn(launcher, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, 0, 88, 40),
  );
  const onLayout = vi.fn();
  const geometry = new PanelGeometry(
    host,
    panel,
    launcher,
    host.querySelector('main')!,
    host.querySelector('header')!,
    onLayout,
  );
  expect(host.style.getPropertyValue('--cu-launcher-right')).toBe('12px');
  const dock = document.createElement('div');
  dock.className = 'skin-dock';
  let dockWidth = 60;
  vi.spyOn(dock, 'getBoundingClientRect').mockImplementation(
    () => new DOMRect(window.innerWidth - 12 - dockWidth, 600, dockWidth, 96),
  );
  document.body.append(dock);
  await flush();
  expect(host.style.getPropertyValue('--cu-launcher-right')).toBe('84px');
  dockWidth = 38;
  resize([], {} as ResizeObserver);
  await flush();
  expect(host.style.getPropertyValue('--cu-launcher-right')).toBe('62px');
  dock.style.visibility = 'hidden';
  await flush();
  expect(host.style.getPropertyValue('--cu-launcher-right')).toBe('12px');
  dock.remove();
  await flush();
  expect(unobserve).toHaveBeenCalledWith(dock);
  document.body.append(dock);
  dock.style.visibility = '';
  await flush();
  expect(host.style.getPropertyValue('--cu-launcher-right')).toBe('62px');
  expect(panel.style.cssText).toBe('');
  expect(onLayout).not.toHaveBeenCalled();
  const replacement = document.createElement('div');
  replacement.className = 'skin-dock';
  vi.spyOn(replacement, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(window.innerWidth - 92, 600, 80, 96),
  );
  dock.replaceWith(replacement);
  await flush();
  expect(unobserve).toHaveBeenLastCalledWith(dock);
  expect(host.style.getPropertyValue('--cu-launcher-right')).toBe('104px');
  resize([], {} as ResizeObserver);
  geometry.destroy();
  expect(disconnect).toHaveBeenCalledOnce();
  expect(frames.size).toBe(0);
  const writes = vi.spyOn(host.style, 'setProperty');
  dock.style.visibility = 'hidden';
  resize([], {} as ResizeObserver);
  await flush();
  expect(writes).not.toHaveBeenCalled();
});
