import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export interface UserProfile {
  /** user/ 下所有 .md 合并的内容，注入到 system prompt */
  content: string
  /** user/ 目录路径 */
  dir: string
}

/**
 * 加载 User Profile。
 * 独立于 Persona Pack — 换角色也知道用户是谁。
 *
 * Both the user and the AI persona can modify profiles, but core identity fields should be confirmed by the user.
 */
export function loadUser(userDir: string): UserProfile {
  if (!existsSync(userDir)) {
    return { content: '', dir: userDir }
  }

  const files = readdirSync(userDir).filter(f => f.endsWith('.md')).sort()
  const parts = files.map(f => readFileSync(join(userDir, f), 'utf-8'))

  return {
    content: parts.join('\n\n---\n\n'),
    dir: userDir,
  }
}
