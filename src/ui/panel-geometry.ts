// SPDX-License-Identifier: MPL-2.0
/** Owns floating-panel geometry and every browser task/listener used to maintain it. */
export class PanelGeometry {
  private destroyed = false;
  private positioned = false;
  private drag?: {
    pointerId: number;
    startX: number;
    startY: number;
    startLeft: number;
    startTop: number;
    wasPositioned: boolean;
  };
  private resizeObserver?: ResizeObserver;
  private layoutFrame?: number;
  private readonly scrollFrames = new Set<number>();
  private readonly handleViewportResize = (): void => {
    this.syncViewportBounds();
    this.scheduleLayoutUpdate();
  };
  private readonly endDrag = (event: PointerEvent): void => {
    if (event.pointerId === this.drag?.pointerId) this.finishDrag(event.type === 'pointercancel');
  };

  constructor(
    private readonly host: HTMLElement,
    private readonly panel: HTMLElement,
    private readonly panelBody: HTMLElement,
    private readonly dragHandle: HTMLElement,
    private readonly onLayout: () => void,
  ) {
    this.syncViewportBounds();
    window.addEventListener('resize', this.handleViewportResize);
    window.visualViewport?.addEventListener('resize', this.handleViewportResize);
    this.dragHandle.addEventListener('keydown', this.handleDragHandleKeydown);
    this.dragHandle.addEventListener('pointerdown', this.startDrag);
    this.dragHandle.addEventListener('pointermove', this.moveDrag);
    this.dragHandle.addEventListener('pointerup', this.endDrag);
    this.dragHandle.addEventListener('pointercancel', this.endDrag);
    if (typeof ResizeObserver === 'function') {
      this.resizeObserver = new ResizeObserver(() => this.scheduleLayoutUpdate());
      this.resizeObserver.observe(this.panel);
    }
  }

  scheduleLayoutUpdate(): void {
    if (this.destroyed) return;
    if (this.layoutFrame !== undefined) window.cancelAnimationFrame(this.layoutFrame);
    this.layoutFrame = window.requestAnimationFrame(() => {
      this.layoutFrame = undefined;
      if (!this.host.isConnected || this.panel.hidden || this.destroyed) return;
      this.reclampPosition();
      this.onLayout();
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    window.removeEventListener('resize', this.handleViewportResize);
    window.visualViewport?.removeEventListener('resize', this.handleViewportResize);
    this.dragHandle.removeEventListener('keydown', this.handleDragHandleKeydown);
    this.dragHandle.removeEventListener('pointerdown', this.startDrag);
    this.dragHandle.removeEventListener('pointermove', this.moveDrag);
    this.dragHandle.removeEventListener('pointerup', this.endDrag);
    this.dragHandle.removeEventListener('pointercancel', this.endDrag);
    this.resizeObserver?.disconnect();
    if (this.layoutFrame !== undefined) window.cancelAnimationFrame(this.layoutFrame);
    this.layoutFrame = undefined;
    for (const frame of this.scrollFrames) window.cancelAnimationFrame(frame);
    this.scrollFrames.clear();
    this.finishDrag(false);
  }

  private readonly handleDragHandleKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && this.drag) {
      event.preventDefault();
      event.stopPropagation();
      this.finishDrag(true);
      return;
    }
    if (this.viewportBounds().width <= 640 || !event.key.startsWith('Arrow')) return;
    const directions: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const direction = directions[event.key];
    if (!direction) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = this.panel.getBoundingClientRect();
    const step = event.shiftKey ? 1 : 10;
    this.positionPanel(rect.left + direction[0] * step, rect.top + direction[1] * step);
  };

