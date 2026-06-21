/**
 * @file syntax-detector 集成测试
 *
 * 验证「粘贴 Markdown 后即时渲染」的安全网：当文本以纯文本形态落入段落（粘贴合并、
 * 默认粘贴路径等）时，syntax-detector 的 appendTransaction 应在文档变更后立即：
 *  - 给行内语法（粗体等）补上语义 mark 与 syntax_marker；
 *  - 把以 `#{1,6} ` 开头的段落转换为 heading 节点；
 *  - 把 `![alt](src)` 段落转换为 image 节点。
 *
 * 这些转换由 createEditorPlugins() 装配的 syntax-detector 提供，是修复
 * 「粘贴 Markdown 不即时渲染 / 标记外露」的核心。
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { Slice, type Node } from 'prosemirror-model';

import { stenoSchema } from '../schema';
import { parseMarkdown } from '../parser';
import { createEditorPlugins } from '../plugins';
import {
  decorationPluginKey,
  findSyntaxMarkerRegions,
  type DecorationPluginState
} from '../decorations';

/** 挂载一个装配完整插件（含 syntax-detector）的 EditorView。 */
function mountFull(doc: Node): EditorView {
  const place = document.createElement('div');
  document.body.appendChild(place);
  const state = EditorState.create({ schema: stenoSchema, doc, plugins: createEditorPlugins() });
  return new EditorView(place, { state });
}

/** 收集文档顶层块节点的 type.name 序列。 */
function topTypes(doc: Node): string[] {
  const out: string[] = [];
  doc.forEach(n => out.push(n.type.name));
  return out;
}

/** 在指定文本节点文本上查找其携带的 mark 名称集合。 */
function marksOfText(doc: Node, text: string): string[] {
  let names: string[] = [];
  doc.descendants(node => {
    if (node.isText && node.text === text) {
      names = node.marks.map(m => m.type.name);
      return false;
    }
    return true;
  });
  return names;
}

describe('syntax-detector — 行内语法补正（即时渲染安全网）', () => {
  it('段落中插入 **粗体** 文本后，detector 补上 strong + syntax_marker', () => {
    // 起点：空段落。直接 insertText 模拟"纯文本落入段落"（绕过 parser 的块级解析）
    const view = mountFull(parseMarkdown('').doc);
    view.dispatch(view.state.tr.setSelection(TextSelection.atStart(view.state.doc)));
    view.dispatch(view.state.tr.insertText('**粗体**'));

    // detector 的 appendTransaction 在 dispatch 后同步运行
    const doc = view.state.doc;
    // 内容文字带 strong
    expect(marksOfText(doc, '粗体')).toContain('strong');
    // 前后 ** 标记带 strong + syntax_marker（即时渲染时会被装饰隐藏）
    expect(marksOfText(doc, '**')).toEqual(expect.arrayContaining(['strong', 'syntax_marker']));

    view.destroy();
  });

  it('段落中插入行内代码 `code` 后，detector 补上 code_inline + syntax_marker', () => {
    const view = mountFull(parseMarkdown('').doc);
    view.dispatch(view.state.tr.setSelection(TextSelection.atStart(view.state.doc)));
    view.dispatch(view.state.tr.insertText('`code`'));

    const doc = view.state.doc;
    expect(marksOfText(doc, 'code')).toContain('code_inline');
    expect(marksOfText(doc, '`')).toEqual(expect.arrayContaining(['code_inline', 'syntax_marker']));

    view.destroy();
  });
});

describe('syntax-detector — 块级转换（即时渲染安全网）', () => {
  it('以 "# " 开头的段落被转换为 heading 节点', () => {
    const view = mountFull(parseMarkdown('').doc);
    view.dispatch(view.state.tr.setSelection(TextSelection.atStart(view.state.doc)));
    view.dispatch(view.state.tr.insertText('# 标题'));

    const doc = view.state.doc;
    expect(topTypes(doc)).toContain('heading');
    // 标题节点 level=1
    let level = 0;
    doc.descendants(node => {
      if (node.type.name === 'heading') level = node.attrs.level as number;
      return true;
    });
    expect(level).toBe(1);

    view.destroy();
  });

  it('"### " 开头的段落被转换为 level=3 的 heading', () => {
    const view = mountFull(parseMarkdown('').doc);
    view.dispatch(view.state.tr.setSelection(TextSelection.atStart(view.state.doc)));
    view.dispatch(view.state.tr.insertText('### 三级标题'));

    let level = 0;
    view.state.doc.descendants(node => {
      if (node.type.name === 'heading') level = node.attrs.level as number;
      return true;
    });
    expect(level).toBe(3);

    view.destroy();
  });

  it('"![alt](src)" 段落被转换为 image 节点', () => {
    const view = mountFull(parseMarkdown('').doc);
    view.dispatch(view.state.tr.setSelection(TextSelection.atStart(view.state.doc)));
    view.dispatch(view.state.tr.insertText('![图片](https://example.com/a.png)'));

    const doc = view.state.doc;
    let imageSrc = '';
    doc.descendants(node => {
      if (node.type.name === 'image') imageSrc = node.attrs.src as string;
      return true;
    });
    expect(imageSrc).toBe('https://example.com/a.png');

    view.destroy();
  });
});

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

