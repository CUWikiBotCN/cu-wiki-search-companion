// SPDX-License-Identifier: MPL-2.0
// @vitest-environment jsdom

import { insertAtEditorSelection } from '../../src/editor';
import { SearchPanel, type SearchPanelCallbacks } from '../../src/ui/search-panel';

afterEach(() => {
  document.querySelectorAll('#cu-wiki-search-host').forEach((host) => host.remove());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

const result = { id: 1, title: '页面', namespace: 0, namespaceName: '', score: 1 };

function mountPanel() {
  const callbacks: SearchPanelCallbacks = {
    prepareSearch: vi.fn(), prepareFiles: vi.fn(),
    search: () => [result], searchFiles: () => [], searchLua: () => [],
    searchContent: () => [], searchCodes: () => [],
    insert: () => { insertAtEditorSelection('[[页面]]'); },
    copyTitle: vi.fn(), copy: vi.fn(), copyCode: vi.fn(),
    open: vi.fn(), openCode: vi.fn(), refresh: vi.fn(), refreshFiles: vi.fn(),
    saveDataCodeRules: async () => undefined, saveHighlightPreferences: vi.fn(),
  };
  const panel = new SearchPanel(callbacks);
  const root = document.querySelector('#cu-wiki-search-host')!.shadowRoot!;
  return { panel, root };
}

function altK() {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', altKey: true }));
}

describe('search panel editor focus integration', () => {
  it.each(['Alt+K', 'Escape', 'close', 'insert-button', 'insert-keyboard'])(
    'preserves the CodeMirror selection through %s', (action) => {
      document.body.innerHTML = '<textarea id="wpTextbox1">前中后</textarea>' +
        '<div class="CodeMirror"><div tabindex="0"></div></div>';
      const textarea = document.querySelector<HTMLTextAreaElement>('#wpTextbox1')!;
      const wrapper = document.querySelector<HTMLElement>('.CodeMirror')!;
      const input = wrapper.firstElementChild as HTMLElement;
      const nativeFocus = input.focus.bind(input);
      // Model the observed Firefox failure: raw DOM focus loses the editor selection.
      vi.spyOn(input, 'focus').mockImplementation(() => {
        textarea.setSelectionRange(0, 0);
        nativeFocus();
      });
      Object.assign(wrapper, { CodeMirror: {
        getTextArea: () => textarea,
        focus: nativeFocus,
        operation: (callback: () => void) => callback(),
        replaceSelection: (text: string) => textarea.setRangeText(
          text, textarea.selectionStart, textarea.selectionEnd, 'end',
        ),
      } });
      const { panel, root } = mountPanel();
      nativeFocus();
      textarea.setSelectionRange(1, 2);
      altK();
      root.querySelector<HTMLInputElement>('.query')!.value = '页面';
      panel.refreshResults();

      if (action === 'Alt+K') altK();
      else if (action === 'close') root.querySelector<HTMLButtonElement>('.close')!.click();
      else if (action === 'insert-button') {
        root.querySelector<HTMLButtonElement>('.insert-result')!.click();
      } else {
        root.querySelector('.query')!.dispatchEvent(new KeyboardEvent('keydown', {
          key: action === 'Escape' ? 'Escape' : 'Enter',
          shiftKey: action === 'insert-keyboard', bubbles: true,
        }));
      }

      expect(root.querySelector<HTMLElement>('.panel')!.hidden).toBe(true);
      expect(document.activeElement).toBe(input);
      const inserted = action.startsWith('insert');
      expect(textarea.value).toBe(inserted ? '前[[页面]]后' : '前中后');
      expect([textarea.selectionStart, textarea.selectionEnd]).toEqual(
        inserted ? [7, 7] : [1, 2],
      );
    },
  );

  it.each(['textarea', 'button', 'removed', 'disabled'])(
    'restores a %s target or falls back to the search toggle', (kind) => {
      const { root } = mountPanel();
      const target = document.createElement(kind === 'textarea' ? 'textarea' : 'button');
      if (target instanceof HTMLTextAreaElement) {
        target.value = '前中后';
        target.setSelectionRange(1, 2);
      }
      document.body.append(target);
      target.focus();
      altK();
      if (kind === 'removed') target.remove();
      if (kind === 'disabled') target.disabled = true;
      altK();

      if (kind === 'removed' || kind === 'disabled') {
        expect(root.activeElement).toBe(root.querySelector('.toggle'));
      } else {
        expect(document.activeElement).toBe(target);
        if (target instanceof HTMLTextAreaElement) {
          expect([target.selectionStart, target.selectionEnd]).toEqual([1, 2]);
        }
      }
    },
  );
});
