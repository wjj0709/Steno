/**
 * @file 大纲跳转定位测试
 *
 * 回归问题：粘贴含标题的 Markdown 后，插入块的 startLine 是相对"粘贴文本"的局部行号，
 * 与全局文档行号失配，导致基于 startLine 的 scrollToLine 把标题大纲项定位到错误的块。
 *
 * 修复：editor-bridge 新增 scrollToHeadingIndex(index)，按"文档内第 index 个 heading"
 * 定位（大纲项与文档 heading 严格一一对应），不依赖易失效的 startLine。本测试验证
 * 在"非空文档粘贴标题"这一会令 startLine 局部化的场景下，按序定位仍然正确。
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TextSelection } from 'prosemirror-state';
import { Slice } from 'prosemirror-model';

import { createEditorBridge, type EditorBridge } from '../view';

/** 伪粘贴事件（仅纯文本），绕开 jsdom 不支持的 ClipboardEvent/DataTransfer。 */
function fakePaste(text: string): ClipboardEvent {
  return {
    clipboardData: { files: [] as unknown as FileList, getData: (t: string) => (t === 'text/plain' ? text : '') },
    preventDefault: () => {}
  } as unknown as ClipboardEvent;
}

let origRAF: typeof globalThis.requestAnimationFrame;
let origScrollIntoView: typeof Element.prototype.scrollIntoView;
const scrolled: Element[] = [];

beforeEach(() => {
  origRAF = globalThis.requestAnimationFrame;
  // rAF 同步执行：paste 插件用 rAF 延迟 dispatch
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  };
  origScrollIntoView = Element.prototype.scrollIntoView;
  scrolled.length = 0;
  Element.prototype.scrollIntoView = function scrollIntoViewMock(this: Element) {
    scrolled.push(this);
  };
});

afterEach(() => {
  globalThis.requestAnimationFrame = origRAF;
  Element.prototype.scrollIntoView = origScrollIntoView;
});

/** 最近一次被滚动元素所属的标题文本。 */
function lastScrolledHeadingText(): string {
  const el = scrolled.at(-1);
  const heading = el?.closest('h1,h2,h3,h4,h5,h6');
  return heading?.textContent ?? '';
}

describe('scrollToHeadingIndex — 大纲按序定位（不受 startLine 局部化影响）', () => {
  function mountBridge(initialValue: string): { bridge: EditorBridge; place: HTMLElement } {
    const place = document.createElement('div');
    document.body.appendChild(place);
    const bridge = createEditorBridge({ mount: place, initialValue });
    return { bridge, place };
  }

  it('非空文档末尾粘贴标题后，按索引定位到正确的标题', () => {
    const { bridge } = mountBridge('已有第一行\n\n已有第二行');
    // 光标移到文末再粘贴 —— 复现 startLine 局部化场景
    bridge.view.dispatch(bridge.view.state.tr.setSelection(TextSelection.atEnd(bridge.view.state.doc)));
    bridge.view.someProp('handlePaste', f => f(bridge.view, fakePaste('# 标题A\n\n## 标题B\n\n正文XYZ'), Slice.empty));

    // 文档现有两个标题：标题A（index 0）、标题B（index 1）
    scrolled.length = 0;
    bridge.scrollToHeadingIndex(0);
    expect(lastScrolledHeadingText()).toContain('标题A');

    scrolled.length = 0;
    bridge.scrollToHeadingIndex(1);
    expect(lastScrolledHeadingText()).toContain('标题B');

    bridge.destroy();
  });

  it('索引越界时不滚动（不抛错）', () => {
    const { bridge } = mountBridge('# 仅一个标题\n\n正文');
    scrolled.length = 0;
    bridge.scrollToHeadingIndex(5);
    expect(scrolled.length).toBe(0);
    bridge.destroy();
  });
});
