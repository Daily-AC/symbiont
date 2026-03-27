import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface ManifestConfig {
  name: string
  version: string
  description: string
  permissions: {
    writable: string[]
    protected: string[]
  }
  mcp?: {
    tools: string[]
  }
  skills?: {
    include: string[]
  }
}

/**
 * 加载并解析 manifest.yaml。
 */
export function loadManifest(packDir: string): ManifestConfig | null {
  const manifestPath = join(packDir, 'manifest.yaml')
  if (!existsSync(manifestPath)) return null

  const content = readFileSync(manifestPath, 'utf-8')
  const lines = content.split('\n')

  let name = '', version = '', description = ''
  const writable: string[] = []
  const protectedDirs: string[] = []
  const mcpTools: string[] = []
  const skillsInclude: string[] = []

  // 追踪当前解析的列表上下文
  let currentList: string[] | null = null
  // 追踪当前所在的顶级 section
  let currentSection: string | null = null

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('#') || !trimmed) continue

    // 检测缩进层级（顶级 vs 嵌套）
    const indent = line.length - line.trimStart().length

    // 顶级 key（无缩进）
    if (indent === 0) {
      currentList = null
      if (trimmed.startsWith('name:')) {
        name = trimmed.slice(5).trim()
        currentSection = null
      } else if (trimmed.startsWith('version:')) {
        version = trimmed.slice(8).trim().replace(/"/g, '')
        currentSection = null
      } else if (trimmed.startsWith('description:')) {
        description = trimmed.slice(12).trim()
        currentSection = null
      } else if (trimmed === 'permissions:') {
        currentSection = 'permissions'
      } else if (trimmed === 'mcp:') {
        currentSection = 'mcp'
      } else if (trimmed === 'skills:') {
        currentSection = 'skills'
      } else {
        currentSection = null
      }
      continue
    }

    // 二级 key
    if (trimmed === 'writable:' && currentSection === 'permissions') {
      currentList = writable
    } else if (trimmed === 'protected:' && currentSection === 'permissions') {
      currentList = protectedDirs
    } else if (trimmed === 'tools:' && currentSection === 'mcp') {
      currentList = mcpTools
    } else if (trimmed === 'include:' && currentSection === 'skills') {
      currentList = skillsInclude
    } else if (trimmed.startsWith('- ') && currentList) {
      let val = trimmed.slice(2).trim().replace(/#.*$/, '').trim()
      // 去掉引号
      val = val.replace(/^["']|["']$/g, '')
      if (val && val !== '[]') currentList.push(val)
    }
  }

  return {
    name, version, description,
    permissions: { writable, protected: protectedDirs },
    ...(mcpTools.length > 0 ? { mcp: { tools: mcpTools } } : {}),
    ...(skillsInclude.length > 0 ? { skills: { include: skillsInclude } } : {}),
  }
}

/**
 * 检查路径是否可写（白名单模式）。
 */
export function isWritable(manifest: ManifestConfig, relativePath: string): boolean {
  for (const p of manifest.permissions.protected) {
    const dir = p.replace(/\/$/, '')
    if (relativePath === dir || relativePath.startsWith(dir + '/') || relativePath === p) {
      return false
    }
  }
  for (const w of manifest.permissions.writable) {
    const dir = w.replace(/\/$/, '')
    if (relativePath === dir || relativePath.startsWith(dir + '/')) {
      return true
    }
  }
  return false
}

/**
 * 更新 manifest.yaml 中的指定字段。
 * 支持 mcp.tools 和 skills.include 两个字段。
 */
export function updateManifestField(
  packDir: string,
  field: 'mcp.tools' | 'skills.include',
  values: string[],
): void {
  const manifestPath = join(packDir, 'manifest.yaml')
  if (!existsSync(manifestPath)) throw new Error(`Manifest not found: ${manifestPath}`)

  const content = readFileSync(manifestPath, 'utf-8')
  const lines = content.split('\n')
  const result: string[] = []

  const [section, key] = field.split('.')
  let inSection = false
  let inKey = false
  let keyWritten = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    const indent = line.length - line.trimStart().length

    // 检测顶级 section
    if (indent === 0 && trimmed === `${section}:`) {
      inSection = true
      inKey = false
      result.push(line)
      continue
    }

    // 离开 section（遇到另一个顶级 key）
    if (indent === 0 && trimmed && !trimmed.startsWith('#') && inSection) {
      // 如果还没写 key，在离开 section 前写入
      if (!keyWritten) {
        result.push(`  ${key}:`)
        for (const v of values) result.push(`    - "${v}"`)
        keyWritten = true
      }
      inSection = false
      inKey = false
      result.push(line)
      continue
    }

    // 在 section 内，检测二级 key
    if (inSection && indent > 0 && trimmed === `${key}:`) {
      inKey = true
      result.push(line)
      // 写入新值
      if (values.length === 0) {
        result.push(`    # (empty)`)
      } else {
        for (const v of values) result.push(`    - "${v}"`)
      }
      keyWritten = true
      continue
    }

    // 跳过旧的 list items（在 key 内的 `- ` 行和 inline `[]`）
    if (inKey && indent > 0 && (trimmed.startsWith('- ') || trimmed === '[]')) {
      continue
    }

    // 遇到 key 内的注释或其他内容，说明 key 列表结束
    if (inKey && indent > 0 && !trimmed.startsWith('- ')) {
      // 这行不是列表项，检查是否是同级别的另一个 key
      if (!trimmed.startsWith('#')) {
        inKey = false
      }
    }

    // 如果离开了 inKey（但还在 section），也要退出 inKey
    if (inKey && indent === 0) {
      inKey = false
    }

    result.push(line)
  }

  // 如果到文件末尾还没写，追加
  if (inSection && !keyWritten) {
    result.push(`  ${key}:`)
    for (const v of values) result.push(`    - "${v}"`)
  }

  writeFileSync(manifestPath, result.join('\n'))
}