describe('端到端：通过 handlePaste 粘贴 Markdown 后即时渲染', () => {
  it('粘贴多块 Markdown 文章后保留块级结构，且光标在正文行时标题 # 隐藏', () => {
    // 模拟 requestAnimationFrame 立即执行（paste 插件用 rAF 延迟 dispatch）
    const origRAF = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    };
    try {
      const view = mountFull(parseMarkdown('').doc);
      view.dispatch(view.state.tr.setSelection(TextSelection.atStart(view.state.doc)));

      const article = ['# Rust 知识点', '', '正文含**粗体**和`代码`', '', '## 子标题', '', '- **列表项**：含`反引号`'].join('\n');

      // 走真实粘贴路径：handlePaste → parseMarkdown → rAF dispatch → syntax-detector → decorations
      const handled = view.someProp('handlePaste', f => f(view, fakePasteEvent(article), Slice.empty));
      expect(handled).toBe(true);

      // 块级结构保留（标题/列表未降级为段落文本）
      expect(topTypes(view.state.doc)).toEqual(expect.arrayContaining(['heading', 'bullet_list']));

      // 把光标移到正文段落（非标题行）：所有标题的 # 标记应隐藏
      let paraPos = -1;
      view.state.doc.descendants((node, pos) => {
        if (node.type.name === 'paragraph' && node.textContent.includes('正文')) paraPos = pos + 1;
        return true;
      });
      expect(paraPos).toBeGreaterThan(0);
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, paraPos)));

      const s = decorationPluginKey.getState(view.state) as DecorationPluginState;
      const headingRegions = findSyntaxMarkerRegions(view.state.doc).filter(r => r.syntaxType === 'heading');
      expect(headingRegions.length).toBeGreaterThan(0);
      for (const r of headingRegions) {
        const found = s.decorations.find(r.from, r.to);
        const hidden = found.some(d => {
          const deco = d as unknown as { from: number; to: number; type?: { attrs?: { class?: string } } };
          return deco.from === r.from && deco.to === r.to && deco.type?.attrs?.class === 'puremark-syntax-hidden';
        });
        expect(hidden, `标题标记 [${r.from}-${r.to}] 在光标位于正文时应隐藏`).toBe(true);
      }

      view.destroy();
    } finally {
      globalThis.requestAnimationFrame = origRAF;
    }
  });

  it('粘贴后把光标移入标题行时该标题的 # 显示', () => {
    const origRAF = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    };
    try {
      const view = mountFull(parseMarkdown('').doc);
      view.dispatch(view.state.tr.setSelection(TextSelection.atStart(view.state.doc)));
      view.someProp('handlePaste', f => f(view, fakePasteEvent('# Rust 知识点\n\n正文内容'), Slice.empty));

      // 找到标题节点，把光标放进标题行
      let headingInner = -1;
      view.state.doc.descendants((node, pos) => {
        if (node.type.name === 'heading' && headingInner < 0) headingInner = pos + 2; // 跳过 # 进入标题文字
        return true;
      });
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, headingInner)));

      const s = decorationPluginKey.getState(view.state) as DecorationPluginState;
      const headingRegions = findSyntaxMarkerRegions(view.state.doc).filter(r => r.syntaxType === 'heading');
      expect(headingRegions.length).toBeGreaterThan(0);
      const anyVisible = headingRegions.some(r => {
        const found = s.decorations.find(r.from, r.to);
        return found.some(d => {
          const deco = d as unknown as { from: number; to: number; type?: { attrs?: { class?: string } } };
          return deco.from === r.from && deco.to === r.to && deco.type?.attrs?.class === 'puremark-syntax-visible';
        });
      });
      expect(anyVisible, '光标在标题行时该标题的 # 应显示').toBe(true);

      view.destroy();
    } finally {
      globalThis.requestAnimationFrame = origRAF;
    }
  });
});

