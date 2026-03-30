import type { Router } from '../../core/router.ts'
import type { SessionMap } from './session-map.ts'
import type { Whitelist } from './whitelist.ts'
import type { MessageDedup } from './dedup.ts'
import { parsePostContent } from './post.ts'
import { isMentioningBot, removeBotMention } from './mention.ts'
import { addTypingIndicator, removeTypingIndicator } from './typing.ts'
import { downloadMessageResource } from './media.ts'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

export interface MessageHandlerDeps {
  router: Router
  sessionMap: SessionMap
  whitelist: Whitelist
  dedup: MessageDedup
  botId: string
  botName: string
  db?: import('../../memory/db.ts').MemoryDB
}

const MAX_CARD_LENGTH = 28000  // 飞书卡片约 30KB 限制，留余量

// v2 卡片被引用时飞书 API 返回降级内容，需要自己记录原文
// 存 MemoryDB (SQLite) 的 sent_cards 表，由外部通过 deps.db 注入
let _db: import('../../memory/db.ts').MemoryDB | undefined

async function sendReply(chatId: string, text: string, replyToMessageId?: string): Promise<void> {
  const { sendMarkdownCard, sendText } = await import('./send.ts')

  // 确保 \n 是真正的换行符（CC 有时输出字面 \\n）
  let content = text.replace(/\\n/g, '\n')
  if (content.length > MAX_CARD_LENGTH) {
    content = content.slice(0, MAX_CARD_LENGTH) + '\n\n... (消息过长，已截断)'
    console.warn('[feishu-handler] message truncated:', text.length, '→', content.length)
  }

  try {
    const msgId = await sendMarkdownCard(chatId, content, { replyToMessageId })
    // 存 DB，引用时可查
    if (msgId && _db) _db.saveSentCard(msgId, content)
  } catch (err) {
    console.warn('[feishu-handler] card send failed, fallback to text:', (err as Error).message?.slice(0, 100))
    try {
      const plainText = content.length > 4000 ? content.slice(0, 4000) + '\n... (已截断)' : content
      await sendText(chatId, plainText)
    } catch (err2) {
      console.error('[feishu-handler] text fallback also failed:', (err2 as Error).message?.slice(0, 100))
    }
  }
}

function buildSessionKey(chatId: string, chatType: string, threadId?: string): string {
  if (threadId) {
    return `topic:${chatId}:${threadId}`
  }
  return chatType === 'p2p' ? `dm:${chatId}` : `group:${chatId}`
}

/**
 * 解析 interactive（卡片）消息：提取 header.title + elements 中的文本。
 */
function parseInteractiveContent(raw: string): string {
  try {
    const card = JSON.parse(raw)
    const parts: string[] = []
    // Header title
    if (card.header?.title?.content) parts.push(card.header.title.content)
    // Elements: 飞书卡片 elements 可能是一维或二维数组
    // 一维: [{tag:"markdown", content:"..."}, ...]
    // 二维: [[{tag:"text", text:"..."}, ...], ...]  (旧版/简单卡片)
    const elements = card.elements ?? card.body?.elements ?? []
    function extractFromElement(el: any, depth = 0): void {
      if (depth > 10) return
      if (Array.isArray(el)) {
        for (const sub of el) extractFromElement(sub, depth + 1)
        return
      }
      if (el.tag === 'markdown' && el.content) {
        parts.push(el.content)
      } else if (el.tag === 'text') {
        if (typeof el.text === 'string') parts.push(el.text)
        else if (el.text?.content) parts.push(el.text.content)
      } else if (el.tag === 'div' && el.text?.content) {
        parts.push(el.text.content)
      } else if (el.tag === 'plain_text' && el.content) {
        parts.push(el.content)
      } else if (el.tag === 'column_set' && el.columns) {
        for (const col of el.columns) {
          if (col.elements) for (const sub of col.elements) extractFromElement(sub, depth + 1)
        }
      }
    }
    for (const el of elements) extractFromElement(el)
    if (parts.length > 0) return `[卡片] ${parts.join(' ')}`
    return '[卡片消息]'
  } catch {
    return '[卡片消息]'
  }
}

/**
 * 解析合并转发消息：调用 im.message.get 获取子消息列表，
 * 再逐条解析 sender + content，拼接为可读文本。
 */
