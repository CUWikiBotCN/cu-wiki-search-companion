// SPDX-License-Identifier: MPL-2.0
// @vitest-environment jsdom

import {
  insertAtEditorSelection,
  wikiLink,
  sectionWikiLink,
} from '../src/editor';

describe('editor integration', () => {
  beforeEach(() => {
    document.body.innerHTML = '<textarea id="wpTextbox1">前后</textarea>';
  });

  it('creates a display-labelled wiki link from the query', () => {
    expect(wikiLink('12号鹿弹', '鹿弹')).toBe('[[12号鹿弹|鹿弹]]');
    expect(wikiLink('12号鹿弹', '12号鹿弹')).toBe('[[12号鹿弹]]');
  });

  it('creates ordinary links for Category and File namespaces', () => {
    expect(wikiLink('分类:武器', '武器', 14)).toBe('[[:分类:武器|武器]]');
    expect(wikiLink('文件:Item morphine.png', 'morphine', 6)).toBe(
      '[[:文件:Item morphine.png|morphine]]',
    );
  });

  it('constructs section targets from canonical names and escapes wikitext separately from URLs', () => {
    expect(sectionWikiLink('地形扫描仪', '你知道吗', '你知道吗')).toBe(
      '[[地形扫描仪#你知道吗|你知道吗]]',
    );
    expect(sectionWikiLink('分类:测试', 'A_&_B_%20_#问?', 'A & B', 14)).toBe(
      '[[:分类:测试#A_&#38;_B_%20_#问?|A &#38; B]]',
    );
    expect(sectionWikiLink('文件:示例', 'x]|{{模板}}', "''标签''", 6)).toBe(
      '[[:文件:示例#x&#93;&#124;&#123;&#123;模板&#125;&#125;|&#39;&#39;标签&#39;&#39;]]',
    );
  });

  it('inserts into a native textarea selection', () => {
    const textarea =
      document.querySelector<HTMLTextAreaElement>('#wpTextbox1')!;
    textarea.setSelectionRange(1, 1);

    expect(insertAtEditorSelection('[[鹿弹]]')).toBe('textarea');
    expect(textarea.value).toBe('前[[鹿弹]]后');
  });

  it('uses the active CodeMirror instance so insertion is undoable', () => {
    const textarea =
      document.querySelector<HTMLTextAreaElement>('#wpTextbox1')!;
    const replaceSelection = vi.fn();
    const codeMirror = document.createElement('div') as HTMLDivElement & {
      CodeMirror: unknown;
    };
    codeMirror.className = 'CodeMirror';
    codeMirror.CodeMirror = {
      getTextArea: () => textarea,
      replaceSelection,
      focus: vi.fn(),
      operation: (callback: () => void) => callback(),
    };
    document.body.append(codeMirror);

    expect(insertAtEditorSelection('[[鹿弹]]')).toBe('codemirror');
    expect(replaceSelection).toHaveBeenCalledWith('[[鹿弹]]', 'end', '+input');
  });
});

describe('delayed insertion guard', () => {
  it('detects native content and selection changes and editor replacement', async () => {
    const { captureEditorSelection } = await import('../src/editor');
    document.body.innerHTML = '<textarea id="wpTextbox1">原文</textarea>';
    const textarea =
      document.querySelector<HTMLTextAreaElement>('#wpTextbox1')!;
    const first = captureEditorSelection();
    expect(first.current()).toBe(true);
    textarea.value = '已改';
    expect(first.current()).toBe(false);
    first.dispose();
    const second = captureEditorSelection();
    textarea.setSelectionRange(0, 1);
    expect(second.current()).toBe(false);
    second.dispose();
    const third = captureEditorSelection();
    textarea.replaceWith(textarea.cloneNode(true));
    expect(third.current()).toBe(false);
    third.dispose();
  });

  it('uses CodeMirror state and detects edits even when undone before completion', async () => {
    const { captureEditorSelection } = await import('../src/editor');
    document.body.innerHTML =
      '<textarea id="wpTextbox1"></textarea><div class="CodeMirror"></div>';
    const listeners = new Map<string, () => void>();
    const host = document.querySelector('.CodeMirror') as HTMLElement & {
      CodeMirror: unknown;
    };
    let selection = [{ anchor: { line: 0, ch: 1 }, head: { line: 0, ch: 1 } }];
    host.CodeMirror = {
      getTextArea: () => document.querySelector('#wpTextbox1'),
      getValue: () => '原文',
      listSelections: () => selection,
      on: (event: string, fn: () => void) => listeners.set(event, fn),
      off: (event: string) => listeners.delete(event),
    };
    const first = captureEditorSelection();
    expect(first.current()).toBe(true);
    listeners.get('change')!();
    expect(first.current()).toBe(false);
    first.dispose();
    expect(listeners.size).toBe(0);
    const second = captureEditorSelection();
    selection = [{ anchor: { line: 0, ch: 0 }, head: { line: 0, ch: 1 } }];
    expect(second.current()).toBe(false);
    second.dispose();
  });
});
