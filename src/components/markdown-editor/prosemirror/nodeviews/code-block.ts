/**
 * @file code-block NodeView（内嵌 CodeMirror 6）
 *
 * 移植自 PureMark `src/core/nodeviews/code-block.ts`。核心是「在 ProseMirror NodeView
 * 内挂一个 CodeMirror 6 EditorView」的经典嵌套编辑器方案（PM 官方 codemirror 示例同构）：
 *   - 编辑态语法高亮交给 CM；
 *   - 内外 selection / focus / undo 协同（PM→CM 用 setSelection，CM→PM 用 forwardSelection）；
 *   - CM 文档变更回写 PM（onCMUpdate），PM 文档变更同步进 CM（update）；
 *   - 方向键 / Backspace 在 CM 边界处「跳出」到外层 PM。
 *
 * Steno 相对 PureMark 的关键适配：
 * - Mermaid 与 PureMark 一致：```mermaid 解析为 language='mermaid' 的 code_block，由本 NodeView
 *   渲染图表预览 + 头部「代码/混合/图表」模式选择器；点击图表弹出全屏大图浮层（缩放/平移）。
 *   图表渲染复用 `utils/markdown/mermaid` 的占位渲染（串行队列 + 主题派生）。
 * - 暂不实现 source-view 模式、右键菜单、行内搜索高亮（Steno 尚无对应插件）。
 * - 语言包改用 `@codemirror/language-data` 的 `languages` + `LanguageDescription.matchLanguageName(...).load()`
 *   动态加载（PureMark 是一堆静态 import + 自维护映射表）。
 * - 暗色主题由外层 CSS（`.app-theme-root.dark`）驱动，这里不做 JS 层暗色检测；
 *   CM 主题仅给一个适配 CSS 变量的透明 `EditorView.theme`，配色由外层 CSS 覆盖。
 *   mermaid 图表则通过监听根元素 class 变化，在主题切换时用新主题色重渲染。
 * - 可编辑态语言选择器为自定义下拉；只读态降级为静态「语言标签」。
 * - `any` 一律换成 `unknown` / 具体类型（oxlint 严格模式）。
 */

import type { Node as ProseMirrorNode } from 'prosemirror-model';
import type { EditorView as ProseMirrorView, NodeView } from 'prosemirror-view';
import { Selection, TextSelection } from 'prosemirror-state';
import {
  EditorView,
  keymap as cmKeymap,
  lineNumbers,
  // 类型 ViewUpdate：记录模块边界的数据形状，帮助调用方理解字段来源和约束。
  type ViewUpdate
} from '@codemirror/view';
import { EditorState as CMEditorState, Compartment } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, HighlightStyle, LanguageDescription } from '@codemirror/language';
import { languages as cmLanguages } from '@codemirror/language-data';
import { getMermaidThemeVariables, renderMermaidPlaceholders } from '@/utils/markdown/mermaid';

/** Mermaid 显示模式（对齐 PureMark）：纯代码 / 代码+图表 / 纯图表。 */
type MermaidDisplayMode = 'code' | 'mixed' | 'diagram';

/** Mermaid 显示模式下拉候选项。 */
const MERMAID_MODES: ReadonlyArray<{ value: MermaidDisplayMode; label: string }> = [
  { value: 'code', label: '代码' },
  { value: 'mixed', label: '混合' },
  { value: 'diagram', label: '图表' }
];

/** 把 mermaid 源码做 base64 编码（与 `utils/markdown` 占位编码等价）。 */
function encodeMermaidSource(source: string): string {
  try {
    // 局部常量 utf8：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
    const utf8 = new TextEncoder().encode(source);
    let binary = '';
    for (const byte of utf8) binary += String.fromCharCode(byte);
    return typeof btoa === 'function' ? btoa(binary) : Buffer.from(binary, 'binary').toString('base64');
  } catch {
    return '';
  }
}

/**
 * 打开 mermaid 图表的全屏大图浮层（点击图表触发）。
 * 支持滚轮缩放（以光标为锚点）、拖拽平移；点击遮罩 / 关闭按钮 / Esc 关闭。
 *
 * @param svgHtml 已渲染的 SVG 字符串（取自图表预览容器的 innerHTML）
 */
