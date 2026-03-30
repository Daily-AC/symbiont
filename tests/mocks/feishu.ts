export interface FeishuCall {
  method: string
  args: unknown[]
}

export function createMockFeishuClient() {
  const calls: FeishuCall[] = []

  // Allow tests to override im.message.get responses
  let messageGetOverride: ((params: any) => Promise<any>) | null = null

  const client = {
    contact: {
      user: {
        get: async (params: any) => {
          calls.push({ method: 'contact.user.get', args: [params] })
          return { data: { user: { name: 'MockUser' } } }
        },
      },
    },
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
          if (messageGetOverride) return messageGetOverride(params)
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
          return {
            writeFile: async (destPath: string) => {
              const { writeFileSync } = await import('node:fs')
              writeFileSync(destPath, 'mock-file-content')
            },
          }
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
    setMessageGetOverride(fn: ((params: any) => Promise<any>) | null) {
      messageGetOverride = fn
    },
    reset() { calls.length = 0; messageGetOverride = null },
  }
}
