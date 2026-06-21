/**
 * @file 回归 + 诊断测试：语法标记显隐
 *
 * 1) 边界回归：修复前 `findSemanticRegionsAt` / `computeDecorations` / heading 语义区域
 *    对光标位置用 `>=` 判断，导致光标恰好落在文本节点首字符之前（如 position 1 = 段落开头）
 *    时被误判为"在节点内"，把该语义区域的所有 syntax_marker 设为 visible —— 表现为
 *    粘贴 / 加载后 `**`、`#` 等标记外露。修复：边界检查改用 `>`（严格排除 childStart），
 *    与 ProseMirror "position before the node" 的语义一致。
 * 2) 嵌套诊断：覆盖粗体包裹反引号、列表项嵌套等真实文章结构，确认无标记外露 / 无漏装饰。
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';

import { stenoSchema } from '../schema';
import { parseMarkdown } from '../parser';
import { createInstantRenderPlugin } from '../plugins/instant-render';
import {
  decorationPluginKey,
  findSyntaxMarkerRegions,
  type DecorationPluginState
} from '../decorations';

function mount(doc: ReturnType<typeof parseMarkdown>['doc']): EditorView {
  const place = document.createElement('div');
  document.body.appendChild(place);
  const state = EditorState.create({
    schema: stenoSchema,
    doc,
    plugins: createInstantRenderPlugin()
  });
  return new EditorView(place, { state });
}

function setCursor(view: EditorView, pos: number): void {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
}

function visibleMarkerCount(view: EditorView): number {
  const s = decorationPluginKey.getState(view.state) as DecorationPluginState;
  const regions = findSyntaxMarkerRegions(view.state.doc);
  let count = 0;
  for (const r of regions) {
    // find() 会返回重叠范围的装饰，需精确匹配 from/to 排除相邻区域干扰
    const found = s.decorations.find(r.from, r.to);
    const visible = found.some(d => {
      const deco = d as unknown as { from: number; to: number; type?: { attrs?: { class?: string } } };
      if (deco.from !== r.from || deco.to !== r.to) return false;
      return deco.type?.attrs?.class === 'puremark-syntax-visible';
    });
    if (visible) count++;
  }
  return count;
}

function decoClassesIn(view: EditorView, from: number, to: number): string[] {
  const s = decorationPluginKey.getState(view.state) as DecorationPluginState;
  const found = s.decorations.find(from, to);
  return found
    .filter(d => {
      const deco = d as unknown as { from: number; to: number };
      return deco.from === from && deco.to === to;
    })
    .map(d => {
      const spec = (d as unknown as { type?: { attrs?: { class?: string } } }).type;
      return spec?.attrs?.class ?? '';
    })
    .filter(Boolean);
}

describe('光标在文本节点起始边界时语法标记不外露', () => {
  // 回归用例：截图中 Rust 知识点文章的典型结构（行内语法在文本节点起始边界）
  const regressionCases = [
    { name: '段落以粗体开头', md: '**字符类型**（`char`）的变量' },
    { name: '段落以反引号开头', md: '`char` 是一个 4 字节类型' },
    { name: '段落以斜体开头', md: '*斜体*和普通文本' },
    { name: '粗体包裹反引号', md: '**字符类型（`char`）**' },
    { name: '连续多个粗体', md: '**粗体一**和**粗体二**' },
    { name: '引用以粗体开头', md: '> **粗体**和`代码`' }
  ];

  for (const { name, md } of regressionCases) {
    it(`${name}: 光标在 position 1 时所有标记隐藏`, () => {
      const { doc } = parseMarkdown(md);
      const view = mount(doc);

      setCursor(view, 1);
      expect(visibleMarkerCount(view)).toBe(0);

      view.destroy();
    });
  }

  // 确认光标真正进入标记区域后仍能正常显示
  it('光标进入粗体内容后标记正确显示', () => {
    const { doc } = parseMarkdown('前缀 **粗体** 后缀');
    const view = mount(doc);
    const regions = findSyntaxMarkerRegions(view.state.doc).filter(r => r.syntaxType === 'strong');

    // 光标放到粗体内容中间
    const insidePos = Math.floor((regions[0].to + regions[1].from) / 2);
    setCursor(view, insidePos);

    const s = decorationPluginKey.getState(view.state) as DecorationPluginState;
    for (const r of regions) {
      const found = s.decorations.find(r.from, r.to);
      const visible = found.some(d => {
        const deco = d as unknown as { from: number; to: number; type?: { attrs?: { class?: string } } };
        if (deco.from !== r.from || deco.to !== r.to) return false;
        return deco.type?.attrs?.class === 'puremark-syntax-visible';
      });
      expect(visible).toBe(true);
    }

    view.destroy();
  });
});

describe('标题 # 标记按光标所在行显隐（与 PureMark 一致）', () => {
  // 取某 syntaxType 的第一个 region 的可见性
  function headingMarkerVisible(view: EditorView): boolean {
    const s = decorationPluginKey.getState(view.state) as DecorationPluginState;
    const regions = findSyntaxMarkerRegions(view.state.doc).filter(r => r.syntaxType === 'heading');
    return regions.some(r => {
      const found = s.decorations.find(r.from, r.to);
      return found.some(d => {
        const deco = d as unknown as { from: number; to: number; type?: { attrs?: { class?: string } } };
        if (deco.from !== r.from || deco.to !== r.to) return false;
        return deco.type?.attrs?.class === 'puremark-syntax-visible';
      });
    });
  }

  it('光标在标题行内时该标题的 # 显示', () => {
    const { doc } = parseMarkdown('# 标题内容\n\n正文段落');
    const view = mount(doc);
    // 光标放进标题行（标题内容里，pos 3 落在"标题"中）
    setCursor(view, 3);
    expect(headingMarkerVisible(view)).toBe(true);
    view.destroy();
  });

  it('光标在正文行时标题的 # 隐藏', () => {
    const { doc } = parseMarkdown('# 标题内容\n\n正文段落');
    const view = mount(doc);
    // 把光标移到正文段落
    let paraPos = -1;
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === 'paragraph' && node.textContent.includes('正文')) paraPos = pos + 1;
      return true;
    });
    setCursor(view, paraPos);
    expect(headingMarkerVisible(view)).toBe(false);
    view.destroy();
  });
});

describe('嵌套行内语法的标记显隐', () => {
  const cases = [
    { name: '粗体包裹反引号', md: '**字符类型（`char`）**' },
    { name: '粗体+反引号并列', md: '**字符类型**（`char`）' },
    { name: '反引号内含粗体', md: '`**bold**`' },
    { name: '多重嵌套', md: '在 Rust 中，单引号（`\'...\'`) 用于表示**字符类型**（`char`）的变量。' },
    { name: '列表项中的嵌套语法', md: '1. **字符类型 (`char`)**：用于存储单个字符' },
    { name: '粗体后紧跟反引号', md: '**bold**`code`' },
    { name: '引用中的嵌套', md: '> **粗体**和`代码`' },
    { name: '连续多个粗体', md: '**粗体一**和**粗体二**' },
    { name: '粗体紧挨着', md: '**粗体一****粗体二**' },
    { name: '斜体嵌套反引号', md: '*斜体`code`结束*' },
    { name: '含中文标点', md: '这是**粗体**，还有*斜体*。' }
  ];

  for (const { name, md } of cases) {
    it(`${name}: 光标在文档开头时所有标记应隐藏`, () => {
      const { doc } = parseMarkdown(md);
      const view = mount(doc);
      setCursor(view, 1); // 文档开头

      const regions = findSyntaxMarkerRegions(view.state.doc);
      let hiddenCount = 0;
      let visibleCount = 0;
      for (const r of regions) {
        const classes = decoClassesIn(view, r.from, r.to);
        if (classes.includes('puremark-syntax-hidden')) hiddenCount++;
        if (classes.includes('puremark-syntax-visible')) visibleCount++;
      }

      // 检查文档中是否有 syntax_marker mark 但不在 regions 中的文本节点
      let untrackedMarkers = 0;
      view.state.doc.descendants((node, pos) => {
        if (node.isText) {
          const syntaxMark = node.marks.find(m => m.type.name === 'syntax_marker');
          if (syntaxMark) {
            const inRegions = regions.some(r => pos >= r.from && pos < r.to);
            if (!inRegions) untrackedMarkers++;
          }
        }
        return true;
      });

      expect(visibleCount).toBe(0);
      expect(untrackedMarkers).toBe(0);
      view.destroy();
    });
  }
});
