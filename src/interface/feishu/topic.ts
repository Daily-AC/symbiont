import { getClient } from './client.ts'
import type { SessionMap } from './session-map.ts'

/**
 * Create a real Feishu thread (话题) in any chat (including P2P).
 * 1. Send a card message as the thread anchor
 * 2. Reply to it with reply_in_thread: true to create a real thread
 * Returns the thread_id (omt_xxx format).
 */
export async function createTopic(
  chatId: string,
  title: string,
  sessionMap: SessionMap,
): Promise<string> {
  const client = getClient()

  // Step 1: 发送卡片消息作为话题锚点
  const res = await client.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: chatId,
      msg_type: 'interactive',
      content: JSON.stringify({
        config: { wide_screen_mode: true },
        header: {
          title: { tag: 'plain_text', content: title },
          template: 'indigo',
        },
        elements: [
          { tag: 'div', text: { tag: 'lark_md', content: '话题已创建，专员正在准备中...' } },
        ],
      }),
    },
  })

  const messageId = res?.data?.message_id
  if (!messageId) throw new Error('Failed to create topic anchor message')

  // Step 2: 用 reply + reply_in_thread: true 创建真正的话题
  const replyRes = await client.im.message.reply({
    path: { message_id: messageId },
    data: {
      content: JSON.stringify({ text: '专员已上线，请在此话题中对话 🌻' }),
      msg_type: 'text',
      reply_in_thread: true,
    },
  })

  // Step 3: 从 reply 响应中获取 thread_id
  const threadId = (replyRes?.data as any)?.message?.thread_id
  if (!threadId) {
    // fallback: 如果拿不到 thread_id，用 messageId（降级到旧行为）
    console.warn('createTopic: thread_id not found in reply response, falling back to messageId')
    const fallbackThreadId = messageId
    const sessionKey = `topic:${chatId}:${fallbackThreadId}`
    sessionMap.set({
      sessionKey,
      chatId,
      chatType: 'p2p',
      threadId: fallbackThreadId,
      anchorMessageId: messageId,
      lastActive: new Date().toISOString(),
    })
    return fallbackThreadId
  }

  const sessionKey = `topic:${chatId}:${threadId}`
  sessionMap.set({
    sessionKey,
    chatId,
    chatType: 'p2p',
    threadId,
    anchorMessageId: messageId,
    lastActive: new Date().toISOString(),
  })

  return threadId
}
