// SPDX-License-Identifier: MPL-2.0
// Run before background acceptance; do not emulate visibility or alter timers.
async page => {
  const context = page.context();
  const owned = [];
  const sessions = [];
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  try {
    for (let i = 0; i < 2; i++) {
      const tab = await context.newPage();
      owned.push(tab);
      await tab.setContent('<title>Browser lifecycle probe</title><input aria-label="probe">');
      sessions.push(await context.newCDPSession(tab));
      await tab.evaluate(() => {
        window.__lifecycleProbe = { ticks: 0, frames: 0, events: [] };
        document.addEventListener('visibilitychange', () => {
          window.__lifecycleProbe.events.push({ at: Date.now(), visibility: document.visibilityState });
        });
        setInterval(() => window.__lifecycleProbe.ticks++, 100);
        const frame = () => { window.__lifecycleProbe.frames++; requestAnimationFrame(frame); };
        requestAnimationFrame(frame);
      });
    }
    const windows = [];
    for (const session of sessions) windows.push(await session.send('Browser.getWindowForTarget'));
    check(windows[0].windowId === windows[1].windowId, '两页属于不同窗口，不能作为多标签验收');
    const read = () => Promise.all(owned.map(tab => tab.evaluate(() => ({
      visibility: document.visibilityState, focus: document.hasFocus(), ...window.__lifecycleProbe,
    }))));
    const phases = [];
    for (let active = 0; active < 2; active++) {
      const background = 1 - active;
      await owned[active].bringToFront();
      await owned[active].locator('input').focus();
      await owned[active].waitForTimeout(100);
      const before = await read();
      await owned[active].waitForTimeout(2200);
      const after = await read();
      check(after[active].visibility === 'visible' && after[active].focus &&
        after[background].visibility === 'hidden' && !after[background].focus,
      '实际可见性/焦点不符；检查启动参数、CDP 默认覆盖及前台窗口');
      const delta = after.map((row, index) => ({
        ticks: row.ticks - before[index].ticks, frames: row.frames - before[index].frames,
      }));
      check(delta[active].frames > 0 && delta[background].frames <= 1,
        '没有观察到后台动画帧暂停，不能继续后台验收');
      check(delta[background].ticks < delta[active].ticks,
        '没有观察到后台定时器限速；保留未验证，不推定自然后台行为');
      phases.push({ active, before, after, delta });
    }
    return { passed: true, windowId: windows[0].windowId, phases };
  } finally {
    for (const session of sessions) await session.detach().catch(() => undefined);
    for (const tab of owned) if (!tab.isClosed()) await tab.close();
    if (!page.isClosed()) await page.bringToFront();
  }
}
