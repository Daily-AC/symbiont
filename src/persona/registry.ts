import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { loadPersona, type PersonaConfig } from './loader.ts'

export interface PackManifest {
  name: string
  description: string
  tags: string[]
  triggers: string[]
  emoji?: string
}

export interface PersonaPack {
  name: string
  manifest: PackManifest
  persona: PersonaConfig
  dir: string
}

export class PersonaRegistry {
  private packs: Map<string, PersonaPack> = new Map()
  private packsDir: string | null = null

  scan(packsDir: string): void {
    this.packsDir = packsDir
    if (!existsSync(packsDir)) return
    const entries = readdirSync(packsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const packDir = join(packsDir, entry.name)
      const manifestPath = join(packDir, 'manifest.yaml')
      if (!existsSync(manifestPath)) continue
      try {
        const raw = readFileSync(manifestPath, 'utf-8')
        const manifest = this.parseYaml(raw)
        const persona = loadPersona(packDir)
        this.packs.set(entry.name, { name: entry.name, manifest, persona, dir: packDir })
      } catch { /* skip broken packs */ }
    }
  }

  /** 重新扫描，加载运行时新增的 pack（不删除已有的）。新 pack 自动 git commit 保护。 */
  rescan(): number {
    if (!this.packsDir) return 0
    const before = this.packs.size
    this.scan(this.packsDir)
    const added = this.packs.size - before
    // 自动 git commit 保护新创建的 pack
    if (added > 0) {
      try {
        const siaRoot = join(this.packsDir, '..')
        execSync('git add persona-packs/', { cwd: siaRoot, stdio: 'pipe' })
        execSync('git diff --cached --quiet', { cwd: siaRoot, stdio: 'pipe' })
      } catch {
        // git diff --cached --quiet exits 1 if there are staged changes
        try {
          const siaRoot = join(this.packsDir, '..')
          execSync(`git commit -m "feat(persona): auto-commit ${added} new persona packs"`, { cwd: siaRoot, stdio: 'pipe' })
        } catch { /* commit failed, not critical */ }
      }
    }
    return added
  }

  match(taskDescription: string): PersonaPack | undefined {
    const desc = taskDescription.toLowerCase()
    let bestPack: PersonaPack | undefined
    let bestScore = 0
    for (const pack of this.packs.values()) {
      if (pack.name === 'default') continue
      let score = 0
      for (const trigger of pack.manifest.triggers) {
        if (desc.includes(trigger.toLowerCase())) score += 3
      }
      for (const tag of pack.manifest.tags) {
        if (desc.includes(tag.toLowerCase())) score += 1
      }
      if (score > bestScore) { bestScore = score; bestPack = pack }
    }
    return bestPack ?? this.packs.get('default')
  }

  get(name: string): PersonaPack | undefined { return this.packs.get(name) }
  list(): PackManifest[] { return [...this.packs.values()].map(p => p.manifest) }
  entries(): PersonaPack[] { return [...this.packs.values()] }
  get size(): number { return this.packs.size }

  private parseYaml(raw: string): PackManifest {
    const result: Record<string, unknown> = {}
    let currentKey = ''
    let currentArray: string[] | null = null
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      if (trimmed.startsWith('- ') && currentArray) {
        currentArray.push(trimmed.slice(2).trim().replace(/^["']|["']$/g, ''))
        continue
      }
      if (currentArray && currentKey) { result[currentKey] = currentArray; currentArray = null }
      const colonIdx = trimmed.indexOf(':')
      if (colonIdx === -1) continue
      const key = trimmed.slice(0, colonIdx).trim()
      const value = trimmed.slice(colonIdx + 1).trim()
      if (!value) { currentKey = key; currentArray = [] }
      else if (value.startsWith('[') && value.endsWith(']')) {
        // 内联数组: tags: [a, b, c]
        result[key] = value.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, ''))
      }
      else { result[key] = value.replace(/^["']|["']$/g, '') }
    }
    if (currentArray && currentKey) { result[currentKey] = currentArray }
    return {
      name: (result.name as string) ?? 'unknown',
      description: (result.description as string) ?? '',
      tags: (result.tags as string[]) ?? [],
      triggers: (result.triggers as string[]) ?? [],
      emoji: result.emoji as string | undefined,
    }
  }
}