async function parseMergeForward(messageId: string): Promise<string> {
  try {
    const { getClient } = await import('./client.ts')
    const client = getClient()

    const res: any = await client.im.message.get({
      path: { message_id: messageId },
    })

    const items: any[] = res?.data?.items ?? []
    // items[0] 是合并转发消息本身，后续是子消息
    const subMessages = items.filter(
      (item: any) => item.message_id !== messageId
    )

    if (subMessages.length === 0) {
      return '[合并转发消息，无法解析内容]'
    }

    // 批量获取发送者名字（去重，限制并发避免限流）
    // im.message.get 返回的子消息 sender 结构是 { id, id_type, sender_type }（不是 event 的 sender_id.open_id）
    const senderIds = [...new Set(subMessages.map((m: any) => m.sender?.id).filter(Boolean))]
    const senderNameMap = new Map<string, string>()
    // 每批 5 个，避免触发飞书 API 限流
    for (let i = 0; i < senderIds.length; i += 5) {
      const batch = senderIds.slice(i, i + 5)
      await Promise.all(
        batch.map(async (id: string) => {
          try {
            const userRes: any = await client.contact.user.get({
              path: { user_id: id },
              params: { user_id_type: 'open_id' },
            })
            const name = userRes?.data?.user?.name
            if (name) senderNameMap.set(id, name)
          } catch {
            // 获取名字失败，用 ID 前8位代替
          }
        })
      )
    }

    const lines: string[] = [`[合并转发消息，共 ${subMessages.length} 条]`]

    for (const sub of subMessages) {
      const senderId = sub.sender?.id ?? '未知'
      const senderName = senderNameMap.get(senderId) ?? senderId.slice(0, 8)
      const subType = sub.msg_type
      const rawContent = sub.body?.content ?? ''

      let contentText = ''
      switch (subType) {
        case 'text': {
          try {
            const parsed = JSON.parse(rawContent)
            contentText = parsed.text ?? rawContent
          } catch {
            contentText = rawContent
          }
          break
        }
        case 'post': {
          contentText = await parsePostContent(rawContent, { messageId: sub.message_id })
          break
        }
        case 'image': {
          try {
            const parsed = JSON.parse(rawContent)
            const imageKey = parsed.image_key
            if (imageKey) {
              const destDir = join(process.cwd(), 'data', 'downloads')
              mkdirSync(destDir, { recursive: true })
              const filePath = await downloadMessageResource(messageId, imageKey, 'image', destDir)
              contentText = `[图片: ${filePath}]`
            } else {
              contentText = '[图片]'
            }
          } catch (e) {
            console.error('[feishu-handler] failed to download image in merge_forward:', e)
            contentText = '[图片（下载失败）]'
          }
          break
        }
        case 'file': {
          try {
            const parsed = JSON.parse(rawContent)
            contentText = `[文件: ${parsed.file_name ?? '未知'}]`
          } catch {
            contentText = '[文件]'
          }
          break
        }
        case 'interactive': {
          contentText = parseInteractiveContent(rawContent)
          break
        }
        case 'merge_forward':
          contentText = '[嵌套合并转发]'
          break
        default:
          contentText = `[${subType ?? '未知类型'}]`
      }

      lines.push(`${senderName}: ${contentText}`)
    }

    return lines.join('\n')
  } catch (e) {
    console.error('[feishu-handler] failed to parse merge_forward:', e)
    return '[合并转发消息，无法解析内容]'
  }
}

