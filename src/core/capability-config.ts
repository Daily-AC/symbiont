import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface SharedCapabilities {
  mcp: { always_available: string[] }
  skills: { always_available: string[] }
}

/**
 * 加载公用白名单配置。
 */
export function loadSharedCapabilities(configDir: string): SharedCapabilities {
  const filePath = join(configDir, 'shared-capabilities.json')
  if (!existsSync(filePath)) {
    return { mcp: { always_available: [] }, skills: { always_available: [] } }
  }
  const raw = readFileSync(filePath, 'utf-8')
  const parsed = JSON.parse(raw)
  return {
    mcp: { always_available: parsed.mcp?.always_available ?? [] },
    skills: { always_available: parsed.skills?.always_available ?? [] },
  }
}

/**
 * 更新公用白名单配置。
 */
export function updateSharedCapabilities(
  configDir: string,
  field: 'mcp.always_available' | 'skills.always_available',
  values: string[],
): void {
  const filePath = join(configDir, 'shared-capabilities.json')
  const current = loadSharedCapabilities(configDir)

  const [section, key] = field.split('.')
  if (section === 'mcp' && key === 'always_available') {
    current.mcp.always_available = values
  } else if (section === 'skills' && key === 'always_available') {
    current.skills.always_available = values
  }

  writeFileSync(filePath, JSON.stringify(current, null, 2) + '\n')
}

