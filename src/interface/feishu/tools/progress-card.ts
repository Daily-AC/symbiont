import { getClient } from '../client.ts'
import { updateCard } from '../send.ts'

/**
 * Send a progress card showing step status.
 * Returns the messageId for later updates.
 */
export async function sendProgress(
  chatId: string,
  title: string,
  steps: string[],
  currentStep: number,
): Promise<string> {
  const markdown = formatProgress(steps, currentStep)
  const client = getClient()

  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: title },
      template: 'wathet',
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: markdown } },
    ],
  }

  const res = await client.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: chatId,
      msg_type: 'interactive',
      content: JSON.stringify(card),
    },
  })

  const messageId = res?.data?.message_id
  if (!messageId) throw new Error('Failed to send progress card')
  return messageId
}

/**
 * Update an existing progress card.
 */
export async function updateProgress(
  messageId: string,
  title: string,
  steps: string[],
  currentStep: number,
): Promise<void> {
  const markdown = formatProgress(steps, currentStep)
  await updateCard(messageId, markdown, { title })
}

function formatProgress(steps: string[], currentStep: number): string {
  return steps.map((step, i) => {
    if (i < currentStep) return `~~${step}~~ done`
    if (i === currentStep) return `**${step}**`
    return `${step}`
  }).join('\n')
}