function openMermaidLightbox(svgHtml: string): void {
  if (!svgHtml.trim()) return;

  // 局部常量 overlay：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
  const overlay = document.createElement('div');
  overlay.className = 'steno-mermaid-lightbox';

  // 局部常量 stage：拖拽/缩放的承载层（transform 作用对象）。
  const stage = document.createElement('div');
  stage.className = 'steno-mermaid-lightbox-stage';
  // 给浮层一个与图表渲染时一致的画布底色：mermaid 用 themeVariables.background 作画布，
  // SVG 的文字/箭头按此底色取对比色。浮层挂在 document.body 上、拿不到 .app-theme-root 的
  // --app-* 变量，故直接复用 mermaid 的派生值（CSS 变量缺失时回退浅色），保证高对比、不糊成一片。
  stage.style.background = getMermaidThemeVariables().themeVariables.background || '#ffffff';
  stage.innerHTML = svgHtml;
  // 浮层里的 SVG 取消渲染态的宽度限制，并按 viewBox 给出确定尺寸（否则只有 viewBox
  // 的 SVG 在去掉 width/height 后会塌缩成 0，浮层只剩一片遮罩、看不到图）。
  const svg = stage.querySelector('svg');
  // SVG 的基准显示尺寸（scale=1 时的像素宽高）。缩放不走 CSS transform scale（位图放大会糊），
  // 而是按 baseW*scale / baseH*scale 重设 SVG 自身尺寸，让浏览器按矢量在目标尺寸重新栅格化 → 始终清晰。
  let baseW = 0;
  let baseH = 0;
  if (svg) {
    svg.style.removeProperty('max-width');
    svg.style.removeProperty('width');
    svg.style.removeProperty('height');

    // 从 viewBox / 原始 width·height 推导自然宽高，回填一个不超过视口的初始尺寸。
    const viewBox = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
    let natW = parseFloat(svg.getAttribute('width') || '');
    let natH = parseFloat(svg.getAttribute('height') || '');
    if ((!Number.isFinite(natW) || !Number.isFinite(natH)) && viewBox.length === 4) {
      natW = viewBox[2];
      natH = viewBox[3];
    }
    if (Number.isFinite(natW) && Number.isFinite(natH) && natW > 0 && natH > 0) {
      // 初始尽量铺满视口（留边距），但不超过自然尺寸的 1.5 倍。
      const fit = Math.min(
        (window.innerWidth * 0.9) / natW,
        (window.innerHeight * 0.9) / natH,
        1.5
      );
      baseW = Math.round(natW * fit);
      baseH = Math.round(natH * fit);
    } else {
      // 兜底：没有可用尺寸信息时给一个固定基准，避免塌缩。
      baseW = 800;
      baseH = 600;
    }
    svg.setAttribute('width', String(baseW));
    svg.setAttribute('height', String(baseH));
    svg.style.maxWidth = 'none';
    svg.style.maxHeight = 'none';
  }

  // 局部常量 closeBtn：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'steno-mermaid-lightbox-close';
  closeBtn.title = '关闭 (Esc)';
  closeBtn.textContent = '✕';

  overlay.appendChild(stage);
  overlay.appendChild(closeBtn);
  document.body.appendChild(overlay);

  // 缩放/平移状态
  let scale = 1;
  let tx = 0;
  let ty = 0;
  let dragging = false;
  let startX = 0;
  let startY = 0;

  // 函数 applyZoom：按 scale 重设 SVG 像素尺寸（矢量重栅格化，放大后保持清晰，不用 CSS scale）。
  const applyZoom = () => {
    if (!svg || baseW <= 0 || baseH <= 0) return;
    svg.setAttribute('width', String(Math.round(baseW * scale)));
    svg.setAttribute('height', String(Math.round(baseH * scale)));
  };

  // 函数 applyTransform：仅写回平移；缩放交给 applyZoom（CSS transform 不含 scale，避免位图放大发虚）。
  const applyTransform = () => {
    stage.style.transform = `translate(${tx}px, ${ty}px)`;
  };

  // 函数 close：移除浮层并解绑全局监听。
  const close = () => {
    document.removeEventListener('keydown', onKeydown);
    overlay.remove();
  };

  // 函数 onKeydown：Esc 关闭。
  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') close();
  }

  overlay.addEventListener('wheel', e => {
    e.preventDefault();
    // 局部常量 delta：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
    const delta = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    // 局部常量 next：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
    const next = Math.min(8, Math.max(0.2, scale * delta));
    if (next === scale) return; // 已到缩放上下限，跳过无谓的重栅格化
    // 以鼠标位置为锚点缩放：保持光标下的内容点不动（SVG 绕自身中心等比放大，padding 对称不影响）
    const rect = stage.getBoundingClientRect();
    const ox = e.clientX - (rect.left + rect.width / 2);
    const oy = e.clientY - (rect.top + rect.height / 2);
    const ratio = next / scale;
    tx -= ox * (ratio - 1);
    ty -= oy * (ratio - 1);
    scale = next;
    applyZoom();
    applyTransform();
  });

  stage.addEventListener('pointerdown', e => {
    dragging = true;
    startX = e.clientX - tx;
    startY = e.clientY - ty;
    stage.setPointerCapture(e.pointerId);
    stage.classList.add('dragging');
  });
  stage.addEventListener('pointermove', e => {
    if (!dragging) return;
    tx = e.clientX - startX;
    ty = e.clientY - startY;
    applyTransform();
  });
  // 函数 endDrag：结束拖拽。
  const endDrag = () => {
    dragging = false;
    stage.classList.remove('dragging');
  };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);

  // 点击遮罩（非图表本体）关闭
  overlay.addEventListener('click', e => {
    if (e.target === overlay) close();
  });
  closeBtn.addEventListener('click', close);
  document.addEventListener('keydown', onKeydown);
}

/**
 * 代码块语法高亮 token 配色：CodeMirror 的 defaultHighlightStyle 仅为浅底设计（固定深色），
 * 在暗色背景上会看不清。这里复用其 tag 划分，仅把固定色重映射为 --app-code-* CSS 变量，
 * 使 token 配色随主题自适应（亮/暗值见 editor-base.css）。映射键是 @codemirror/language 6.x
 * 内置的稳定色值；未命中的保留原色（优雅降级，不影响渲染）。
 */
const CODE_TOKEN_COLOR_VARS: Record<string, string> = {
  '#404740': 'var(--app-code-meta)',
  '#708': 'var(--app-code-keyword)',
  '#219': 'var(--app-code-atom)',
  '#164': 'var(--app-code-literal)',
  '#a11': 'var(--app-code-string)',
  '#e40': 'var(--app-code-regexp)',
  '#00f': 'var(--app-code-def)',
  '#30a': 'var(--app-code-variable)',
  '#085': 'var(--app-code-type)',
  '#167': 'var(--app-code-class)',
  '#256': 'var(--app-code-special)',
  '#00c': 'var(--app-code-property)',
  '#940': 'var(--app-code-comment)',
  '#f00': 'var(--app-code-invalid)'
};

/** 主题感知的语法高亮：token 色走 --app-code-* 变量，暗色下也保持足够对比、不再看不清。 */
const stenoHighlightStyle = HighlightStyle.define(
  defaultHighlightStyle.specs.map(spec => {
    // 局部常量 mapped：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
    const mapped = spec.color ? CODE_TOKEN_COLOR_VARS[spec.color.toLowerCase()] : undefined;
    return mapped ? { ...spec, color: mapped } : spec;
  })
);

/**
 * 创建 CodeMirror 主题扩展。
 *
 * CM 自身只给透明背景 + 用 --app-* 变量取色的基础主题，配色随主题切换：
 * - 文字 / 光标用 --app-fg（此前误用从未定义的 --text-color，暗色下回退继承导致看不清）；
 * - 行号用 --app-faint；
 * - 选区用 --app-code-selection（此前误用从未定义的 --selected-background-color，
 *   导致选中内容无高亮、看不清）；
 * - 语法高亮用 stenoHighlightStyle（token 色走 --app-code-* 变量，暗色下清晰）。
 */
