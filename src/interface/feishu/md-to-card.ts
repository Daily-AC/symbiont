/**
 * 构建飞书卡片 v2 的 elements 数组。
 *
 * v2 的 markdown 组件原生支持：# 标题、- 列表、``` 代码块、> 引用、| 表格、`行内代码` 等。
 * 此函数只做飞书不支持的少量转换：
 * - 图片 ![alt](url) → [图片: alt](url)（飞书需要 image_key，普通 URL 不支持）
 * - 复选框 - [x] / - [ ] → emoji
 */
export function markdownToCardElements(markdown: string): Array<Record<string, unknown>> {
  const content = transformForFeishu(markdown)
  if (!content.trim()) return [{ tag: 'markdown', content: ' ' }]
  return [{ tag: 'markdown', content }]
}

/**
 * 构建 v2 卡片 JSON。
 */
export function buildCardV2(markdown: string, options?: { title?: string }): Record<string, unknown> {
  const elements = markdownToCardElements(markdown)
  const card: Record<string, unknown> = {
    schema: '2.0',
    body: { elements },
  }
  if (options?.title) {
    card.header = {
      title: { tag: 'plain_text', content: options.title },
      template: 'blue',
    }
  }
  return card
}

/**
 * 对原始 markdown 做飞书特有的转换（尽量少改，v2 原生支持大部分语法）。
 */
function transformForFeishu(markdown: string): string {
  return markdown
    // 图片语法 ![alt](url) → [图片: alt](url)（飞书需要 image_key，不支持外部 URL）
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt: string, url: string) => {
      const label = alt ? `图片: ${alt}` : '图片'
      return `[${label}](${url})`
    })
    // 复选框
    .replace(/- \[x\]/gi, '- ✅')
    .replace(/- \[ \]/g, '- ⬜')
}
