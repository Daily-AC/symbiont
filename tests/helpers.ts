import { mkdtempSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Logger } from '../src/core/logger.ts'
import { SymbiontCore } from '../src/core/symbiont-core.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))

export function createTestLogger(): Logger {
  const dir = mkdtempSync(join(tmpdir(), 'symbiont-test-'))
  return new Logger(dir)
}

export function createTestCore(suffix?: string): { core: SymbiontCore; dataDir: string } {
  const dataDir = mkdtempSync(join(tmpdir(), `symbiont-test-${suffix ?? ''}-`))
  const core = new SymbiontCore({
    dataDir,
    personaPackDir: join(__dirname, '..', 'persona-xiaoxi'),
    userDir: join(__dirname, '..', 'user'),
  })
  return { core, dataDir }
}
