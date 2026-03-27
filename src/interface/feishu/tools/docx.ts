import type * as Lark from '@larksuiteoapi/node-sdk'
import { getClient } from '../client.ts'

// ============ Helpers ============

const BLOCK_TYPE_NAMES: Record<number, string> = {
  1: 'Page', 2: 'Text', 3: 'Heading1', 4: 'Heading2', 5: 'Heading3',
  12: 'Bullet', 13: 'Ordered', 14: 'Code', 15: 'Quote', 17: 'Todo',
  22: 'Divider', 27: 'Image', 31: 'Table', 32: 'TableCell',
}

// Block types that cannot be created via documentBlockChildren.create API
const UNSUPPORTED_CREATE_TYPES = new Set([31, 32])

const STRUCTURED_BLOCK_TYPES = new Set([14, 18, 21, 23, 27, 30, 31, 32])

// deno-lint-ignore no-explicit-any
function cleanBlocksForInsert(blocks: any[]): { cleaned: any[]; skipped: string[] } {
  const skipped: string[] = []
  const cleaned = blocks.filter((block) => {
    if (UNSUPPORTED_CREATE_TYPES.has(block.block_type)) {
      skipped.push(BLOCK_TYPE_NAMES[block.block_type] || `type_${block.block_type}`)
      return false
    }
    return true
  })
  return { cleaned, skipped }
}

// deno-lint-ignore no-explicit-any
function sortBlocksByFirstLevel(blocks: any[], firstLevelIds: string[]): any[] {
  if (!firstLevelIds || firstLevelIds.length === 0) return blocks
  const sorted = firstLevelIds.map((id) => blocks.find((b) => b.block_id === id)).filter(Boolean)
  const sortedIds = new Set(firstLevelIds)
  const remaining = blocks.filter((b) => !sortedIds.has(b.block_id))
  return [...sorted, ...remaining]
}

/** Split markdown into chunks at top-level headings to stay within API content limits */
function splitMarkdownByHeadings(markdown: string): string[] {
  const lines = markdown.split('\n')
  const chunks: string[] = []
  let current: string[] = []
  let inFencedBlock = false

  for (const line of lines) {
    if (/^(`{3,}|~{3,})/.test(line)) inFencedBlock = !inFencedBlock
    if (!inFencedBlock && /^#{1,2}\s/.test(line) && current.length > 0) {
      chunks.push(current.join('\n'))
      current = []
    }
    current.push(line)
  }
  if (current.length > 0) chunks.push(current.join('\n'))
  return chunks
}

/** Split markdown by size, preferring to break outside fenced code blocks */
function splitMarkdownBySize(markdown: string, maxChars: number): string[] {
  if (markdown.length <= maxChars) return [markdown]

  const lines = markdown.split('\n')
  const chunks: string[] = []
  let current: string[] = []
  let currentLength = 0
  let inFencedBlock = false

  for (const line of lines) {
    if (/^(`{3,}|~{3,})/.test(line)) inFencedBlock = !inFencedBlock
    const lineLength = line.length + 1
    if (current.length > 0 && currentLength + lineLength > maxChars && !inFencedBlock) {
      chunks.push(current.join('\n'))
      current = []
      currentLength = 0
    }
    current.push(line)
    currentLength += lineLength
  }
  if (current.length > 0) chunks.push(current.join('\n'))
  if (chunks.length > 1) return chunks

  const midpoint = Math.floor(lines.length / 2)
  if (midpoint <= 0 || midpoint >= lines.length) return [markdown]
  return [lines.slice(0, midpoint).join('\n'), lines.slice(midpoint).join('\n')]
}

// ============ Core Functions ============

const MAX_CONVERT_RETRY_DEPTH = 8

async function convertMarkdown(client: Lark.Client, markdown: string) {
  // deno-lint-ignore no-explicit-any
  const res = await (client.docx.document as any).convert({
    data: { content_type: 'markdown', content: markdown },
  })
  if (res.code !== 0) throw new Error(res.msg)
  return {
    blocks: res.data?.blocks ?? [],
    firstLevelBlockIds: res.data?.first_level_block_ids ?? [],
  }
}

async function convertMarkdownWithFallback(
  client: Lark.Client, markdown: string, depth = 0,
  // deno-lint-ignore no-explicit-any
): Promise<{ blocks: any[]; firstLevelBlockIds: string[] }> {
  try {
    return await convertMarkdown(client, markdown)
  } catch (error) {
    if (depth >= MAX_CONVERT_RETRY_DEPTH || markdown.length < 2) throw error
    const splitTarget = Math.max(256, Math.floor(markdown.length / 2))
    const chunks = splitMarkdownBySize(markdown, splitTarget)
    if (chunks.length <= 1) throw error

    // deno-lint-ignore no-explicit-any
    const blocks: any[] = []
    const firstLevelBlockIds: string[] = []
    for (const chunk of chunks) {
      const converted = await convertMarkdownWithFallback(client, chunk, depth + 1)
      blocks.push(...converted.blocks)
      firstLevelBlockIds.push(...converted.firstLevelBlockIds)
    }
    return { blocks, firstLevelBlockIds }
  }
}