export async function handleFeishuMessage(
  event: any,
  deps: MessageHandlerDeps
): Promise<void> {
  // 注入 DB 引用（用于 sent_cards 缓存）
  if (deps.db) _db = deps.db
  const msg = event?.message
  console.log('[feishu-handler] event received, msg:', msg ? 'yes' : 'no', 'type:', msg?.message_type, 'chat_type:', msg?.chat_type, 'parent_id:', msg?.parent_id, 'root_id:', msg?.root_id, 'upper_message_id:', msg?.upper_message_id, 'quote:', msg?.quote ? 'yes' : 'no')
  if (!msg) return

  const messageId = msg.message_id
  const chatId = msg.chat_id
  const chatType = msg.chat_type  // 'p2p' | 'group'
  const threadId = msg.thread_id  // 只用真正的 thread_id，root_id 是引用回复不是话题
  const rootMessageId = msg.root_id
  const senderId = event?.sender?.sender_id?.open_id

  // 1. Dedup
  if (deps.dedup.isDuplicate(messageId)) return

  // 2. Whitelist (group only, p2p always allowed)
  if (chatType === 'group' && !deps.whitelist.isAllowed(chatId)) return

  // 3. Mention check (group requires @bot, p2p doesn't)
  const mentions = msg.mentions?.map((m: any) => ({
    userId: m.id?.open_id ?? m.id?.user_id,
    name: m.name,
  }))
  if (chatType === 'group' && !isMentioningBot(mentions, deps.botId)) return

  // 4. Parse message content
  let text = ''
  const msgType = msg.message_type

  switch (msgType) {
    case 'text': {
      try {
        const content = JSON.parse(msg.content)
        text = content.text ?? ''
      } catch {
        text = msg.content ?? ''
      }
      break
    }
    case 'post': {
      text = await parsePostContent(msg.content, { messageId })
      break
    }
    case 'image': {
      try {
        const content = JSON.parse(msg.content)
        const imageKey = content.image_key
        if (imageKey) {
          const destDir = join(process.cwd(), 'data', 'downloads')
          mkdirSync(destDir, { recursive: true })
          const filePath = await downloadMessageResource(messageId, imageKey, 'image', destDir)
          text = `[用户发送了一张图片，已下载到: ${filePath}]`
        } else {
          text = '[用户发送了一张图片，但无法获取图片信息]'
        }
      } catch (e) {
        console.error('[feishu-handler] failed to download image:', e)
        text = '[用户发送了一张图片，但下载失败]'
      }
      break
    }
    case 'file': {
      try {
        const content = JSON.parse(msg.content)
        const fileKey = content.file_key
        const fileName = content.file_name ?? 'unknown'
        if (fileKey) {
          const destDir = join(process.cwd(), 'data', 'downloads')
          mkdirSync(destDir, { recursive: true })
          const filePath = await downloadMessageResource(messageId, fileKey, 'file', destDir, fileName)
          text = `[用户发送了文件「${fileName}」，已下载到: ${filePath}]`
        } else {
          text = '[用户发送了一个文件，但无法获取文件信息]'
        }
      } catch (e) {
        console.error('[feishu-handler] failed to download file:', e)
        text = '[用户发送了一个文件，但下载失败]'
      }
      break
    }
    case 'merge_forward': {
      text = await parseMergeForward(messageId)
      break
    }
    default:
      text = `[不支持的消息类型: ${msgType}]`
  }

  // Remove @bot mention from text
  if (chatType === 'group') {
    text = removeBotMention(text, deps.botName)
  }

  // -stop 指令：在引用拼接之前检查，避免引用文本干扰匹配
  if (text.trim() === '-stop') {
    const sessionKey = buildSessionKey(chatId, chatType, threadId)
    const interrupted = deps.router.interrupt(sessionKey)
    const { sendMarkdownCard } = await import('./send.ts')
    if (interrupted) {
      await sendMarkdownCard(chatId, '⏹ 已中断当前执行', { replyToMessageId: messageId })
    } else {
      await sendMarkdownCard(chatId, '当前没有正在执行的任务', { replyToMessageId: messageId })
    }
    return
  }

  // 处理引用消息：拉取被引用消息的内容，拼接到文本前面
  const parentMessageId = msg.parent_id || msg.upper_message_id
  if (parentMessageId) {
    try {
      const { getClient } = await import('./client.ts')
      const client = getClient()
      const parentRes: any = await client.im.message.get({
        path: { message_id: parentMessageId },
      })
      console.log('[feishu-handler] quote API response:', JSON.stringify(parentRes?.data).slice(0, 500))
      const parentMsg = parentRes?.data?.items?.[0]
      if (parentMsg) {
        const parentType = parentMsg.msg_type
        const parentContent = parentMsg.body?.content
        const parentMsgId = parentMsg.message_id ?? parentMessageId
        let parentText = ''

        if (parentType === 'image' && parentContent) {
          try {
            const parsed = JSON.parse(parentContent)
            const imageKey = parsed.image_key
            if (imageKey) {
              const destDir = join(process.cwd(), 'data', 'downloads')
              mkdirSync(destDir, { recursive: true })
              const filePath = await downloadMessageResource(parentMsgId, imageKey, 'image', destDir)
              parentText = `[引用了一张图片，已下载到: ${filePath}]`
            }
          } catch { parentText = '[引用了一张图片，但下载失败]' }
        } else if (parentType === 'file' && parentContent) {
          try {
            const parsed = JSON.parse(parentContent)
            const fileKey = parsed.file_key
            const fileName = parsed.file_name ?? 'unknown'
            if (fileKey) {
              const destDir = join(process.cwd(), 'data', 'downloads')
              mkdirSync(destDir, { recursive: true })
              const filePath = await downloadMessageResource(parentMsgId, fileKey, 'file', destDir, fileName)
              parentText = `[引用了文件「${fileName}」，已下载到: ${filePath}]`
            }
          } catch { parentText = '[引用了一个文件，但下载失败]' }
        } else if (parentType === 'post' && parentContent) {
          parentText = await parsePostContent(parentContent, { messageId: parentMsgId })
        } else if (parentType === 'text' && parentContent) {
          try {
            const parsed = JSON.parse(parentContent)
            parentText = parsed.text ?? ''
          } catch {
            parentText = parentContent
          }
        } else if (parentType === 'interactive' && parentContent) {
          // 先查 DB（v2 卡片被引用时 API 返回降级内容）
          const cached = _db?.lookupSentCard(parentMessageId)
          if (cached) {
            parentText = cached
          } else {
            parentText = parseInteractiveContent(parentContent)
          }
        } else if (parentType === 'merge_forward') {
          parentText = await parseMergeForward(parentMsgId)
        } else if (parentContent) {
          try {
            const parsed = JSON.parse(parentContent)
            parentText = parsed.text ?? parsed.title ?? `[${parentType ?? '未知'}类型消息]`
          } catch {
            parentText = `[${parentType ?? '未知'}类型消息]`
          }
        }

        if (parentText) {
          text = `[引用消息: "${parentText.slice(0, 500)}"]\n${text}`
          console.log('[feishu-handler] quote resolved:', parentText.slice(0, 100))
        }
      } else {
        console.log('[feishu-handler] quote: parent message not found (items empty)')
      }
    } catch (e) {
      console.error('[feishu-handler] failed to fetch quoted message:', e)
    }
  }

  console.log('[feishu-handler] parsed text:', JSON.stringify(text.slice(0, 100)), 'chatType:', chatType, 'senderId:', senderId)
  if (!text.trim()) return

  // 5. Build sessionKey
  const sessionKey = buildSessionKey(chatId, chatType, threadId)
  const role = threadId ? 'specialist' as const : 'main' as const

  // 6. Update session-map
  const existingMapping = deps.sessionMap.get(sessionKey)
  deps.sessionMap.set({
    ...existingMapping,
    sessionKey,
    chatId,
    chatType: chatType as 'p2p' | 'group',
    threadId,
    lastActive: new Date().toISOString(),
  })

  // 7. Register push handler for async worker results (always update to capture latest chatId/rootMessageId)
  // 话题 session 的 pushHandler 在话题创建时已设置（replyInThread），此处不覆盖
  if (!sessionKey.startsWith('topic:')) {
    deps.router.setPushHandlerFor(sessionKey, async (text: string) => {
      await sendReply(chatId, text, rootMessageId)
    })

  }

  // 8. 注册 textHandler — 推送 CC 的中间文本到飞书（sendTo 返回后取消，防止与 reply 卡片重复）
  let textBuffer = ''
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let textSuppressed = false

  if (!sessionKey.startsWith('topic:')) {
    deps.router.setTextHandlerFor(sessionKey, (chunk: string) => {
      if (textSuppressed) return
      textBuffer += chunk
      if (!flushTimer) {
        flushTimer = setTimeout(async () => {
          const pending = textBuffer.trim()
          textBuffer = ''
          flushTimer = null
          if (textSuppressed || pending.length <= 20) return
          try {
            const { sendText } = await import('./send.ts')
            await sendText(chatId, pending.slice(0, 2000))
          } catch { /* 不影响主流程 */ }
        }, 3000)
      }
    })
  }

  // 9. Add typing indicator
  const reactionId = await addTypingIndicator(messageId)

  // 10. Route to CC and send reply back to Feishu
  console.log('[feishu-handler] routing to CC, sessionKey:', sessionKey)
  try {
    const reply = await deps.router.sendTo(sessionKey, text, {
      description: role === 'specialist' ? `话题回复 (thread: ${threadId})` : undefined,
    })
    console.log('[feishu-handler] CC replied:', reply?.slice(0, 100))

    // sendTo 完成 → 抑制 textHandler，取消 pending flush（防止与 reply 卡片重复）
    textSuppressed = true
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
    textBuffer = ''

    if (reply && reply.trim() && !reply.startsWith('[错误]')) {
      if (sessionKey.startsWith('topic:')) {
        const topicMapping = deps.sessionMap.get(sessionKey)
        if (topicMapping?.anchorMessageId) {
          const { replyInThread } = await import('./send.ts')
          await replyInThread(topicMapping.anchorMessageId, reply)
        } else {
          await sendReply(chatId, reply, rootMessageId)
        }
      } else {
        await sendReply(chatId, reply, rootMessageId)
      }
    }
  } finally {
    // 9. Remove typing indicator
    if (reactionId) {
      await removeTypingIndicator(messageId, reactionId)
    }
  }
}
