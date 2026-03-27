import { getClient } from './client.ts'

export async function addTypingIndicator(
  messageId: string,
  emojiType = 'HUG'
): Promise<string | null> {
  try {
    const client = getClient()
    const res = await client.im.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: emojiType } },
    })
    return res?.data?.reaction_id ?? null
  } catch {
    return null
  }
}

export async function removeTypingIndicator(
  messageId: string,
  reactionId: string
): Promise<void> {
  try {
    const client = getClient()
    await client.im.messageReaction.delete({
      path: { message_id: messageId, reaction_id: reactionId },
    })
  } catch { /* ignore */ }
}
