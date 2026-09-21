import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { captureWorkspace } from './capture-workspace'

test('captures representative states through the real workspace seam', async () => {
  const output = await mkdtemp(join(tmpdir(), 'cmdz-capture-'))
  try {
    const captures = await captureWorkspace(output)
    expect(captures.map((capture) => capture.name)).toEqual([
      'navigation',
      'input',
      'help',
      'compact-navigation',
      'compact-help',
    ])

    const navigation = await readFile(join(output, 'navigation.svg'), 'utf8')
    const input = await readFile(join(output, 'input.svg'), 'utf8')
    const help = await readFile(join(output, 'help.svg'), 'utf8')
    const compactNavigation = await readFile(join(output, 'compact-navigation.svg'), 'utf8')
    const compactHelp = await readFile(join(output, 'compact-help.svg'), 'utf8')
    expect(navigation).toContain('NAVIGATION')
    expect(navigation).toContain('Optional')
    expect(navigation).toContain('<path d="M')
    expect(navigation).not.toContain('<text')
    expect(navigation).not.toContain('font-family')
    expect(input).toContain('INPUT')
    expect(input).toContain('You typed: hello from Amp')
    expect(help).toContain('cmdz shortcuts')
    expect(compactNavigation).toContain('Commands')
    expect(compactNavigation).not.toContain('COMMANDS · 2')
    expect(compactHelp).toContain('Esc close')
    expect(compactHelp).toContain('Ctrl-C interrupt child')
  } finally {
    await rm(output, { recursive: true, force: true })
  }
}, 15000)