  private readonly startDrag = (event: PointerEvent): void => {
    if (
      event.button !== 0 ||
      this.viewportBounds().width <= 640 ||
      typeof window.matchMedia !== 'function' ||
      !window.matchMedia('(pointer: fine)').matches
    ) {
      return;
    }
    event.preventDefault();
    const rect = this.panel.getBoundingClientRect();
    this.drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startLeft: rect.left,
      startTop: rect.top,
      wasPositioned: this.positioned,
    };
    this.panel.dataset.dragging = 'true';
    this.dragHandle.setPointerCapture(event.pointerId);
  };

  private readonly moveDrag = (event: PointerEvent): void => {
    if (event.pointerId !== this.drag?.pointerId) return;
    event.preventDefault();
    this.positionPanel(
      this.drag.startLeft + event.clientX - this.drag.startX,
      this.drag.startTop + event.clientY - this.drag.startY,
    );
  };

  finishDrag(cancel: boolean): boolean {
    const drag = this.drag;
    if (!drag) return false;
    this.drag = undefined;
    delete this.panel.dataset.dragging;
    if (this.dragHandle.hasPointerCapture(drag.pointerId)) {
      this.dragHandle.releasePointerCapture(drag.pointerId);
    }
    if (cancel) {
      if (drag.wasPositioned) this.positionPanel(drag.startLeft, drag.startTop);
      else this.resetPosition();
    }
    return true;
  }

  private positionPanel(left: number, top: number): void {
    const rect = this.panel.getBoundingClientRect();
    const viewport = this.viewportBounds();
    const margin = 12;
    const maxLeft = Math.max(margin, viewport.width - rect.width - margin);
    const maxTop = Math.max(margin, viewport.height - rect.height - margin);
    this.panel.style.left = `${Math.min(Math.max(left, margin), maxLeft)}px`;
    this.panel.style.top = `${Math.min(Math.max(top, margin), maxTop)}px`;
    this.panel.style.right = 'auto';
    this.panel.style.bottom = 'auto';
    this.panel.dataset.positioned = 'true';
    this.positioned = true;
  }

  private reclampPosition(): void {
    if (!this.positioned || this.viewportBounds().width <= 640) return;
    const rect = this.panel.getBoundingClientRect();
    this.positionPanel(rect.left, rect.top);
  }

  private viewportBounds(): { width: number; height: number } {
    const layoutWidth = document.documentElement.clientWidth || window.innerWidth;
    const layoutHeight = document.documentElement.clientHeight || window.innerHeight;
    return {
      width: Math.min(layoutWidth, window.visualViewport?.width ?? layoutWidth),
      height: Math.min(layoutHeight, window.visualViewport?.height ?? layoutHeight),
    };
  }

  private syncViewportBounds(): void {
    const { width, height } = this.viewportBounds();
    this.host.style.setProperty('--cu-panel-fluid-width', `${width * 0.36}px`);
    this.host.style.setProperty('--cu-panel-max-width', `${Math.max(0, width - 24)}px`);
    this.host.style.setProperty('--cu-panel-max-height', `${Math.max(0, height - 84)}px`);
    this.host.style.setProperty('--cu-panel-mobile-max-height', `${Math.max(0, height - 80)}px`);
    this.host.toggleAttribute('data-narrow', width <= 640);
  }

  resetPosition(): void {
    this.panel.style.removeProperty('left');
    this.panel.style.removeProperty('top');
    this.panel.style.removeProperty('right');
    this.panel.style.removeProperty('bottom');
    delete this.panel.dataset.positioned;
    this.positioned = false;
  }

  scheduleBodyScroll(element: HTMLElement, block: 'nearest' | 'start'): void {
    if (this.destroyed) return;
    const frame = window.requestAnimationFrame(() => {
      this.scrollFrames.delete(frame);
      if (!this.destroyed && element.isConnected && !element.hidden) this.scrollBodyTo(element, block);
    });
    this.scrollFrames.add(frame);
  }

  scrollBodyTo(element: HTMLElement, block: 'nearest' | 'start'): void {
    const bodyRect = this.panelBody.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    if (block === 'start' || elementRect.top < bodyRect.top) {
      this.panelBody.scrollTop += elementRect.top - bodyRect.top;
    } else if (elementRect.bottom > bodyRect.bottom) {
      this.panelBody.scrollTop += elementRect.bottom - bodyRect.bottom;
    }
  }
}
