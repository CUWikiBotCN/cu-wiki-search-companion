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
  const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => { frames.delete(id); });
  const disconnect = vi.fn();
  let resize!: ResizeObserverCallback;
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { resize = callback; }
    observe = vi.fn();
    disconnect = disconnect;
  });
  const viewport = new EventTarget();
  vi.stubGlobal('visualViewport', viewport);
  const host = document.createElement('div');
  host.innerHTML = '<section><header></header><div><article></article><aside></aside></div></section>';
  document.body.append(host);
  const panel = host.querySelector('section')!;
  const handle = host.querySelector('header')!;
  const body = host.querySelector('div')!;
  const first = host.querySelector('article')!;
  const second = host.querySelector('aside')!;
  const onLayout = vi.fn();
  const geometry = new PanelGeometry(host, panel, body, handle, onLayout);
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
