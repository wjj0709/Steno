/**
 * @file 精准诊断测试：检测光标不在语义区域时标记是否正确隐藏
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
  getActiveSemanticRegions,
  type DecorationPluginState,
  type SyntaxMarkerRegion
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

function isMarkerVisible(view: EditorView, r: SyntaxMarkerRegion): boolean {
  const s = decorationPluginKey.getState(view.state) as DecorationPluginState;
  // find() 返回重叠范围的装饰，必须精确匹配 from/to 以排除相邻区域的干扰
  const found = s.decorations.find(r.from, r.to);
  return found.some(d => {
    const deco = d as unknown as { from: number; to: number; type?: { attrs?: { class?: string } } };
    if (deco.from !== r.from || deco.to !== r.to) return false;
    return deco.type?.attrs?.class === 'puremark-syntax-visible';
  });
}

const RELATIONS: Record<string, string[]> = {
  strong_emphasis: ['strong', 'emphasis'],
  strong: ['strong', 'strong_emphasis'],
  emphasis: ['emphasis', 'strong_emphasis'],
  highlight: ['highlight'],
  strikethrough: ['strikethrough'],
  code_inline: ['code_inline'],
  link: ['link'],
  math_inline: ['math_inline'],
  heading: ['heading'],
  escape: ['escape'],
  sub: ['sub'],
  sup: ['sup'],
  html_inline: ['html_inline']
};

function isRelated(syntaxType: string, semanticType: string): boolean {
  return (RELATIONS[syntaxType] ?? [syntaxType]).includes(semanticType);
}

interface BugInfo {
  pos: number;
  text: string;
  range: string;
  type: string;
  active: string[];
}

function findRealBugs(view: EditorView): BugInfo[] {
  const bugs: BugInfo[] = [];
  const doc = view.state.doc;
  const regions = findSyntaxMarkerRegions(doc);

  for (let pos = 1; pos < doc.nodeSize - 1; pos++) {
    try { setCursor(view, pos); } catch { continue; }

    const activeRegions = getActiveSemanticRegions(doc, pos);

    for (const r of regions) {
      if (!isMarkerVisible(view, r)) continue;

      let justified = false;

      // 光标直接在 syntax_marker 文本内
      if (pos > r.from && pos <= r.to) justified = true;

      // 光标在关联的语义区域内
      if (!justified) {
        for (const ar of activeRegions) {
          if (isRelated(r.syntaxType, ar.type) && r.from >= ar.from && r.to <= ar.to) {
            justified = true;
            break;
          }
        }
      }

      if (!justified) {
        bugs.push({
          pos,
          text: doc.textBetween(r.from, r.to),
          range: `[${r.from}-${r.to}]`,
          type: r.syntaxType,
          active: activeRegions.map(ar => `${ar.type}[${ar.from}-${ar.to}]`)
        });
      }
    }
  }

  return bugs;
}

describe('精准诊断：检测真正的标记外露 bug', () => {
  const rustArticle = [
    '# Rust 知识点',
    '',
    '## 引号的使用',
    '',
    '在 Rust 中，单引号（`\'...\'`）用于表示**字符类型**（`char`）的变量。字符类型是一个 4 字节大小的 Unicode 字符，用单引号包围。',
    '',
    '> `\'char\'` 类型在 Rust 中支持所有的 Unicode 字符，因此可以处理各种语言的符号、表情符号等。',
    '',
    'Rust 中**双引号**（`"..."`）用于表示**字符串类型**（`String` 或 `&str`）。',
    '',
    '两者之间有明显的区别：',
    '',
    '1. **字符类型 (`char`)**：用于存储单个字符',
    '2. **字符串类型 (`String` 或 `&str`)**：用于存储由多个字符组成的文本',
    '',
    '## ASCII 字符与 Unicode 字符的区别',
    '',
    '**ASCII 字符**是 Unicode 的子集，范围从 0 到 127。在内存中，ASCII 字符只使用 1 个字节存储，但 `char` 类型仍然占用 4 个字节。',
    '',
    '**Unicode 字符**包括全球各种语言、符号、表情符号等。即使是一个 ASCII 字符，`char` 类型依然占用 4 个字节。'
  ].join('\n');

  it('截图真实内容：无跨区域的标记泄漏', () => {
    const { doc } = parseMarkdown(rustArticle);
    const view = mount(doc);
    const bugs = findRealBugs(view);

    if (bugs.length > 0) {
      const sample = bugs.slice(0, 30);
      console.error(`发现 ${bugs.length} 个 bug（前 30）:`);
      for (const b of sample) {
        console.error(`  cursor=${b.pos} "${b.text}" (${b.type}) ${b.range} | active: ${b.active.join(', ') || 'none'}`);
      }
    }

    expect(bugs).toEqual([]);
    view.destroy();
  });

  const cases = [
    { name: '简单粗体', md: '前缀**粗体**后缀' },
    { name: '简单反引号', md: '前缀`代码`后缀' },
    { name: '段落以粗体开头', md: '**粗体**后缀' },
    { name: '段落以反引号开头', md: '`代码`后缀' },
    { name: '两个粗体紧挨', md: '**一****二**' },
    { name: '粗体后紧跟反引号', md: '**粗体**`代码`' },
    { name: '反引号后紧跟粗体', md: '`代码`**粗体**' },
    { name: '粗体包裹反引号', md: '**文本`代码`文本**' },
    { name: '粗体包裹斜体', md: '***粗斜体***' },
    { name: '两个段落', md: '第一段**粗体**内容\n\n第二段**粗体**内容' },
    { name: '标题后跟段落', md: '# 标题\n\n正文**粗体**内容' },
    { name: '列表项含粗体', md: '- **粗体**内容\n- 第二项' },
    { name: '有序列表含粗体', md: '1. **粗体**内容\n2. 第二项' },
    { name: '引用含粗体', md: '> **粗体**内容' },
    { name: '引用含反引号', md: '> `代码`内容' },
    { name: '截图段落1', md: '在 Rust 中，单引号（`\'...\'`）用于表示**字符类型**（`char`）的变量。' },
    { name: '截图段落2', md: 'Rust 中**双引号**（`"..."`）用于表示**字符串类型**（`String` 或 `&str`）。' },
    { name: '截图列表项', md: '1. **字符类型 (`char`)**：用于存储单个字符' },
    { name: '截图粗斜体混用', md: '**ASCII 字符**是 Unicode 的子集，范围从 0 到 127。' }
  ];

  for (const { name, md } of cases) {
    it(`${name}: 无跨区域标记泄漏`, () => {
      const { doc } = parseMarkdown(md);
      const view = mount(doc);
      const bugs = findRealBugs(view);

      if (bugs.length > 0) {
        console.error(`[${name}] ${bugs.length} bugs:`);
        for (const b of bugs.slice(0, 10)) {
          console.error(`  cursor=${b.pos} "${b.text}" (${b.type}) ${b.range} | active: ${b.active.join(', ') || 'none'}`);
        }
        console.error(`[${name}] doc structure:`);
        doc.descendants((node, pos) => {
          if (node.isText) {
            const marks = node.marks.map(m => `${m.type.name}${m.attrs.syntaxType ? `(${m.attrs.syntaxType})` : ''}`).join(',');
            console.error(`  pos=${pos} "${node.text}" [${marks}]`);
          }
          return true;
        });
      }

      expect(bugs).toEqual([]);
      view.destroy();
    });
  }
});

describe('跨区块泄漏检测', () => {
  it('光标在第二段时，第一段标记应隐藏', () => {
    const { doc } = parseMarkdown('第一段**粗体**内容\n\n第二段**粗体**内容');
    const view = mount(doc);
    const regions = findSyntaxMarkerRegions(doc);

    let pos = -1;
    doc.descendants((node, p) => {
      if (node.isText && node.text === '第二段') pos = p + 2;
      return true;
    });

    if (pos > 0) {
      setCursor(view, pos);
      for (const r of regions) {
        const $r = doc.resolve(r.from);
        if ($r.parent.textContent.startsWith('第一段')) {
          expect(isMarkerVisible(view, r),
            `"${r.syntaxType}" [${r.from}-${r.to}] should be hidden when cursor in para 2`
          ).toBe(false);
        }
      }
    }

    view.destroy();
  });

  it('光标在正文时，标题标记应隐藏', () => {
    const { doc } = parseMarkdown('# 标题内容\n\n正文**粗体**文字');
    const view = mount(doc);
    const regions = findSyntaxMarkerRegions(doc);

    let pos = -1;
    doc.descendants((node, p) => {
      if (node.isText && node.text === '正文') pos = p + 1;
      return true;
    });

    if (pos > 0) {
      setCursor(view, pos);
      for (const r of regions.filter(rg => rg.syntaxType === 'heading')) {
        expect(isMarkerVisible(view, r),
          `heading [${r.from}-${r.to}] should be hidden when cursor in body`
        ).toBe(false);
      }
    }

    view.destroy();
  });
});

describe('正向验证', () => {
  it('光标在粗体内时标记可见', () => {
    const { doc } = parseMarkdown('前缀 **粗体** 后缀');
    const view = mount(doc);
    const regions = findSyntaxMarkerRegions(doc).filter(r => r.syntaxType === 'strong');
    setCursor(view, regions[0].to + 1);

    for (const r of regions) {
      expect(isMarkerVisible(view, r)).toBe(true);
    }

    view.destroy();
  });
});
