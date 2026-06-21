/**
 * @file 即时渲染：语法标记显隐 + 行内代码盒子结构回归测试
 *
 * 锁定 bug #1/#3 的修复契约（参考 PureMark 对齐）：
 *  - 光标移开后，标题 `#`、行内代码反引号等语法标记会被打上 `.puremark-syntax-hidden` 装饰；
 *  - 行内代码的成对反引号 `<code>` 盒子嵌套在 `.steno-syntax` 内（供 editor-base.css 命中并透明化，
 *    避免渲染成"三块内容"），而代码内容的 `<code>` 不在 `.steno-syntax` 内（保留盒子样式）；
 *  - 一行多个行内代码时每个都正确渲染（不会因解析吞并而"部分失效"）。
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, afterEach } from 'vitest';
import { TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';

import { createEditor } from '../view/create-editor';

describe('即时渲染：语法标记显隐与行内代码盒子结构', () => {
  let view: EditorView | null = null;
  let mount: HTMLDivElement | null = null;

  afterEach(() => {
    view?.destroy();
    view = null;
    if (mount && mount.parentNode) mount.parentNode.removeChild(mount);
    mount = null;
  });

  function mountEditor(md: string): EditorView {
    mount = document.createElement('div');
    document.body.appendChild(mount);
    return createEditor({ mount, initialValue: md });
  }

  function moveCursorToEnd(v: EditorView): void {
    v.dispatch(v.state.tr.setSelection(TextSelection.atEnd(v.state.doc)));
  }

  it('光标移开后标题 # 被隐藏装饰命中', () => {
    view = mountEditor('# 标题一\n\n普通段落，把光标放这里');
    moveCursorToEnd(view);
    const dom = view.dom as HTMLElement;
    const hidden = Array.from(dom.querySelectorAll('.puremark-syntax-hidden'));
    // # 应被装饰隐藏
    expect(hidden.some(el => el.textContent === '#')).toBe(true);
  });

  it('行内代码：反引号 <code> 盒子在 .steno-syntax 内，内容 <code> 不在', () => {
    view = mountEditor('段落 `code` 结尾。\n\n第二段把光标放这里');
    moveCursorToEnd(view);
    const dom = view.dom as HTMLElement;
    const codeEls = Array.from(dom.querySelectorAll('code'));
    // 结构上仍是 3 个 <code>（开反引号 / 内容 / 闭反引号）
    expect(codeEls.length).toBe(3);

    const backtickCodes = codeEls.filter(c => c.textContent === '`');
    const contentCodes = codeEls.filter(c => c.textContent === 'code');
    expect(backtickCodes.length).toBe(2);
    expect(contentCodes.length).toBe(1);

    // 反引号盒子必须嵌套在 .steno-syntax 内（CSS 据此透明化，消除空盒子）
    for (const c of backtickCodes) {
      expect(c.closest('.steno-syntax')).not.toBeNull();
    }
    // 内容盒子不在 .steno-syntax 内（保留行内代码样式）
    expect(contentCodes[0].closest('.steno-syntax')).toBeNull();
  });

  it('一行多个行内代码：`a` 与 `b` 都渲染', () => {
    view = mountEditor('行内 `a` 与 `b` 两个代码。\n\n第二段把光标放这里');
    moveCursorToEnd(view);
    const dom = view.dom as HTMLElement;
    const contentTexts = Array.from(dom.querySelectorAll('code'))
      .map(c => c.textContent)
      .filter(t => t !== '`');
    expect(contentTexts).toContain('a');
    expect(contentTexts).toContain('b');
  });
});
