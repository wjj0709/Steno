/**
 * @file HTML 图片工具
 *
 * 移植自 PureMark `src/core/utils/html-image.ts`。负责解析单行 `<img>` HTML 标签为
 * 安全的图片属性，供 syntax-detector 插件在文档变更后把段落中的 `<img>` 写法转换为
 * image 节点。
 *
 * Steno 适配说明：
 * - 仅移植 `parseHtmlImageSource`（syntax-detector 所需）。PureMark 的
 *   `buildImageSourceText`（serializer 重建源码用）暂不需要，未移植。
 */

/** 从 HTML `<img>` 标签解析得到的图片信息 */
export interface ParsedHtmlImage {
  src: string;
  alt: string;
  title: string;
  htmlSource: string;
}

const DANGEROUS_URL_RE = /^\s*(javascript|vbscript|data)\s*:/i;
const HTML_IMAGE_RE = /^<img(?:\s(?:[^>"']|"[^"]*"|'[^']*')*)?\s*\/?>$/i;
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>/]+)))?/g;

/**
 * 解析单行 `<img>` HTML 标签为图片信息。
 * 会校验整行是否为合法的 `<img>` 标签，并过滤 javascript/vbscript/data 等危险 URL 协议。
 * @param source 待解析的源码行
 * @returns 解析出的图片信息；若不是合法 `<img>` 或 src 危险/缺失则返回 null
 */
export function parseHtmlImageSource(source: string): ParsedHtmlImage | null {
  // 局部常量 htmlSource：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
  const htmlSource = source.trim();
  if (!HTML_IMAGE_RE.test(htmlSource)) return null;

  // 局部常量 attrs：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
  const attrs: Record<string, string> = {};
  // 局部常量 attrSource：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
  const attrSource = htmlSource.replace(/^<img/i, '').replace(/\s*\/?>$/i, '');
  let match: RegExpExecArray | null;
  while ((match = ATTR_RE.exec(attrSource)) !== null) {
    attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
  }

  // 局部常量 src：缓存当前流程的中间结果，避免后续逻辑重复计算或重复读取状态。
  const src = attrs.src || '';
  if (!src || DANGEROUS_URL_RE.test(src)) return null;

  return {
    src,
    alt: attrs.alt || '',
    title: attrs.title || '',
    htmlSource
  };
}
