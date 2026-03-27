import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { markdownToCardElements, buildCardV2 } from '../src/interface/feishu/md-to-card.ts'
import { parsePostContent } from '../src/interface/feishu/post.ts'

describe('markdownToCardElements (v2)', () => {
  function getContent(elements: Array<Record<string, unknown>>): string {
    return (elements[0] as any).content ?? ''
  }

  test('plain text returns single markdown element', () => {
    const elements = markdownToCardElements('hello world')
    assert.equal(elements.length, 1)
    assert.equal((elements[0] as any).tag, 'markdown')
    assert.equal(getContent(elements), 'hello world')
  })

  test('headings preserved as-is (v2 supports # natively)', () => {
    const elements = markdownToCardElements('# 标题一\n\n## 二级\n\n### 三级')
    const content = getContent(elements)
    assert.ok(content.includes('# 标题一'))
    assert.ok(content.includes('## 二级'))
    assert.ok(content.includes('### 三级'))
  })

  test('code blocks preserved as-is', () => {
    const md = '前文\n```typescript\nconst x = 1\n```\n后文'
    const content = getContent(markdownToCardElements(md))
    assert.ok(content.includes('```typescript'))
    assert.ok(content.includes('const x = 1'))
  })

  test('blockquotes preserved as-is (v2 supports > natively)', () => {
    const md = '> 这是引用内容\n> 第二行引用'
    const content = getContent(markdownToCardElements(md))
    assert.ok(content.includes('> 这是引用内容'))
    assert.ok(content.includes('> 第二行引用'))
  })

  test('tables preserved as-is (v2 supports | natively)', () => {
    const md = '| 名称 | 值 |\n|------|----|\n| foo | 1 |'
    const content = getContent(markdownToCardElements(md))
    assert.ok(content.includes('| 名称 | 值 |'))
    assert.ok(content.includes('| foo | 1 |'))
  })

  test('lists preserved as-is', () => {
    const md = '- 第一项\n- 第二项\n1. 有序一\n2. 有序二'
    const content = getContent(markdownToCardElements(md))
    assert.ok(content.includes('- 第一项'))
    assert.ok(content.includes('1. 有序一'))
  })

  test('inline code preserved as-is', () => {
    const md = '使用 `npm install` 安装'
    const content = getContent(markdownToCardElements(md))
    assert.ok(content.includes('`npm install`'))
  })

  // --- Feishu-specific transforms ---

  test('image ![alt](url) converted to link', () => {
    const md = '看这张图 ![示意图](https://example.com/img.png) 说明'
    const content = getContent(markdownToCardElements(md))
    assert.ok(content.includes('[图片: 示意图](https://example.com/img.png)'))
    assert.ok(!content.includes('!['))
  })

  test('image with empty alt text', () => {
    const md = '![](https://example.com/img.png)'
    const content = getContent(markdownToCardElements(md))
    assert.ok(content.includes('[图片](https://example.com/img.png)'))
  })

  test('checked checkbox - [x] becomes ✅', () => {
    const content = getContent(markdownToCardElements('- [x] 已完成任务'))
    assert.ok(content.includes('- ✅ 已完成任务'))
    assert.ok(!content.includes('[x]'))
  })

  test('unchecked checkbox - [ ] becomes ⬜', () => {
    const content = getContent(markdownToCardElements('- [ ] 待办事项'))
    assert.ok(content.includes('- ⬜ 待办事项'))
  })

  test('mixed checkboxes', () => {
    const content = getContent(markdownToCardElements('- [x] done\n- [ ] todo\n- [X] also done'))
    assert.ok(content.includes('- ✅ done'))
    assert.ok(content.includes('- ⬜ todo'))
    assert.ok(content.includes('- ✅ also done'))
  })

  test('empty input returns space element', () => {
    const elements = markdownToCardElements('')
    assert.equal(elements.length, 1)
    assert.equal((elements[0] as any).tag, 'markdown')
  })
})

describe('buildCardV2', () => {
  test('produces v2 card structure with schema 2.0', () => {
    const card = buildCardV2('hello')
    assert.equal(card.schema, '2.0')
    assert.ok(card.body)
    const body = card.body as { elements: any[] }
    assert.ok(body.elements.length >= 1)
    assert.equal(body.elements[0].tag, 'markdown')
  })

  test('includes header when title provided', () => {
    const card = buildCardV2('content', { title: '标题' })
    const header = card.header as any
    assert.ok(header)
    assert.equal(header.title.content, '标题')
    assert.equal(header.template, 'blue')
  })

  test('no header when title not provided', () => {
    const card = buildCardV2('content')
    assert.equal(card.header, undefined)
  })

  test('complex real-world markdown preserved for v2 native rendering', () => {
    const md = `# 部署报告

## 状态
- [x] 构建完成
- [ ] 测试中

> 注意：需要手动确认

![截图](https://img.example.com/screenshot.png)

\`\`\`bash
docker compose up -d
\`\`\`

| 服务 | 状态 |
|------|------|
| web | ✅ |

### 详情
普通正文。`

    const card = buildCardV2(md)
    assert.equal(card.schema, '2.0')
    const body = card.body as { elements: any[] }
    const content = body.elements[0].content

    // v2 native markdown — headings, lists, code, tables, quotes all preserved
    assert.ok(content.includes('# 部署报告'))
    assert.ok(content.includes('## 状态'))
    assert.ok(content.includes('- ✅ 构建完成'))
    assert.ok(content.includes('- ⬜ 测试中'))
    assert.ok(content.includes('> 注意'))
    assert.ok(content.includes('[图片: 截图]'))
    assert.ok(content.includes('```bash'))
    assert.ok(content.includes('| 服务 | 状态 |'))
    assert.ok(content.includes('### 详情'))
  })
})

describe('parsePostContent', () => {
  test('extracts text from post content', async () => {
    const content = JSON.stringify({
      title: '测试标题',
      content: [
        [{ tag: 'text', text: 'hello ' }, { tag: 'text', text: 'world' }],
        [{ tag: 'a', text: 'link', href: 'https://example.com' }],
      ]
    })
    const result = await parsePostContent(content)
    assert.ok(result.includes('**测试标题**'))
    assert.ok(result.includes('hello world'))
    assert.ok(result.includes('[link](https://example.com)'))
  })

  test('image element without messageId falls back to [图片]', async () => {
    const content = JSON.stringify({
      content: [
        [{ tag: 'text', text: '看这个 ' }, { tag: 'img', image_key: 'img_key_123' }],
      ]
    })
    const result = await parsePostContent(content)
    assert.ok(result.includes('看这个'))
    assert.ok(result.includes('[图片]'))
  })

  test('handles zh_cn locale post content', async () => {
    const content = JSON.stringify({
      zh_cn: {
        title: '中文标题',
        content: [
          [{ tag: 'text', text: '内容' }],
        ]
      }
    })
    const result = await parsePostContent(content)
    assert.ok(result.includes('**中文标题**'))
    assert.ok(result.includes('内容'))
  })

  test('invalid JSON returns raw content', async () => {
    const result = await parsePostContent('not json')
    assert.equal(result, 'not json')
  })
})
