// tests/compiler.test.ts
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MemoryDB } from '../src/memory/db.ts'
import { Compiler } from '../src/memory/compiler.ts'

function makeLogger() {
  const logs: Array<{ level: string; mod: string; event: string; meta?: any }> = []
  return {
    logs,
    info(mod: string, event: string, meta?: any) { logs.push({ level: 'info', mod, event, meta }) },
    error(mod: string, event: string, meta?: any) { logs.push({ level: 'error', mod, event, meta }) },
  }
}

describe('Compiler', () => {
  let db: MemoryDB
  let tmpDir: string
  let personaDir: string
  let ccMemoryDir: string
  let personaPacksDir: string

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'symbiont-compiler-test-'))
    db = new MemoryDB(join(tmpDir, 'data'))

    personaDir = join(tmpDir, 'persona-xiaoxi')
    ccMemoryDir = join(tmpDir, 'cc-memory')
    personaPacksDir = join(tmpDir, 'persona-packs')

    // Create persona dirs with identity.md
    mkdirSync(join(personaDir, 'soul'), { recursive: true })
    writeFileSync(join(personaDir, 'soul', 'identity.md'), `# 小希\n\n## 性格\n\n活泼开朗\n`, 'utf8')

    mkdirSync(ccMemoryDir, { recursive: true })
    mkdirSync(personaPacksDir, { recursive: true })
  })

  after(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('compile to identity: creates 编译知识 section if not exists', () => {
    const logger = makeLogger()
    const compiler = new Compiler({ db, logger, personaDir, ccMemoryDir, personaPacksDir })

    const filePath = compiler.compile({
      target: 'identity',
      content: '遇到问题先搜社区',
      reason: '多次验证的经验',
    })

    assert.strictEqual(filePath, join(personaDir, 'soul', 'identity.md'))
    const content = readFileSync(filePath, 'utf8')
    assert.ok(content.includes('## 编译知识'))
    assert.ok(content.includes('遇到问题先搜社区'))
    // Original content preserved
    assert.ok(content.includes('# 小希'))
    assert.ok(content.includes('活泼开朗'))
  })

  test('compile to identity: appends to existing 编译知识 section', () => {
    const logger = makeLogger()
    const compiler = new Compiler({ db, logger, personaDir, ccMemoryDir, personaPacksDir })

    const filePath = compiler.compile({
      target: 'identity',
      content: '同一时间只运行一个实例',
      reason: '避免 token 冲突',
    })

    const content = readFileSync(filePath, 'utf8')
    assert.ok(content.includes('遇到问题先搜社区'))
    assert.ok(content.includes('同一时间只运行一个实例'))
  })

  test('compile to cc_memory: creates compiled-knowledge.md', () => {
    const logger = makeLogger()
    const compiler = new Compiler({ db, logger, personaDir, ccMemoryDir, personaPacksDir })

    const filePath = compiler.compile({
      target: 'cc_memory',
      content: 'Docker 容器不能设全局 HTTP_PROXY',
      reason: '飞书 WSClient 会断',
    })

    assert.strictEqual(filePath, join(ccMemoryDir, 'compiled-knowledge.md'))
    assert.ok(existsSync(filePath))
    const content = readFileSync(filePath, 'utf8')
    assert.ok(content.includes('# 编译知识'))
    assert.ok(content.includes('Docker 容器不能设全局 HTTP_PROXY'))
    assert.ok(content.includes('飞书 WSClient 会断'))
  })

  test('compile to cc_memory: appends to existing file', () => {
    const logger = makeLogger()
    const compiler = new Compiler({ db, logger, personaDir, ccMemoryDir, personaPacksDir })

    compiler.compile({
      target: 'cc_memory',
      content: 'LD 服务器直连 Anthropic 无需代理',
      reason: '网络拓扑知识',
    })

    const content = readFileSync(join(ccMemoryDir, 'compiled-knowledge.md'), 'utf8')
    // Both entries should exist
    assert.ok(content.includes('Docker 容器不能设全局 HTTP_PROXY'))
    assert.ok(content.includes('LD 服务器直连 Anthropic 无需代理'))
  })

  test('compile to persona: creates soul/identity.md in persona pack dir', () => {
    const logger = makeLogger()
    // Create the persona pack directory
    const testPersona = 'test-persona'
    mkdirSync(join(personaPacksDir, testPersona), { recursive: true })

    const compiler = new Compiler({ db, logger, personaDir, ccMemoryDir, personaPacksDir })

    const filePath = compiler.compile({
      target: 'persona',
      personaName: testPersona,
      content: '和用户说话要温柔',
      reason: '用户反馈',
    })

    assert.strictEqual(filePath, join(personaPacksDir, testPersona, 'soul', 'identity.md'))
    const content = readFileSync(filePath, 'utf8')
    assert.ok(content.includes('和用户说话要温柔'))
  })

  test('compile logs activity to db', () => {
    const logger = makeLogger()
    const compiler = new Compiler({ db, logger, personaDir, ccMemoryDir, personaPacksDir })

    compiler.compile({
      target: 'cc_memory',
      content: '日志检查内容',
      reason: '测试日志记录',
    })

    const activity = db.getActivity(10)
    assert.ok(activity.some(a => a.type === 'compile' && a.detail.includes('cc_memory')))
    // Logger should also have been called
    assert.ok(logger.logs.some(l => l.mod === 'compiler' && l.event === 'compiled'))
  })

  test('compile throws on unknown target', () => {
    const logger = makeLogger()
    const compiler = new Compiler({ db, logger, personaDir, ccMemoryDir, personaPacksDir })

    assert.throws(() => {
      compiler.compile({
        target: 'nonexistent' as any,
        content: 'test',
        reason: 'test',
      })
    }, /Unknown compile target/)
  })

  test('compile throws when persona target missing personaName', () => {
    const logger = makeLogger()
    const compiler = new Compiler({ db, logger, personaDir, ccMemoryDir, personaPacksDir })

    assert.throws(() => {
      compiler.compile({
        target: 'persona',
        content: 'test',
        reason: 'test',
      })
    }, /personaName required/)
  })
})