async function chunkedConvertMarkdown(client: Lark.Client, markdown: string) {
  const chunks = splitMarkdownByHeadings(markdown)
  // deno-lint-ignore no-explicit-any
  const allBlocks: any[] = []
  const allFirstLevelBlockIds: string[] = []
  for (const chunk of chunks) {
    const { blocks, firstLevelBlockIds } = await convertMarkdownWithFallback(client, chunk)
    const sorted = sortBlocksByFirstLevel(blocks, firstLevelBlockIds)
    allBlocks.push(...sorted)
    allFirstLevelBlockIds.push(...firstLevelBlockIds)
  }
  return { blocks: allBlocks, firstLevelBlockIds: allFirstLevelBlockIds }
}

// ============ Exported Functions ============

/**
 * Create a new document.
 */
export async function createDoc(
  title: string,
  folderToken?: string,
): Promise<{ documentId: string; url: string; title: string }> {
  const client = getClient()
  const res = await client.docx.document.create({
    data: { title, folder_token: folderToken },
  })
  if (res.code !== 0) throw new Error(res.msg)
  const doc = res.data?.document
  const docId = doc?.document_id
  if (!docId) throw new Error('Document creation succeeded but no document_id returned')
  return {
    documentId: docId,
    url: `https://feishu.cn/docx/${docId}`,
    title: doc?.title ?? title,
  }
}

/**
 * Read a document's content.
 */
export async function readDoc(documentId: string): Promise<{
  title: string | undefined
  content: string | undefined
  revisionId: number | undefined
  blockCount: number
  blockTypes: Record<string, number>
  hint?: string
}> {
  const client = getClient()
  const [contentRes, infoRes, blocksRes] = await Promise.all([
    client.docx.document.rawContent({ path: { document_id: documentId } }),
    client.docx.document.get({ path: { document_id: documentId } }),
    client.docx.documentBlock.list({ path: { document_id: documentId } }),
  ])
  if (contentRes.code !== 0) throw new Error(contentRes.msg)

  const blocks = blocksRes.data?.items ?? []
  const blockCounts: Record<string, number> = {}
  const structuredTypes: string[] = []

  for (const b of blocks) {
    const type = b.block_type ?? 0
    const name = BLOCK_TYPE_NAMES[type] || `type_${type}`
    blockCounts[name] = (blockCounts[name] || 0) + 1
    if (STRUCTURED_BLOCK_TYPES.has(type) && !structuredTypes.includes(name)) {
      structuredTypes.push(name)
    }
  }

  let hint: string | undefined
  if (structuredTypes.length > 0) {
    hint = `Document contains ${structuredTypes.join(', ')} blocks not included in plain text.`
  }

  return {
    title: infoRes.data?.document?.title,
    content: contentRes.data?.content,
    revisionId: infoRes.data?.document?.revision_id,
    blockCount: blocks.length,
    blockTypes: blockCounts,
    ...(hint && { hint }),
  }
}

/**
 * Insert markdown content as blocks into a document.
 * Uses the Descendant API for reliable ordering.
 */
export async function insertBlocks(
  documentId: string,
  markdown: string,
  parentBlockId?: string,
): Promise<{ blocksAdded: number; blockIds: string[] }> {
  const client = getClient()
  const { blocks, firstLevelBlockIds } = await chunkedConvertMarkdown(client, markdown)
  if (blocks.length === 0) throw new Error('Content is empty')

  const sortedBlocks = sortBlocksByFirstLevel(blocks, firstLevelBlockIds)

  // deno-lint-ignore no-explicit-any
  const descendants = sortedBlocks.map((b: any) => {
    const { block_id, ...rest } = b
    return rest
  })

  const blockId = parentBlockId ?? documentId

  // Try Descendant API first (supports tables)
  try {
    const res = await client.docx.documentBlockDescendant.create({
      path: { document_id: documentId, block_id: blockId },
      data: { children_id: firstLevelBlockIds, descendants, index: -1 },
    })
    if (res.code !== 0) throw new Error(`${res.msg} (code: ${res.code})`)
    // deno-lint-ignore no-explicit-any
    const children = res.data?.children ?? [] as any[]
    return {
      blocksAdded: blocks.length,
      // deno-lint-ignore no-explicit-any
      blockIds: children.map((c: any) => c.block_id).filter(Boolean),
    }
  } catch {
    // Fallback: insert blocks one at a time via Children API
    const { cleaned, skipped: _skipped } = cleanBlocksForInsert(sortedBlocks)
    // deno-lint-ignore no-explicit-any
    const allInserted: any[] = []
    for (const block of cleaned) {
      const res = await client.docx.documentBlockChildren.create({
        path: { document_id: documentId, block_id: blockId },
        data: { children: [block] },
      })
      if (res.code !== 0) throw new Error(res.msg)
      allInserted.push(...(res.data?.children ?? []))
    }
    return {
      blocksAdded: allInserted.length,
      // deno-lint-ignore no-explicit-any
      blockIds: allInserted.map((c: any) => c.block_id).filter(Boolean),
    }
  }
}

/**
 * Convert markdown to feishu block format (preview without inserting).
 */
export async function markdownToBlocks(
  markdown: string,
  // deno-lint-ignore no-explicit-any
): Promise<{ blocks: any[]; firstLevelBlockIds: string[] }> {
  const client = getClient()
  return chunkedConvertMarkdown(client, markdown)
}
