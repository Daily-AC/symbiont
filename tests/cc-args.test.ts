import { describe, it } from 'node:test'
import assert from 'node:assert'

// 将要提取的纯函数：根据选项生成 CC CLI 参数
// import { buildCCArgs } from '../src/core/cc-args.ts'

describe('buildCCArgs', () => {
  it('should include --mcp-config when mcpServers provided in ws mode', async () => {
    const { buildCCArgs } = await import('../src/core/cc-args.ts')

    const args = buildCCArgs({
      sdkUrl: 'ws://127.0.0.1:12345/ws/test',
      mcpServers: {
        'symbiont-core': { type: 'http', url: 'http://127.0.0.1:9999/mcp' },
      },
    })

    // 必须包含 --mcp-config
    const mcpIdx = args.indexOf('--mcp-config')
    assert.ok(mcpIdx !== -1, 'should include --mcp-config flag')

    // --mcp-config 后面的值应该是合法 JSON
    const mcpConfigStr = args[mcpIdx + 1]
    assert.ok(mcpConfigStr, '--mcp-config should have a value')

    const mcpConfig = JSON.parse(mcpConfigStr)
    assert.ok(mcpConfig.mcpServers, 'should have mcpServers key')
    assert.ok(mcpConfig.mcpServers['symbiont-core'], 'should have sia-core server')
    assert.strictEqual(mcpConfig.mcpServers['symbiont-core'].url, 'http://127.0.0.1:9999/mcp')
  })

  it('should not include --mcp-config when no mcpServers', async () => {
    const { buildCCArgs } = await import('../src/core/cc-args.ts')

    const args = buildCCArgs({
      sdkUrl: 'ws://127.0.0.1:12345/ws/test',
    })

    assert.ok(!args.includes('--mcp-config'), 'should not include --mcp-config without servers')
  })

  it('should include --sdk-url in ws mode', async () => {
    const { buildCCArgs } = await import('../src/core/cc-args.ts')

    const args = buildCCArgs({
      sdkUrl: 'ws://127.0.0.1:12345/ws/test',
    })

    const idx = args.indexOf('--sdk-url')
    assert.ok(idx !== -1, 'should include --sdk-url')
    assert.strictEqual(args[idx + 1], 'ws://127.0.0.1:12345/ws/test')
  })

  it('should include --resume when sessionId provided', async () => {
    const { buildCCArgs } = await import('../src/core/cc-args.ts')

    const args = buildCCArgs({
      sdkUrl: 'ws://127.0.0.1:12345/ws/test',
      sessionId: 'session-abc',
    })

    const idx = args.indexOf('--resume')
    assert.ok(idx !== -1)
    assert.strictEqual(args[idx + 1], 'session-abc')
  })

  it('should include --plugin-dir for each pluginDir', async () => {
    const { buildCCArgs } = await import('../src/core/cc-args.ts')

    const args = buildCCArgs({
      sdkUrl: 'ws://127.0.0.1:12345/ws/test',
      pluginDirs: ['/path/to/plugin1', '/path/to/plugin2'],
    })

    const pluginDirIndices = args.reduce((acc: number[], arg, i) => {
      if (arg === '--plugin-dir') acc.push(i)
      return acc
    }, [])
    assert.strictEqual(pluginDirIndices.length, 2)
    assert.strictEqual(args[pluginDirIndices[0] + 1], '/path/to/plugin1')
    assert.strictEqual(args[pluginDirIndices[1] + 1], '/path/to/plugin2')
  })
})
