// SPDX-License-Identifier: MPL-2.0
interface CodeMirrorEditor {
  focus(): void;
  getTextArea(): HTMLTextAreaElement;
  operation(callback: () => void): void;
  getValue?(): string;
  listSelections?(): unknown;
  on?(event: string, callback: () => void): void;
  off?(event: string, callback: () => void): void;
  replaceSelection(
    text: string,
    collapse?: 'around' | 'start' | 'end',
    origin?: string,
  ): void;
}

type CodeMirrorElement = HTMLElement & { CodeMirror?: CodeMirrorEditor };

/** Capture without moving focus; discard an async insertion after any editor change. */
export function captureEditorSelection(): {
  current(): boolean;
  dispose(): void;
} {
  const textarea = document.querySelector<HTMLTextAreaElement>('#wpTextbox1');
  const findEditor = () =>
    [...document.querySelectorAll<CodeMirrorElement>('.CodeMirror')]
      .map((element) => element.CodeMirror)
      .find((editor) => editor?.getTextArea() === textarea);
  const editor = findEditor();
  const readable = Boolean(
    textarea &&
    (!editor ||
      (editor.getValue && editor.listSelections && editor.on && editor.off)),
  );
  const snapshot = () =>
    editor
      ? JSON.stringify([editor.getValue?.(), editor.listSelections?.()])
      : JSON.stringify([
          textarea?.value,
          textarea?.selectionStart,
          textarea?.selectionEnd,
          textarea?.selectionDirection,
        ]);
  const initial = snapshot();
  let changed = false;
  const invalidate = () => {
    changed = true;
  };
  textarea?.addEventListener('input', invalidate);
  textarea?.addEventListener('select', invalidate);
  editor?.on?.('change', invalidate);
  editor?.on?.('cursorActivity', invalidate);
  return {
    current: () =>
      readable &&
      !changed &&
      Boolean(textarea?.isConnected) &&
      document.querySelector('#wpTextbox1') === textarea &&
      findEditor() === editor &&
      snapshot() === initial,
    dispose: () => {
      textarea?.removeEventListener('input', invalidate);
      textarea?.removeEventListener('select', invalidate);
      editor?.off?.('change', invalidate);
      editor?.off?.('cursorActivity', invalidate);
    },
  };
}

export function focusEditorElement(element: HTMLElement): void {
  const codeMirror =
    element.closest<CodeMirrorElement>('.CodeMirror')?.CodeMirror;
  // CodeMirror restores its native selection before focusing a contenteditable input.
  if (codeMirror) codeMirror.focus();
  else element.focus();
}

export function insertAtEditorSelection(
  text: string,
): 'codemirror' | 'textarea' {
  const textarea = document.querySelector<HTMLTextAreaElement>('#wpTextbox1');
  if (!textarea) throw new Error('未找到维基文本编辑器');

  const codeMirror = [
    ...document.querySelectorAll<CodeMirrorElement>('.CodeMirror'),
  ]
    .map((element) => element.CodeMirror)
    .find((editor) => editor?.getTextArea() === textarea);
  if (codeMirror) {
    codeMirror.operation(() =>
      codeMirror.replaceSelection(text, 'end', '+input'),
    );
    codeMirror.focus();
    return 'codemirror';
  }

  textarea.focus();
  const insertedWithUndo =
    document.execCommand?.('insertText', false, text) ?? false;
  if (!insertedWithUndo) {
    textarea.setRangeText(
      text,
      textarea.selectionStart,
      textarea.selectionEnd,
      'end',
    );
    textarea.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: text,
      }),
    );
  }
  return 'textarea';
}

export function wikiLink(
  title: string,
  query: string,
  namespace?: number,
): string {
  const label = query.trim();
  const target =
    namespace === 6 || namespace === 14 ? `:${title.replace(/^:/, '')}` : title;
  if (!label || label.toLocaleLowerCase() === title.toLocaleLowerCase()) {
    return `[[${target}]]`;
  }
  return `[[${target}|${label}]]`;
}

/** Section labels and fragments are data, never executable wikitext. */
export function sectionWikiLink(
  title: string,
  fragment: string | undefined,
  label: string,
  namespace?: number,
): string {
  if (!fragment) throw new Error('小节锚点尚未就绪');
  const escape = (value: string): string =>
    value.replace(
      /[&<>[\]|{}'\r\n]/g,
      (character) => `&#${character.charCodeAt(0)};`,
    );
  const target =
    namespace === 6 || namespace === 14 ? `:${title.replace(/^:/, '')}` : title;
  return `[[${escape(target)}#${escape(fragment)}|${escape(label)}]]`;
}
