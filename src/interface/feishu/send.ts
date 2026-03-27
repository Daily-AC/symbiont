import { getClient } from './client.ts'
import { buildCardV2 } from './md-to-card.ts'

export async function sendText(
  chatId: string,
  text: string,
): Promise<string | undefined> {
  const client = getClient()
  const res = await client.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    },
  })
  return res?.data?.message_id
}

export async function sendMarkdownCard(
  chatId: string,
  markdown: string,
  options?: { threadId?: string; replyToMessageId?: string; title?: string }
): Promise<string | undefined> {
  const client = getClient()
  const card = buildCardV2(markdown, { title: options?.title })

  try {
    if (options?.replyToMessageId) {
      const res = await client.im.message.reply({
        path: { message_id: options.replyToMessageId },
        data: {
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      })
      return res?.data?.message_id
    }

    const res = await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    })
    return res?.data?.message_id
  } catch {
    return sendText(chatId, markdown)
  }
}

export async function replyMarkdownCard(
  messageId: string,
  markdown: string,
  options?: { title?: string }
): Promise<string | undefined> {
  const client = getClient()
  const card = buildCardV2(markdown, { title: options?.title })

  const res = await client.im.message.reply({
    path: { message_id: messageId },
    data: {
      msg_type: 'interactive',
      content: JSON.stringify(card),
    },
  })
  return res?.data?.message_id
}

export async function updateCard(
  messageId: string,
  markdown: string,
  options?: { title?: string }
): Promise<void> {
  const client = getClient()
  const card = buildCardV2(markdown, { title: options?.title })

  await client.im.message.patch({
    path: { message_id: messageId },
    data: { content: JSON.stringify(card) },
  })
}

export async function sendFile(
  chatId: string,
  fileKey: string,
): Promise<string | undefined> {
  const client = getClient()
  const res = await client.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: chatId,
      msg_type: 'file',
      content: JSON.stringify({ file_key: fileKey }),
    },
  })
  return res?.data?.message_id
}

export async function replyInThread(
  messageId: string,
  markdown: string,
): Promise<string | undefined> {
  const client = getClient()
  const card = buildCardV2(markdown)
  const res = await client.im.message.reply({
    path: { message_id: messageId },
    data: {
      msg_type: 'interactive',
      content: JSON.stringify(card),
      reply_in_thread: true,
    } as any,
  })
  return res?.data?.message_id
}