function createThemeExtension() {
  // 局部常量 baseTheme：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
  const baseTheme = EditorView.theme({
    '&': {
      backgroundColor: 'transparent',
      color: 'var(--app-fg)'
    },
    '.cm-content': {
      caretColor: 'var(--app-fg)'
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: 'var(--app-fg)'
    },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: 'var(--app-code-selection)'
    },
    '.cm-activeLine': {
      backgroundColor: 'transparent'
    },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      color: 'var(--app-faint)',
      border: 'none'
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'transparent'
    },
    '.cm-lineNumbers .cm-gutterElement': {
      color: 'var(--app-faint)'
    }
  });
  return [baseTheme, syntaxHighlighting(stenoHighlightStyle)];
}

/**
 * 根据语言名（attrs.language，可能是别名如 ts/py）查 `@codemirror/language-data` 描述符。
 * 返回值同时用于：动态加载语言扩展、以及显示用的标签文本。
 */
function matchLanguageDescription(language: string): LanguageDescription | null {
  // 函数式常量 name：以闭包形式组织逻辑，便于在组件、store 或测试中传递。
  const name = (language ?? '').trim();
  if (!name) return null;
  return LanguageDescription.matchLanguageName(cmLanguages, name, true);
}

/** 语言标签显示文本：mermaid 特判，能匹配到描述符就用其规范名，否则回退原始字符串或「纯文本」。 */
function languageLabel(language: string): string {
  // 局部常量 raw：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
  const raw = (language ?? '').trim();
  if (raw.toLowerCase() === 'mermaid') return 'Mermaid';
  // 局部常量 desc：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
  const desc = matchLanguageDescription(raw);
  if (desc) return desc.name;
  return raw || 'plain text';
}

/**
 * 语言选择器的候选项（value 写入 `attrs.language`，label 为展示名）。
 *
 * 这是一份「常用语言」精选表（对齐 PureMark `supportedLanguages`）。value 仍交由
 * `@codemirror/language-data` 的 `matchLanguageName` 解析，未列出的语言也能通过解析正常高亮。
 * mermaid 作为一种特殊「语言」：选中后切换为图表渲染（带代码/混合/图表模式选择器）。
 */
const LANGUAGE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: 'plain text' },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'typescript', label: 'TypeScript' },
  { value: 'jsx', label: 'JSX' },
  { value: 'tsx', label: 'TSX' },
  { value: 'python', label: 'Python' },
  { value: 'java', label: 'Java' },
  { value: 'c', label: 'C' },
  { value: 'cpp', label: 'C++' },
  { value: 'csharp', label: 'C#' },
  { value: 'go', label: 'Go' },
  { value: 'rust', label: 'Rust' },
  { value: 'php', label: 'PHP' },
  { value: 'ruby', label: 'Ruby' },
  { value: 'swift', label: 'Swift' },
  { value: 'kotlin', label: 'Kotlin' },
  { value: 'scala', label: 'Scala' },
  { value: 'html', label: 'HTML' },
  { value: 'css', label: 'CSS' },
  { value: 'sql', label: 'SQL' },
  { value: 'shell', label: 'Shell' },
  { value: 'json', label: 'JSON' },
  { value: 'xml', label: 'XML' },
  { value: 'yaml', label: 'YAML' },
  { value: 'markdown', label: 'Markdown' },
  { value: 'dockerfile', label: 'Dockerfile' },
  { value: 'lua', label: 'Lua' },
  { value: 'r', label: 'R' },
  { value: 'mermaid', label: 'Mermaid' }
];

/**
 * 判断两个语言名是否指向同一语言（用于下拉项的「已选中」判定）。
 * 通过 `@codemirror/language-data` 的规范名比较，从而把别名（ts/py/c++ 等）与候选项 value 对齐；
 * 两者都解析不到时视为相同（都是纯文本 / 未知）。
 */
function isSameLanguage(a: string, b: string): boolean {
  // 局部常量 na/nb：规范化（小写去空白）后用于 mermaid / 未知语言的严格比较。
  const na = (a ?? '').trim().toLowerCase();
  const nb = (b ?? '').trim().toLowerCase();
  // mermaid 是独立分类，只与自身相等（不能因双方都「解析不到」而误判为相同）
  if (na === 'mermaid' || nb === 'mermaid') return na === nb;
  // 局部常量 da/db：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
  const da = matchLanguageDescription(a);
  const db = matchLanguageDescription(b);
  // 都解析不到时按规范化字符串严格比较（''↔'' 视为同一「纯文本」，不同未知语言不互相选中）
  if (!da && !db) return na === nb;
  return !!da && !!db && da.name === db.name;
}

/**
 * 代码块 NodeView 类（移植自 PureMark CodeBlockView）。
 */
