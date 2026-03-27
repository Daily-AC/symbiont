export interface FeishuCall {
  method: string
  args: unknown[]
}

export function createMockFeishuClient() {
  const calls: FeishuCall[] = []

  const client = {
    im: {
      message: {
        create: async (params: any) => {
          calls.push({ method: 'im.message.create', args: [params] })
          return { data: { message_id: `mock-msg-${Date.now()}` } }
        },
        reply: async (params: any) => {
          calls.push({ method: 'im.message.reply', args: [params] })
          return { data: { message_id: `mock-reply-${Date.now()}` } }
        },
        get: async (params: any) => {
          calls.push({ method: 'im.message.get', args: [params] })
          return { data: { items: [] } }
        },
        patch: async (params: any) => {
          calls.push({ method: 'im.message.patch', args: [params] })
          return {}
        },
      },
      messageResource: {
        get: async (params: any) => {
          calls.push({ method: 'im.messageResource.get', args: [params] })
          const { Readable } = await import('node:stream')
          return { data: Readable.from(Buffer.from('mock-file-content')) }
        },
      },
      chat: {
        create: async (params: any) => {
          calls.push({ method: 'im.chat.create', args: [params] })
          return { data: { chat_id: `mock-chat-${Date.now()}` } }
        },
      },
      messageReaction: {
        create: async (params: any) => {
          calls.push({ method: 'im.messageReaction.create', args: [params] })
          return { data: { reaction_id: 'mock-reaction' } }
        },
        delete: async (params: any) => {
          calls.push({ method: 'im.messageReaction.delete', args: [params] })
          return {}
        },
      },
    },
  }

  return {
    client,
    calls,
    getCalls(method: string): FeishuCall[] {
      return calls.filter(c => c.method === method)
    },
    reset() { calls.length = 0 },
  }
}
