import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadManifest, type ManifestConfig } from './manifest.ts'

export interface PersonaConfig {
  /** soul/ + voice/ 合并的 system prompt */
  soulPrompt: string
  /** Persona Pack 根目录 */
  packDir: string
  /** persona 的 memory/ 目录路径 */
  memoryDir: string
  /** manifest 配置（权限边界） */
  manifest: ManifestConfig | null
}

/**
 * 加载 Persona Pack。
 *
 * Persona = 身份，不是能力。
 * - soul/ + voice/ → system prompt（定义"我是谁"和"我怎么说话"）
 * - memory/ → 私有记忆
 * - manifest.yaml → 权限边界
 *
 * 技能和工具由 CC 原生管理（~/.claude/），不绑定在 persona 上。
 */
export function loadPersona(packDir: string): PersonaConfig {
  const soulDir = join(packDir, 'soul')
  const voiceDir = join(packDir, 'voice')

  const promptParts: string[] = []

  // Soul — 核心人格
  if (existsSync(soulDir)) {
    const files = readdirSync(soulDir).filter(f => f.endsWith('.md')).sort()
    for (const f of files) {
      promptParts.push(readFileSync(join(soulDir, f), 'utf-8'))
    }
  }

  // Voice — 表达规范
  if (existsSync(voiceDir)) {
    const files = readdirSync(voiceDir).filter(f => f.endsWith('.md')).sort()
    for (const f of files) {
      promptParts.push(readFileSync(join(voiceDir, f), 'utf-8'))
    }
  }

  return {
    soulPrompt: promptParts.join('\n\n---\n\n'),
    packDir,
    memoryDir: join(packDir, 'memory'),
    manifest: loadManifest(packDir),
  }
}