export class CodeBlockView implements NodeView {
  dom: HTMLElement;
  cm: EditorView | null = null;
  node: ProseMirrorNode;
  view: ProseMirrorView;
  getPos: () => number | undefined;
  /** 标记「正在由一侧驱动另一侧更新」，避免 PM↔CM 双向同步形成回环。 */
  updating = false;
  languageCompartment: Compartment;
  headerElement: HTMLElement;
  /** 只读态语言标签（仅 `!isEditable` 时创建）。 */
  langLabelElement: HTMLElement | null = null;
  /** 可编辑态语言选择器按钮（仅 `isEditable` 时创建，点击展开下拉切换语言）。 */
  private langSelectButton: HTMLButtonElement | null = null;
  /** 可编辑态语言选择器下拉容器（用于同步「已选中」高亮）。 */
  private langSelectDropdown: HTMLElement | null = null;
  /** 自定义下拉的「点击外部关闭」监听器集合（destroy 时统一移除，避免泄漏）。 */
  private outsideHandlers: Array<() => void> = [];
  editorContainer: HTMLElement;
  readonlyElement: HTMLPreElement | null = null;
  isEditable: boolean;
  /** 当前已加载语言名的 token，避免异步 load 竞态把旧语言扩展写回。 */
  private loadedLanguageToken = '';
  /** Mermaid 图表预览容器（仅 language==='mermaid' 时创建）。 */
  private mermaidPreview: HTMLElement | null = null;
  /** Mermaid 显示模式（代码 / 混合 / 图表）。 */
  private mermaidDisplayMode: MermaidDisplayMode = 'diagram';
  /** Mermaid 模式选择器容器（仅可编辑 + mermaid 时存在，用于插入/移除与按钮同步）。 */
  private modeSelectContainer: HTMLElement | null = null;
  private modeSelectButton: HTMLButtonElement | null = null;
  /** 当前 mermaid 源码（用于主题切换重渲染、避免无谓重复渲染）。 */
  private lastMermaidSource: string | null = null;
  /** 监听根元素 class 变化以在主题切换时重渲染 mermaid。 */
  private themeObserver: MutationObserver | null = null;

  constructor(node: ProseMirrorNode, view: ProseMirrorView, getPos: () => number | undefined) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;
    this.languageCompartment = new Compartment();
    this.isEditable = view.editable;

    const language: string = node.attrs.language ?? '';
    // 局部常量 isMermaid：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
    const isMermaid = language.toLowerCase() === 'mermaid';
    // 新建（内容为空）的 mermaid 块用「混合」模式，方便边写边看；否则默认「图表」。
    if (isMermaid && !node.textContent.trim()) this.mermaidDisplayMode = 'mixed';

    // 容器
    this.dom = document.createElement('div');
    this.dom.className = 'steno-code-block';
    if (!this.isEditable) this.dom.classList.add('is-readonly');
    if (isMermaid) this.dom.classList.add('is-mermaid');

    // 头部（语言控件 + Mermaid 模式选择器 + 复制按钮）
    this.headerElement = document.createElement('div');
    this.headerElement.className = 'steno-code-block-header';

    // 语言控件：可编辑态用自定义下拉选择器（可切换语言），只读态用静态标签
    this.headerElement.appendChild(this.buildLanguageControl(language));

    // Mermaid 模式选择器（仅可编辑 + mermaid 时显示）
    if (this.isEditable && isMermaid) {
      this.modeSelectContainer = this.createModeSelect();
      this.headerElement.appendChild(this.modeSelectContainer);
    }

    this.headerElement.appendChild(this.createCopyButton());
    this.dom.appendChild(this.headerElement);

    this.editorContainer = document.createElement('div');
    this.editorContainer.className = 'steno-code-block-editor';
    this.dom.appendChild(this.editorContainer);

