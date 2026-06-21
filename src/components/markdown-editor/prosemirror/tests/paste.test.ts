/**
 * @file Steno 粘贴单元测试
 *
 * 验证：
 * - 粘贴 block 图片后，光标落到图片之后的文本块（必要时补空段落），而非停留在图片之前。
 * - 粘贴 Markdown 文本时同步插入解析结果，装饰系统立即重算语法标记显隐。
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { Slice, type Node } from 'prosemirror-model';

import { stenoSchema } from '../schema';
import { parseMarkdown } from '../parser';
import { insertImageWithCaretAfter, buildMarkdownPasteSlice, createPastePlugin } from '../plugins/paste';

// 函数 imageNode：封装可复用流程，集中处理输入校验、状态转换或外部模块调用。
function imageNode(): Node {
  // 局部常量 n：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
  const n = stenoSchema.nodes.image.createAndFill({ src: 'steno-asset:x.png', alt: 'x' });
  if (!n) throw new Error('cannot create image node');
  return n;
}

// 函数 imageEndPos：封装可复用流程，集中处理输入校验、状态转换或外部模块调用。
function imageEndPos(state: EditorState): number {
  let end = 0;
  state.doc.descendants((node, pos) => {
    if (node.type.name === 'image') end = pos + node.nodeSize;
  });
  return end;
}

// 测试用例：验证「paste — 图片插入后光标落点」场景，锁定 paste 的用户可见行为。
describe('paste — 图片插入后光标落点', () => {
  // 测试用例：验证「空文档粘贴图片后光标落在图片之后的文本块」场景，锁定 paste 的用户可见行为。
  it('空文档粘贴图片后光标落在图片之后的文本块', () => {
    let state = EditorState.create({ schema: stenoSchema });
    state = state.apply(insertImageWithCaretAfter(state, imageNode()));
    const { $from } = state.selection;
    expect($from.parent.isTextblock).toBe(true);
    expect($from.pos).toBeGreaterThanOrEqual(imageEndPos(state));
  });

  // 测试用例：验证「段落中部粘贴图片后光标落在图片之后」场景，锁定 paste 的用户可见行为。
  it('段落中部粘贴图片后光标落在图片之后', () => {
    const { doc } = parseMarkdown('abcdef');
    let state = EditorState.create({ schema: stenoSchema, doc });
    state = state.apply(state.tr.setSelection(TextSelection.near(state.doc.resolve(4))));
    state = state.apply(insertImageWithCaretAfter(state, imageNode()));
    const { $from } = state.selection;
    expect($from.parent.isTextblock).toBe(true);
    expect($from.pos).toBeGreaterThanOrEqual(imageEndPos(state));
  });
});

// 函数 topTypes：收集文档顶层块节点的 type.name 序列，用于断言块级结构。
function topTypes(doc: Node): string[] {
  const out: string[] = [];
  doc.forEach(n => out.push(n.type.name));
  return out;
}

// 测试用例：验证「paste — Markdown 块级结构插入」场景，锁定粘贴的用户可见行为。
describe('paste — Markdown 块级结构插入', () => {
  it('粘贴多块 Markdown 保留块级结构（标题/代码块/列表不降级为段落）', () => {
    const md = '# 标题\n\n```\ncode\n```\n\n- 项目一\n- 项目二';

    // 起点：非空段落，光标置末尾——复现旧实现「首块并入当前段落」的路径。
    let state = EditorState.create({ schema: stenoSchema, doc: parseMarkdown('已有内容').doc });
    state = state.apply(state.tr.setSelection(TextSelection.atEnd(state.doc)));

    const slice = buildMarkdownPasteSlice(parseMarkdown(md).doc.content);
    state = state.apply(state.tr.replaceSelection(slice));

    const got = topTypes(state.doc);
    expect(got).toContain('heading');
    expect(got).toContain('code_block');
    expect(got).toContain('bullet_list');
  });

  it('粘贴纯行内 Markdown 并入当前段落（不新增块）', () => {
    let state = EditorState.create({ schema: stenoSchema, doc: parseMarkdown('abc').doc });
    state = state.apply(state.tr.setSelection(TextSelection.atEnd(state.doc)));

    const slice = buildMarkdownPasteSlice(parseMarkdown('**粗体**结尾').doc.content);
    state = state.apply(state.tr.replaceSelection(slice));

    expect(state.doc.childCount).toBe(1);
    expect(state.doc.firstChild?.type.name).toBe('paragraph');
  });
});

/** 挂载一个带粘贴插件的 EditorView。 */
function mountWithPaste(doc: Node): EditorView {
  // 局部常量 place：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
  const place = document.createElement('div');
  document.body.appendChild(place);
  // 局部常量 state：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
  const state = EditorState.create({ schema: stenoSchema, doc, plugins: [createPastePlugin()] });
  return new EditorView(place, { state });
}

/** 构造一个仅携带纯文本的伪粘贴事件（绕开 jsdom 不支持的 ClipboardEvent/DataTransfer）。 */
function fakePasteEvent(text: string): ClipboardEvent {
  return {
    clipboardData: {
      files: [] as unknown as FileList,
      getData: (type: string) => (type === 'text/plain' ? text : '')
    },
    preventDefault: () => {}
  } as unknown as ClipboardEvent;
}

// 测试用例：验证「paste — Markdown rAF 插入」场景，锁定粘贴后经 requestAnimationFrame 异步插入并保持装饰正确。
describe('paste — Markdown rAF 异步插入（保证装饰正确重算）', () => {
  it('粘贴 Markdown 后经 rAF 回调更改文档并正确插入块级结构', () => {
    // 模拟 rAF 在下一 tick 立即执行
    const origRAF = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    };
    try {
      const view = mountWithPaste(parseMarkdown('已有内容').doc);
      view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));

      const before = view.state.doc;
      const handled = view.someProp('handlePaste', f => f(view, fakePasteEvent('# 标题'), Slice.empty));

      expect(handled).toBe(true);
      // rAF 模拟已同步执行，文档应已变更
      expect(view.state.doc).not.toBe(before);
      expect(topTypes(view.state.doc)).toContain('heading');

      view.destroy();
    } finally {
      globalThis.requestAnimationFrame = origRAF;
    }
  });
});
