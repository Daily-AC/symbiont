import { getClient } from '../client.ts'
import { updateCard } from '../send.ts'

interface PendingApproval {
  resolve: (result: 'approved' | 'rejected') => void
  timer: ReturnType<typeof setTimeout>
  messageId: string
}

const pending = new Map<string, PendingApproval>()

/**
 * Send an approval card and wait for user response.
 * Returns 'approved', 'rejected', or 'timeout'.
 */
export async function sendApproval(
  chatId: string,
  title: string,
  description: string,
  timeoutMs = 5 * 60 * 1000,
): Promise<'approved' | 'rejected' | 'timeout'> {
  const approvalId = `approval-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const client = getClient()

  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: title },
      template: 'orange',
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: description } },
      { tag: 'hr' },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: 'Approve' },
            type: 'primary',
            value: JSON.stringify({ action: 'approved', approvalId }),
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: 'Reject' },
            type: 'danger',
            value: JSON.stringify({ action: 'rejected', approvalId }),
          },
        ],
      },
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
  if (!messageId) throw new Error('Failed to send approval card')

  return new Promise<'approved' | 'rejected' | 'timeout'>((resolve) => {
    const timer = setTimeout(async () => {
      pending.delete(approvalId)
      await updateCard(messageId, `~~${description}~~\n\n**Timed out**`, { title }).catch(() => {})
      resolve('timeout')
    }, timeoutMs)

    pending.set(approvalId, { resolve, timer, messageId })
  })
}

/**
 * Handle an approval callback from card action.
 * Returns true if the approval was found and resolved.
 */
export function handleApprovalCallback(
  approvalId: string,
  action: 'approved' | 'rejected',
): boolean {
  const entry = pending.get(approvalId)
  if (!entry) return false
  clearTimeout(entry.timer)
  entry.resolve(action)
  pending.delete(approvalId)
  return true
}
