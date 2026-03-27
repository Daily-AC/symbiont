import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { MemoryDB } from './db.ts'

export interface CompilerDeps {
  db: MemoryDB
  logger: { info: (mod: string, event: string, meta?: any) => void; error: (mod: string, event: string, meta?: any) => void }
  personaDir: string       // e.g., /root/symbiont/persona-xiaoxi
  ccMemoryDir: string      // e.g., ~/.claude/projects/.../memory
  personaPacksDir: string  // e.g., /root/symbiont/persona-packs
}

export type CompileTarget = 'identity' | 'cc_memory' | 'persona'

export interface CompileRequest {
  target: CompileTarget
  personaName?: string   // required when target='persona'
  content: string        // the rule/knowledge to write
  reason: string         // why this is worth compiling
  sourceCards?: string[] // card IDs for traceability
}

export class Compiler {
  private deps: CompilerDeps

  constructor(deps: CompilerDeps) {
    this.deps = deps
  }

  /**
   * Compile knowledge into the specified target.
   * Returns the file path that was modified.
   */
  compile(request: CompileRequest): string {
    const { target, content, reason, sourceCards } = request

    let filePath: string

    switch (target) {
      case 'identity':
        filePath = this.compileToIdentity(content)
        break
      case 'cc_memory':
        filePath = this.compileToCCMemory(content, reason)
        break
      case 'persona':
        if (!request.personaName) throw new Error('personaName required for persona target')
        filePath = this.compileToPersona(request.personaName, content)
        break
      default:
        throw new Error(`Unknown compile target: ${target}`)
    }

    // Log the compilation activity
    this.deps.db.logActivity('compile', undefined, JSON.stringify({
      target,
      filePath,
      reason,
      sourceCards: sourceCards ?? [],
      compiledAt: new Date().toISOString(),
    }))

    this.deps.logger.info('compiler', 'compiled', {
      target, filePath, reason,
      sourceCards: sourceCards?.length ?? 0,
    })

    return filePath
  }

  private compileToIdentity(content: string): string {
    const filePath = join(this.deps.personaDir, 'soul', 'identity.md')
    if (!existsSync(filePath)) throw new Error(`identity.md not found: ${filePath}`)

    const current = readFileSync(filePath, 'utf8')

    // Find or create the "编译知识" section
    const sectionHeader = '## 编译知识'
    const sectionComment = '<!-- 以下内容由 symbiont_compile 自动写入，小希反思后沉淀的规律 -->'

    if (current.includes(sectionHeader)) {
      // Append to existing section
      const insertPoint = current.indexOf(sectionHeader) + sectionHeader.length
      const nextSectionMatch = current.slice(insertPoint).match(/\n## /)
      const insertEnd = nextSectionMatch
        ? insertPoint + (nextSectionMatch.index ?? current.length)
        : current.length

      const before = current.slice(0, insertEnd).trimEnd()
      const after = current.slice(insertEnd)
      const updated = `${before}\n\n- ${content}${after}`
      writeFileSync(filePath, updated, 'utf8')
    } else {
      // Create new section at the end
      const updated = `${current.trimEnd()}\n\n${sectionHeader}\n${sectionComment}\n\n- ${content}\n`
      writeFileSync(filePath, updated, 'utf8')
    }

    return filePath
  }

  private compileToCCMemory(content: string, reason: string): string {
    const memoryDir = this.deps.ccMemoryDir
    mkdirSync(memoryDir, { recursive: true })

    // Write to a compiled-knowledge file
    const filePath = join(memoryDir, 'compiled-knowledge.md')

    const entry = `\n### ${reason}\n${content}\n_compiled: ${new Date().toISOString()}_\n`

    if (existsSync(filePath)) {
      const current = readFileSync(filePath, 'utf8')
      writeFileSync(filePath, current + entry, 'utf8')
    } else {
      const header = `---
name: compiled-knowledge
description: 小希反思沉淀的长期知识，由 symbiont_compile 自动写入
type: project
---

# 编译知识\n`
      writeFileSync(filePath, header + entry, 'utf8')
    }

    // Update MEMORY.md index if the file is new
    this.updateMemoryIndex(memoryDir, filePath)

    return filePath
  }

  private compileToPersona(personaName: string, content: string): string {
    const personaDir = join(this.deps.personaPacksDir, personaName)
    if (!existsSync(personaDir)) throw new Error(`Persona pack not found: ${personaDir}`)

    const soulDir = join(personaDir, 'soul')
    mkdirSync(soulDir, { recursive: true })

    const filePath = join(soulDir, 'identity.md')

    if (existsSync(filePath)) {
      const current = readFileSync(filePath, 'utf8')
      const updated = `${current.trimEnd()}\n\n## 经验沉淀\n\n- ${content}\n`
      writeFileSync(filePath, updated, 'utf8')
    } else {
      writeFileSync(filePath, `# ${personaName} 经验沉淀\n\n- ${content}\n`, 'utf8')
    }

    return filePath
  }

  private updateMemoryIndex(memoryDir: string, newFilePath: string): void {
    const indexPath = join(memoryDir, 'MEMORY.md')
    if (!existsSync(indexPath)) return

    const index = readFileSync(indexPath, 'utf8')
    const relativePath = newFilePath.replace(memoryDir + '/', '')

    if (!index.includes(relativePath)) {
      const entry = `\n- [compiled-knowledge](${relativePath}) — 小希反思沉淀的长期知识\n`
      writeFileSync(indexPath, index.trimEnd() + entry, 'utf8')
    }
  }
}
