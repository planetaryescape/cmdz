import { expect, test } from 'bun:test'

import { Effect } from 'effect'

import { FakeWorkspace, pane } from './workspace-core'

test('drives a headless command lifecycle without OpenTUI or a child process', async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const workspace = yield* FakeWorkspace.make([
        { name: 'Web', title: 'Web', command: 'web', cwd: '/', env: {}, autostart: false },
      ])
      yield* workspace.start('Web')
      workspace.write('Web', new TextEncoder().encode('ready'))
      const finished = yield* workspace.exit('Web', 0)
      return { finished, output: workspace.output.get('Web') }
    }),
  )

  expect(pane(result.finished, 'Web')?.status).toBe('succeeded')
  expect(new TextDecoder().decode(result.output?.[0])).toBe('ready')
})