    if (this.isEditable) {
      this.mountCodeMirror(node);
      // 异步加载语言扩展（动态 import 语言包）
      void this.loadLanguage(language);
      if (isMermaid) this.createMermaidPreview(node.textContent);
    } else if (isMermaid) {
      // 只读态 mermaid 直接渲染图表（不显示源码）
      this.mermaidDisplayMode = 'diagram';
      this.createMermaidPreview(node.textContent);
    } else {
      this.renderReadonlyCode();
    }
  }

  /**
   * 构建头部语言控件：可编辑态返回自定义下拉选择器（可切换语言），只读态返回静态标签。
   */
  private buildLanguageControl(language: string): HTMLElement {
    if (this.isEditable) {
      return this.createLanguageSelect(language);
    }
    // 局部常量 label：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
    const label = document.createElement('span');
    label.className = 'steno-code-block-lang-label';
    label.textContent = languageLabel(language);
    this.langLabelElement = label;
    return label;
  }

  /**
   * 通用自定义下拉选择器（移植自 PureMark `createCustomSelect`）。
   * 用 mousedown.preventDefault 防止点击时编辑器失焦/选区跳动；点击外部关闭；
   * 选项点击 → `onChange(value)`。`isSelected` 用于「已选中」高亮判定。
   *
   * @returns 选择器 DOM 结构（含 button / dropdown 引用，供调用方做后续同步）
   */
  private createCustomSelect(
    options: ReadonlyArray<{ value: string; label: string }>,
    currentValue: string,
    isSelected: (optionValue: string, current: string) => boolean,
    onChange: (value: string) => void,
    extraClass: string
  ): { container: HTMLElement; button: HTMLButtonElement; dropdown: HTMLElement } {
    // 局部常量 container：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
    const container = document.createElement('div');
    container.className = `steno-custom-select ${extraClass}`;

    // 局部常量 current：当前选中项（用于按钮文案）。
    const current = options.find(o => isSelected(o.value, currentValue));

    // 局部常量 button：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'steno-custom-select-button';
    button.textContent = current?.label ?? options[0]?.label ?? '';

    // 局部常量 dropdown：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
    const dropdown = document.createElement('div');
    dropdown.className = 'steno-custom-select-dropdown';

    for (const option of options) {
      // 局部常量 item：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
      const item = document.createElement('div');
      item.className = 'steno-custom-select-item';
      if (isSelected(option.value, currentValue)) item.classList.add('selected');
      item.textContent = option.label;
      item.dataset.value = option.value;
      // mousedown.preventDefault：点击选项时不抢走编辑器/CM 焦点，避免选区跳动
      item.addEventListener('mousedown', e => e.preventDefault());
      item.addEventListener('click', e => {
        e.stopPropagation();
        container.classList.remove('open');
        onChange(option.value);
      });
      dropdown.appendChild(item);
    }

    button.addEventListener('mousedown', e => e.preventDefault());
    button.addEventListener('click', e => {
      e.stopPropagation();
      // 关闭其它已打开的下拉
      document.querySelectorAll('.steno-custom-select.open').forEach(el => {
        if (el !== container) el.classList.remove('open');
      });
      // 下方空间不足时向上弹出
      // 局部常量 rect：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
      const rect = button.getBoundingClientRect();
      // 局部常量 spaceBelow：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
      const spaceBelow = window.innerHeight - rect.bottom;
      container.classList.toggle('dropup', spaceBelow < 240 && rect.top > spaceBelow);
      container.classList.toggle('open');
    });

    // 点击编辑器/页面其它位置时关闭下拉（句柄登记到 outsideHandlers，destroy 时统一移除）
    // 函数式常量 outside：以闭包形式组织逻辑，便于在组件、store 或测试中传递。
    const outside = () => container.classList.remove('open');
    this.outsideHandlers.push(outside);
    document.addEventListener('click', outside);

    container.appendChild(button);
    container.appendChild(dropdown);
    return { container, button, dropdown };
  }

  /** 语言选择器：切换 `attrs.language`。 */
  private createLanguageSelect(currentLanguage: string): HTMLElement {
    // 局部常量 select：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
    const select = this.createCustomSelect(
      LANGUAGE_OPTIONS,
      currentLanguage,
      isSameLanguage,
      value => this.setLanguage(value),
      'steno-code-block-lang-select'
    );
    this.langSelectButton = select.button;
    this.langSelectDropdown = select.dropdown;
    return select.container;
  }

  /** Mermaid 显示模式选择器（代码 / 混合 / 图表）。 */
  private createModeSelect(): HTMLElement {
    // 局部常量 select：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
    const select = this.createCustomSelect(
      MERMAID_MODES,
      this.mermaidDisplayMode,
      (a, b) => a === b,
      value => this.setMermaidDisplayMode(value as MermaidDisplayMode),
      'steno-code-block-mode-select'
    );
    this.modeSelectButton = select.button;
    return select.container;
  }

  /**
   * 切换代码块语言：改写节点 `language` 属性并聚焦。
   * 后续 ProseMirror 会以新节点回调 `update()`，由其同步语言标签与 CM 高亮扩展。
   */
  private setLanguage(language: string): void {
    // 局部常量 pos：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
    const pos = this.getPos();
    if (pos === undefined) return;
    if ((this.node.attrs.language ?? '') === language) return;
    this.view.dispatch(
      this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, language })
    );
    this.view.focus();
  }

  /**
   * 同步语言控件的展示：只读标签文本、可编辑选择器按钮文本，以及下拉项的「已选中」高亮。
   */
  private syncLanguageLabel(language: string): void {
    if (this.langLabelElement) {
      this.langLabelElement.textContent = languageLabel(language);
    }
    if (this.langSelectButton) {
      this.langSelectButton.textContent = languageLabel(language);
    }
    if (this.langSelectDropdown) {
      this.langSelectDropdown.querySelectorAll('.steno-custom-select-item').forEach(el => {
        // 局部常量 item：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
        const item = el as HTMLElement;
        item.classList.toggle('selected', isSameLanguage(item.dataset.value ?? '', language));
      });
    }
  }

  // ========================= Mermaid 图表（对齐 PureMark） =========================

  /** 切换 Mermaid 显示模式并刷新显示。 */
  private setMermaidDisplayMode(mode: MermaidDisplayMode): void {
    this.mermaidDisplayMode = mode;
    if (this.modeSelectButton) {
      // 局部常量 label：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
      const label = MERMAID_MODES.find(m => m.value === mode)?.label;
      if (label) this.modeSelectButton.textContent = label;
    }
    this.updateMermaidDisplay();
  }

  /**
   * 语言在 mermaid / 非 mermaid 之间切换时，同步头部模式选择器与图表预览的存在性。
   * 由 `update()` 在检测到语言变化时调用。
   */
  private syncMermaidControls(language: string): void {
    // 函数式常量 isMermaid：以闭包形式组织逻辑，便于在组件、store 或测试中传递。
    const isMermaid = language.toLowerCase() === 'mermaid';
    this.dom.classList.toggle('is-mermaid', isMermaid);

    if (isMermaid) {
      // 进入 mermaid：补建模式选择器（可编辑态）
      if (this.isEditable && !this.modeSelectContainer) {
        this.mermaidDisplayMode = this.node.textContent.trim() ? 'diagram' : 'mixed';
        this.modeSelectContainer = this.createModeSelect();
        // 插到语言选择器之后、复制按钮之前
        // 局部常量 langSel：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
        const langSel = this.headerElement.querySelector('.steno-code-block-lang-select');
        langSel?.after(this.modeSelectContainer);
      }
      this.createMermaidPreview(this.node.textContent);
    } else {
      // 离开 mermaid：移除模式选择器与图表预览，恢复编辑器显示
      if (this.modeSelectContainer) {
        this.modeSelectContainer.remove();
        this.modeSelectContainer = null;
        this.modeSelectButton = null;
      }
      if (this.mermaidPreview) {
        this.mermaidPreview.remove();
        this.mermaidPreview = null;
        this.lastMermaidSource = null;
      }
      this.editorContainer.style.display = '';
    }
  }

  /**
   * 创建 / 刷新 Mermaid 图表预览。
   *
   * 复用 `utils/markdown/mermaid` 的占位渲染机制：写入一个新的
   * `pre.mermaid-placeholder[data-source]`（无 RENDERED_FLAG），交给
   * `renderMermaidPlaceholders` 串行渲染为 SVG。重新调用即用当前主题重渲染。
   */
  private createMermaidPreview(source: string): void {
    if (!this.mermaidPreview) {
      this.mermaidPreview = document.createElement('div');
      this.mermaidPreview.className = 'steno-mermaid-preview';
      this.mermaidPreview.setAttribute('contenteditable', 'false');
      this.mermaidPreview.title = '点击放大查看';
      // 点击预览（已渲染出 SVG 时）弹出全屏大图浮层
      this.mermaidPreview.addEventListener('click', e => {
        e.stopPropagation();
        // 局部常量 svg：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
        const svg = this.mermaidPreview?.querySelector('svg');
        if (svg) openMermaidLightbox(svg.outerHTML);
      });
      this.dom.appendChild(this.mermaidPreview);
      this.ensureThemeObserver();
    }

    this.lastMermaidSource = source;
    // 局部常量 preview：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
    const preview = this.mermaidPreview;
    // 局部常量 placeholder：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
    const placeholder = document.createElement('pre');
    placeholder.className = 'mermaid-placeholder';
    placeholder.setAttribute('data-source', encodeMermaidSource(source));
    preview.innerHTML = '';
    preview.appendChild(placeholder);
    // 微任务里触发异步渲染（动态 import mermaid 内核）
    queueMicrotask(() => {
      void renderMermaidPlaceholders(preview);
    });

    this.updateMermaidDisplay();
  }

  /** 按当前模式显隐「编辑器」与「图表预览」。 */
  private updateMermaidDisplay(): void {
    if (!this.mermaidPreview) return;
    switch (this.mermaidDisplayMode) {
      case 'code':
        this.editorContainer.style.display = '';
        this.mermaidPreview.style.display = 'none';
        break;
      case 'diagram':
        // 只读态没有编辑器容器内容需要隐藏，但隐藏不影响
        this.editorContainer.style.display = 'none';
        this.mermaidPreview.style.display = '';
        break;
      case 'mixed':
      default:
        this.editorContainer.style.display = '';
        this.mermaidPreview.style.display = '';
        break;
    }
  }

  /**
   * 监听根元素 class 变化（主题切换），mermaid 块用新主题色重渲染。
   * 只在首个 mermaid 预览创建时注册一次。
   */
  private ensureThemeObserver(): void {
    if (this.themeObserver) return;
    this.themeObserver = new MutationObserver(() => {
      if (this.mermaidPreview && this.lastMermaidSource !== null) {
        this.createMermaidPreview(this.lastMermaidSource);
      }
    });
    this.themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class']
    });
  }

  private mountCodeMirror(node: ProseMirrorNode): void {
    this.cm = new EditorView({
      state: CMEditorState.create({
        doc: node.textContent,
        extensions: [
          history(),
          cmKeymap.of([
            {
              // 在列表中按 Ctrl-Enter 退出代码块（保留 PureMark 行为）
              key: 'Ctrl-Enter',
              run: () => {
                // 局部常量 pos：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
                const pos = this.getPos();
                if (pos !== undefined) {
                  const $pos = this.view.state.doc.resolve(pos);
                  let inList = false;
                  for (let d = $pos.depth; d > 0; d--) {
                    // 局部常量 ancestor：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
                    const ancestor = $pos.node(d);
                    if (ancestor.type.name === 'list_item' || ancestor.type.name === 'task_item') {
                      inList = true;
                      break;
                    }
                  }
                  if (inList) {
                    this.exitCodeBlockAndCreateListItem();
                    return true;
                  }
                }
                this.exitCodeBlock(1);
                return true;
              }
            },
            {
              // 在最后一行按 ↓ 跳出到代码块下方
              key: 'ArrowDown',
              run: cmView => {
                const { state } = cmView;
                const { main } = state.selection;
                // 局部常量 line：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
                const line = state.doc.lineAt(main.head);
                if (line.number === state.doc.lines) {
                  this.exitCodeBlock(1);
                  return true;
                }
                return false;
              }
            },
            {
              // 在第一行按 ↑ 跳出到代码块上方
              key: 'ArrowUp',
              run: cmView => {
                const { state } = cmView;
                const { main } = state.selection;
                // 局部常量 line：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
                const line = state.doc.lineAt(main.head);
                if (line.number === 1) {
                  this.exitCodeBlock(-1);
                  return true;
                }
                return false;
              }
            },
            {
              // 在开头按 ← 跳出到代码块上方
              key: 'ArrowLeft',
              run: cmView => {
                const { main } = cmView.state.selection;
                if (main.head === 0 && main.empty) {
                  this.exitCodeBlock(-1);
                  return true;
                }
                return false;
              }
            },
            {
              // 在开头/末尾按 → 分别跳出代码块上/下方
              key: 'ArrowRight',
              run: cmView => {
                const { state } = cmView;
                const { main } = state.selection;
                if (main.head === 0 && main.empty) {
                  this.exitCodeBlock(-1);
                  return true;
                }
                if (main.head === state.doc.length && main.empty) {
                  this.exitCodeBlock(1);
                  return true;
                }
                return false;
              }
            },
            {
              // 空代码块按 Backspace 删除整个代码块
              key: 'Backspace',
              run: cmView => {
                if (cmView.state.doc.length === 0) {
                  this.deleteCodeBlock();
                  return true;
                }
                return false;
              }
            },
            ...defaultKeymap,
            ...historyKeymap
          ]),
          createThemeExtension(),
          this.languageCompartment.of([]),
          lineNumbers(),
          EditorView.updateListener.of(update => this.onCMUpdate(update)),
          EditorView.domEventHandlers({
            focus: () => this.forwardSelection()
          })
        ]
      }),
      parent: this.editorContainer
    });
  }

  private renderReadonlyCode(): void {
    this.editorContainer.replaceChildren();

    // 局部常量 pre：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
    const pre = document.createElement('pre');
    pre.className = 'steno-code-block-readonly';
    // 局部常量 code：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
    const code = document.createElement('code');

    // 局部常量 lines：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
    const lines = this.node.textContent.split('\n');
    // 局部常量 visibleLines：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
    const visibleLines = lines.length > 0 ? lines : [''];
    for (const line of visibleLines) {
      // 局部常量 row：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
      const row = document.createElement('span');
      row.className = 'steno-code-block-line';

      // 局部常量 content：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
      const content = document.createElement('span');
      content.className = 'steno-code-block-line-content';
      content.textContent = line || ' ';
      row.appendChild(content);
      code.appendChild(row);
    }

    pre.appendChild(code);
    this.editorContainer.appendChild(pre);
    this.readonlyElement = pre;
  }

  /** 复制按钮：把代码块的完整 Markdown 写入剪贴板，点击后短暂提示「已复制」。 */
  private createCopyButton(): HTMLButtonElement {
    // 局部常量 copyBtn：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
    const copyBtn = document.createElement('button');
    copyBtn.className = 'steno-code-block-copy-btn';
    copyBtn.type = 'button';
    copyBtn.title = '复制代码块';
    copyBtn.textContent = '复制';
    copyBtn.addEventListener('click', e => {
      e.stopPropagation();
      void this.copyCodeBlock();
      copyBtn.classList.add('copied');
      copyBtn.textContent = '已复制';
      setTimeout(() => {
        copyBtn.classList.remove('copied');
        copyBtn.textContent = '复制';
      }, 1500);
    });
    return copyBtn;
  }

  /** 代码块完整 Markdown（含围栏，移植自 PureMark getCodeBlockMarkdown）。 */
  private getCodeBlockMarkdown(): string {
    const language: string = this.node.attrs.language ?? '';
    // 局部常量 content：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
    const content = this.cm?.state.doc.toString() ?? this.node.textContent;
    return `\`\`\`${language}\n${content}\n\`\`\``;
  }

  /** 写入剪贴板（容错：jsdom / 非安全上下文下 clipboard 可能缺失）。 */
  private async copyCodeBlock(): Promise<void> {
    try {
      await navigator.clipboard?.writeText(this.getCodeBlockMarkdown());
    } catch {
      // 剪贴板不可用时静默失败，不影响编辑
    }
  }

  /**
   * 动态加载语言扩展并 reconfigure 进 CM。
   *
   * 用 token 防竞态：发起加载前记下目标语言，await 完成后若 token 已变（语言又被改了），
   * 则丢弃本次结果。
   */
  private async loadLanguage(language: string): Promise<void> {
    // 函数式常量 token：以闭包形式组织逻辑，便于在组件、store 或测试中传递。
    const token = (language ?? '').trim();
    this.loadedLanguageToken = token;
    // 局部常量 desc：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
    const desc = matchLanguageDescription(token);
    if (!desc) {
      // 无匹配语言：清空语言扩展
      this.cm?.dispatch({ effects: this.languageCompartment.reconfigure([]) });
      return;
    }
    try {
      // 局部常量 support：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
      const support = await desc.load();
      if (this.loadedLanguageToken !== token) return; // 已被后续切换覆盖
      this.cm?.dispatch({ effects: this.languageCompartment.reconfigure(support) });
    } catch {
      // 语言包加载失败（如对应 lang-* 未安装），降级为无高亮，不抛错
      if (this.loadedLanguageToken === token) {
        this.cm?.dispatch({ effects: this.languageCompartment.reconfigure([]) });
      }
    }
  }

  /**
   * CodeMirror 文档变更回写 ProseMirror（移植自 PureMark onCMUpdate）。
   */
  private onCMUpdate(update: ViewUpdate): void {
    if (this.updating) return;
    // 选区变化（无文档变更）也要前向同步，保证外层 selection 跟随 CM 光标
    if (!update.docChanged) {
      if (update.selectionSet && this.cm?.hasFocus) this.forwardSelection();
      return;
    }

    // 局部常量 pos：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
    const pos = this.getPos();
    if (pos === undefined) return;

    // 局部常量 newText：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
    const newText = update.state.doc.toString();
    // 局部常量 tr：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
    const tr = this.view.state.tr;
    // 局部常量 start：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
    const start = pos + 1;
    // 局部常量 end：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
    const end = pos + 1 + this.node.content.size;
    tr.replaceWith(start, end, newText ? this.view.state.schema.text(newText) : []);
    this.view.dispatch(tr);
  }

  /**
   * 把 CM 选区转发到 ProseMirror（移植自 PureMark forwardSelection）。
   * CM 偏移 + (pos + 1) 即 PM 文档坐标。
   */
  private forwardSelection(): void {
    if (!this.cm) return;
    // 局部常量 pos：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
    const pos = this.getPos();
    if (pos === undefined) return;

    const { from, to } = this.cm.state.selection.main;
    // 局部常量 start：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
    const start = pos + 1 + from;
    // 局部常量 end：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
    const end = pos + 1 + to;
    // 局部常量 selection：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
    const selection = TextSelection.create(this.view.state.doc, start, end);

    if (!this.view.state.selection.eq(selection)) {
      this.view.dispatch(this.view.state.tr.setSelection(selection));
    }
  }

  /**
   * 跳出代码块（移植自 PureMark exitCodeBlock）。
   * direction=1 向下、-1 向上；若目标侧没有可落点则插入空段落。
   */
  private exitCodeBlock(direction: 1 | -1): void {
    // 局部常量 pos：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
    const pos = this.getPos();
    if (pos === undefined) return;

    const { state } = this.view;
    // 局部常量 nodeEnd：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
    const nodeEnd = pos + this.node.nodeSize;

    if (direction === 1) {
      // 局部常量 isLastNode：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
      const isLastNode = nodeEnd >= state.doc.content.size;
      if (isLastNode) {
        // 局部常量 paragraph：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
        const paragraph = state.schema.nodes.paragraph.create();
        // 局部常量 tr：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
        const tr = state.tr.insert(nodeEnd, paragraph);
        tr.setSelection(TextSelection.create(tr.doc, nodeEnd + 1));
        this.view.dispatch(tr);
        this.view.focus();
        return;
      }
      // 局部常量 selection：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
      const selection = Selection.near(state.doc.resolve(nodeEnd), 1);
      this.view.dispatch(state.tr.setSelection(selection));
      this.view.focus();
    } else {
      // 局部常量 selection：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
      const selection = Selection.near(state.doc.resolve(pos), -1);
      // 前方无可用位置则在代码块前插入段落
      if (selection.from >= pos) {
        // 局部常量 paragraph：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
        const paragraph = state.schema.nodes.paragraph.create();
        // 局部常量 tr：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
        const tr = state.tr.insert(pos, paragraph);
        tr.setSelection(TextSelection.create(tr.doc, pos + 1));
        this.view.dispatch(tr);
        this.view.focus();
        return;
      }
      this.view.dispatch(state.tr.setSelection(selection));
      this.view.focus();
    }
  }

  /**
   * 在列表中跳出代码块并创建新列表项（移植自 PureMark exitCodeBlockAndCreateListItem）。
   */
  private exitCodeBlockAndCreateListItem(): void {
    // 局部常量 pos：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
    const pos = this.getPos();
    if (pos === undefined) return;

    const { state } = this.view;
    const $pos = state.doc.resolve(pos);

    let listItemDepth = -1;
    for (let d = $pos.depth; d > 0; d--) {
      // 局部常量 ancestor：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
      const ancestor = $pos.node(d);
      if (ancestor.type.name === 'list_item' || ancestor.type.name === 'task_item') {
        listItemDepth = d;
        break;
      }
    }
    if (listItemDepth === -1) {
      this.exitCodeBlock(1);
      return;
    }

    // 局部常量 listItemAfter：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
    const listItemAfter = $pos.after(listItemDepth);
    // 局部常量 newListItem：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
    const newListItem = state.schema.nodes.list_item.create(null, state.schema.nodes.paragraph.create());

    // 局部常量 tr：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
    const tr = state.tr;
    tr.insert(listItemAfter, newListItem);
    tr.setSelection(TextSelection.create(tr.doc, listItemAfter + 2));
    this.view.dispatch(tr);
    this.view.focus();
  }

  /**
   * 删除整个代码块（移植自 PureMark deleteCodeBlock）。
   */
  private deleteCodeBlock(): void {
    // 局部常量 pos：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
    const pos = this.getPos();
    if (pos === undefined) return;

    const { state } = this.view;
    // 局部常量 nodeEnd：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
    const nodeEnd = pos + this.node.nodeSize;
    // 局部常量 tr：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
    const tr = state.tr.delete(pos, nodeEnd);

    if (tr.doc.content.size === 0) {
      // 局部常量 paragraph：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
      const paragraph = state.schema.nodes.paragraph.create();
      tr.insert(0, paragraph);
      tr.setSelection(TextSelection.create(tr.doc, 1));
    } else {
      const $pos = tr.doc.resolve(Math.min(pos, tr.doc.content.size));
      tr.setSelection(Selection.near($pos, -1));
    }

    this.view.dispatch(tr);
    this.view.focus();
  }

  /**
   * ProseMirror 节点更新（移植自 PureMark update）。
   * 文档变更同步进 CM（updating 标记防回环），语言变更触发重新加载语言扩展。
   */
  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.node.type) return false;

    const prevLanguage: string = this.node.attrs.language ?? '';
    // 局部常量 prevText：上一版本源码，用于判断 mermaid 是否需要重渲染。
    const prevText = this.node.textContent;
    this.node = node;
    // 局部常量 newText：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
    const newText = node.textContent;
    const language: string = node.attrs.language ?? '';
    // 局部常量 isMermaid：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
    const isMermaid = language.toLowerCase() === 'mermaid';

    if (this.cm && newText !== this.cm.state.doc.toString()) {
      this.updating = true;
      this.cm.dispatch({
        changes: { from: 0, to: this.cm.state.doc.length, insert: newText }
      });
      this.updating = false;
    } else if (!this.cm && !isMermaid) {
      // 只读态非 mermaid：渲染静态代码（mermaid 只读态由下方图表预览处理）
      this.renderReadonlyCode();
    }

    if (language !== prevLanguage) {
      this.syncLanguageLabel(language);
      if (this.cm) void this.loadLanguage(language);
      // 语言切换：同步 mermaid 模式选择器 + 图表预览的存在性（进入 mermaid 时一并渲染）
      this.syncMermaidControls(language);
    } else if (isMermaid && newText !== prevText) {
      // 语言不变、源码改变（含只读态）：用新源码重渲染图表
      this.createMermaidPreview(newText);
    }

    return true;
  }

  /**
   * ProseMirror→CodeMirror 选区同步（移植自 PureMark setSelection）。
   * PM 在选区进入本节点时调用，anchor/head 为相对 CM 文档的偏移。
   */
  setSelection(anchor: number, head: number): void {
    if (!this.cm) return;
    this.cm.focus();
    this.updating = true;
    this.cm.dispatch({ selection: { anchor, head } });
    this.updating = false;
  }

  /** 节点被选中时把焦点交给 CM（移植自 PureMark selectNode）。 */
  selectNode(): void {
    this.cm?.focus();
  }

  /**
   * 阻止事件冒泡给 PM（移植自 PureMark stopEvent）。
   * 头部区域（语言标签 / 复制按钮）的事件放行，其余（CM 内编辑）由 CM 自行处理。
   * 返回 true 让 PM 忽略该事件，从而把编辑控制权完全交给内嵌 CM——
   * 这也是保证 IME（compositionstart/end）在 CM 内正常工作的关键。
   */
  stopEvent(event: Event): boolean {
    if (event.target instanceof HTMLElement) {
      // 局部常量 isInHeader：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
      const isInHeader = event.target.closest('.steno-code-block-header');
      if (isInHeader) return false;
    }
    return true;
  }

  /** 忽略 CM 自身对 DOM 的 mutation，避免 PM 误判（移植自 PureMark ignoreMutation）。 */
  ignoreMutation(): boolean {
    return true;
  }

  /** 销毁内嵌 CM、下拉外部监听、主题观察器与图表预览（移植自 PureMark destroy）。 */
  destroy(): void {
    for (const handler of this.outsideHandlers) {
      document.removeEventListener('click', handler);
    }
    this.outsideHandlers = [];
    if (this.themeObserver) {
      this.themeObserver.disconnect();
      this.themeObserver = null;
    }
    if (this.mermaidPreview) {
      this.mermaidPreview.remove();
      this.mermaidPreview = null;
    }
    this.cm?.destroy();
  }
}

/**
 * 创建代码块 NodeView 工厂函数。
 * 签名与同目录 image / math-block 等保持一致。
 */
export function createCodeBlockNodeView(
  node: ProseMirrorNode,
  view: ProseMirrorView,
  getPos: () => number | undefined
): NodeView {
  return new CodeBlockView(node, view, getPos);
}
