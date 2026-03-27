import { handleApprovalCallback } from './tools/approval-card.ts'

// deno-lint-ignore no-explicit-any
export function handleCardAction(event: any): any {
  const actionValue = event?.action?.value
  if (!actionValue) return { toast: { type: 'info', content: 'Unknown action' } }

  try {
    const value = typeof actionValue === 'string' ? JSON.parse(actionValue) : actionValue
    const { action, approvalId } = value

    if (approvalId && (action === 'approved' || action === 'rejected')) {
      const handled = handleApprovalCallback(approvalId, action)
      if (handled) {
        return {
          toast: {
            type: action === 'approved' ? 'success' : 'warning',
            content: action === 'approved' ? 'Approved' : 'Rejected',
          },
        }
      }
    }
  } catch { /* ignore parse errors */ }

  return { toast: { type: 'info', content: 'Received' } }
}
