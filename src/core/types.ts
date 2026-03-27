export interface CCMessage {
  type: string
  subtype?: string
  session_id?: string
  result?: string
  request_id?: string
  message?: {
    role?: string
    content?: Array<{ type: string; text?: string }>
  }
  [key: string]: unknown
}

export interface CCProcessOptions {
  sessionId?: string
  systemPrompt?: string
  allowedTools?: string[]
  cwd?: string
  model?: string
  /** 空闲多久后自动休眠（ms），0 = 不自动休眠，默认 5 分钟 */
  idleTimeoutMs?: number
  /** MCP server 配置，通过 --mcp-config JSON 注入（print 模式） */
  mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string>; type?: string; url?: string; headers?: Record<string, string> }>
  /** MCP 配置文件路径列表，通过 --mcp-config 文件路径注入（--sdk-url 模式） */
  mcpConfigFiles?: string[]
  /** skill 目录路径列表，通过 --plugin-dir 注入 */
  pluginDirs?: string[]
  /** 通信模式：ws = --sdk-url WebSocket（默认），print = -p 每轮新进程 */
  mode?: 'ws' | 'print'
  /** resume 失败时的恢复 prompt（从事件流摘要生成） */
  recoveryPrompt?: string
}

export type CCProcessState = 'idle' | 'running' | 'sleeping' | 'stopped'
