import { downloadMessageResource } from './media.ts'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

export interface ParsePostOptions {
  /** The message_id, needed to download embedded images */
  messageId?: string
}

export async function parsePostContent(content: string, options?: ParsePostOptions): Promise<string> {
  try {
    const post = JSON.parse(content)
    const body = post.content ?? post.zh_cn?.content ?? post.en_us?.content ?? []
    const title = post.title ?? post.zh_cn?.title ?? ''

    const lines: string[] = []
    if (title) lines.push(`**${title}**`)

    for (const paragraph of body) {
      const parts: string[] = []
      for (const element of paragraph) {
        switch (element.tag) {
          case 'text':
            parts.push(element.text ?? '')
            break
          case 'a':
            parts.push(`[${element.text ?? ''}](${element.href ?? ''})`)
            break
          case 'at':
            parts.push(`@${element.user_name ?? element.user_id ?? ''}`)
            break
          case 'img': {
            const imageKey = element.image_key
            if (imageKey && options?.messageId) {
              try {
                const destDir = join(process.cwd(), 'data', 'downloads')
                mkdirSync(destDir, { recursive: true })
                const filePath = await downloadMessageResource(options.messageId, imageKey, 'image', destDir)
                parts.push(`[图片: ${filePath}]`)
              } catch (e) {
                console.error('[post] failed to download embedded image:', e)
                parts.push('[图片]')
              }
            } else {
              parts.push('[图片]')
            }
            break
          }
          case 'media':
            parts.push('[文件]')
            break
          default:
            parts.push(element.text ?? '')
        }
      }
      lines.push(parts.join(''))
    }

    return lines.join('\n')
  } catch {
    return content
  }
}
