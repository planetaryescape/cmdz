import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { captureWorkspace } from './capture-workspace'

test('captures representative states through the real workspace seam', async () => {
  const output = await mkdtemp(join(tmpdir(), 'cmdz-capture-'))
  try {
    const captures = await captureWorkspace(output)
    expect(captures.map((capture) => capture.name)).toEqual(['navigation', 'input', 'help'])

    const navigation = await readFile(join(output, 'navigation.svg'), 'utf8')
    const input = await readFile(join(output, 'input.svg'), 'utf8')
    const help = await readFile(join(output, 'help.svg'), 'utf8')
    expect(navigation).toContain('NAVIGATION')
    expect(navigation).toContain('Optional')
    expect(navigation).toContain('<path d=')
    expect(navigation).not.toContain('<text')
    expect(navigation).not.toContain('font-family')
    expect(input).toContain('INPUT')
    expect(input).toContain('You typed: hello from Amp')
    expect(help).toContain('cmdz shortcuts')
  } finally {
    await rm(output, { recursive: true, force: true })
  }
}, 15000)
