/**
 * 纯函数：生成 CC CLI 参数列表。
 *
 * 从 CCProcess.buildArgs() 提取，方便测试。
 * WS 模式和 print 模式共用。
 */

export interface BuildCCArgsOptions {
  /** WS 模式的 sdk-url（ws://...） */
  sdkUrl?: string
  sessionId?: string
  systemPrompt?: string
  model?: string
  allowedTools?: string[]
  /** MCP server 配置（用于 print 模式 JSON 传递） */
  mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string>; type?: string; url?: string; headers?: Record<string, string> }>
  /** MCP 配置文件路径列表（用于 --sdk-url 模式传文件路径） */
  mcpConfigFiles?: string[]
  /** skill/plugin 目录 */
  pluginDirs?: string[]
}

export function buildCCArgs(options: BuildCCArgsOptions): string[] {
  const args: string[] = []

  if (options.sdkUrl) {
    args.push('--sdk-url', options.sdkUrl)
    args.push('--print')
    args.push('--output-format', 'stream-json')
    args.push('--input-format', 'stream-json')
    args.push('--verbose')
  }

  if (options.sessionId) {
    args.push('--resume', options.sessionId)
  }
  if (options.systemPrompt) {
    args.push('--system-prompt', options.systemPrompt)
  }
  if (options.model) {
    args.push('--model', options.model)
  }
  if (options.allowedTools?.length) {
    args.push('--allowedTools', options.allowedTools.join(','))
  }

  // MCP 注入：--sdk-url 模式用文件路径，print 模式用 JSON 字符串
  // CC --sdk-url 模式对 JSON 字符串的 schema 校验更严格，文件路径可绕过
  if (options.mcpConfigFiles?.length) {
    for (const f of options.mcpConfigFiles) {
      args.push('--mcp-config', f)
    }
  } else if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
    args.push('--mcp-config', JSON.stringify({ mcpServers: options.mcpServers }))
  }

  if (options.pluginDirs?.length) {
    for (const dir of options.pluginDirs) {
      args.push('--plugin-dir', dir)
    }
  }

  args.push('--dangerously-skip-permissions')
  args.push('-p', '')

  return args
}
