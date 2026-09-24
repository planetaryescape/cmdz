import { expect, test } from 'bun:test'

import { EmbeddedTerminalRenderable } from '@opentui/core'
import { createTestRenderer } from '@opentui/core/testing'
import { Deferred, Effect, Fiber } from 'effect'

import { makePtyProcessDriver, runPty } from './pty-process'

test('renders real PTY ANSI output and preserves output after exit', async () => {
  const { renderer, renderOnce } = await createTestRenderer({ width: 80, height: 24 })
  const terminal = new EmbeddedTerminalRenderable(renderer, { width: 80, height: 24 })
  renderer.root.add(terminal)
  try {
    await renderOnce()
    const code = await Effect.runPromise(
      runPty(
        [process.execPath, '-e', 'console.log("\\x1b[31mHello λ\\x1b[0m"); process.exitCode = 7;'],
        { columns: 80, rows: 24, output: (bytes) => terminal.write(bytes), attach: () => {} },
      ),
    )
    await renderOnce()
    expect(code).toBe(7)
    expect(terminal.screen().text).toContain('Hello λ')
    expect(terminal.screen().text).not.toContain('\x1b[31m')
  } finally {
    renderer.destroy()
  }
})

test('passes a resolved cwd and environment overlay to the shell', async () => {
  let output = ''
  const cwd = process.cwd()
  const code = await Effect.runPromise(
    runPty(
      ['/bin/sh', '-c', 'printf "%s|%s|%s" "$PWD" "$CMDZ_TEST_VALUE" "$PATH"'],
      {
        columns: 80,
        rows: 24,
        attach: () => {},
        output: (bytes) => {
          output += new TextDecoder().decode(bytes)
        },
      },
      { cwd, env: { CMDZ_TEST_VALUE: 'overridden' } },
    ),
  )
  expect(code).toBe(0)
  expect(output).toContain(`${cwd}|overridden|${process.env.PATH}`)
})

test('reports attachment failure only after releasing the spawned PTY', async () => {
  let attached: Bun.Terminal | undefined
  let detached = false
  const error = await Effect.runPromise(
    Effect.flip(
      runPty(['/bin/sleep', '60'], {
        columns: 80,
        rows: 24,
        output: () => {},
        attach: (terminal) => {
          if (!terminal) {
            detached = true
            return
          }
          attached = terminal
          throw new Error('terminal attachment failed')
        },
      }),
    ),
  )

  expect(error).toMatchObject({ _tag: 'ProcessStartError', operation: 'attach' })
  expect(detached).toBe(true)
  expect(attached?.closed).toBe(true)
}, 8000)

test('interrupting a run terminates its process group and closes the PTY', async () => {
  let childPid = 0
  let grandchildPid = 0
  let attached: Bun.Terminal | undefined
  const program = Effect.gen(function* () {
    const ready = yield* Deferred.make<void>()
    let output = ''
    const fiber = yield* runPty(
      [
        process.execPath,
        '-e',
        'const child = Bun.spawn(["/bin/sleep", "60"]); console.log(`${process.pid},${child.pid}`); await child.exited;',
      ],
      {
        columns: 80,
        rows: 24,
        attach: (value) => {
          if (value) attached = value
        },
        output: (bytes) => {
          output += new TextDecoder().decode(bytes)
          const match = output.match(/(\d+),(\d+)/)
          if (match) {
            childPid = Number(match[1])
            grandchildPid = Number(match[2])
            Effect.runSync(Deferred.succeed(ready, undefined))
          }
        },
      },
    ).pipe(Effect.forkScoped)
    yield* Deferred.await(ready)
    yield* Fiber.interrupt(fiber)
  }).pipe(Effect.scoped)

  await Effect.runPromise(program)
  expect(childPid).toBeGreaterThan(0)
  expect(grandchildPid).toBeGreaterThan(0)
  expect(attached?.closed).toBe(true)
  expect(() => process.kill(childPid, 0)).toThrow()
  const descendant = Bun.spawnSync(['ps', '-o', 'stat=', '-p', String(grandchildPid)])
  expect(descendant.stdout.toString().trim().replace(/^Z.*$/, '')).toBe('')
}, 8000)

test('waits for explicit force before killing a TERM-ignoring process group', async () => {
  let childPid = 0
  let descendantPid = 0
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>()
      let output = ''
      const run = yield* makePtyProcessDriver().start({
        name: 'term-ignoring',
        run: 1,
        command: [
          process.execPath,
          '-e',
          'process.on("SIGTERM", () => {}); const child = Bun.spawn(["/bin/sh", "-c", "trap \'\' TERM; while :; do sleep 1; done"]); console.log(`${process.pid},${child.pid}`); await new Promise(() => {});',
        ],
        cwd: process.cwd(),
        env: process.env,
        size: { columns: 80, rows: 24 },
        output: (bytes) => {
          output += new TextDecoder().decode(bytes)
          const match = output.match(/(\d+),(\d+)/)
          if (match) {
            childPid = Number(match[1])
            descendantPid = Number(match[2])
            Effect.runSync(Deferred.succeed(ready, undefined))
          }
        },
      })
      yield* Deferred.await(ready)
      const cleanup = yield* Effect.all([run.cleanup, run.cleanup], {
        concurrency: 'unbounded',
      }).pipe(Effect.forkScoped)
      expect(() => process.kill(childPid, 0)).not.toThrow()
      yield* run.forceCleanup
      yield* Fiber.join(cleanup)
      yield* run.cleanup
      return { exitCode: yield* run.awaitExit }
    }).pipe(Effect.scoped),
  )

  expect(result.exitCode).not.toBe(0)
  expect(childPid).toBeGreaterThan(0)
  expect(descendantPid).toBeGreaterThan(0)
  expect(() => process.kill(childPid, 0)).toThrow()
  const descendant = Bun.spawnSync(['ps', '-o', 'stat=', '-p', String(descendantPid)])
  expect(descendant.stdout.toString().trim().replace(/^Z.*$/, '')).toBe('')
}, 8000)

test('lets a child finish graceful cleanup beyond three seconds', async () => {
  let output = ''
  const code = await Effect.runPromise(
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>()
      const run = yield* makePtyProcessDriver().start({
        name: 'slow-cleanup',
        run: 1,
        command: [
          process.execPath,
          '-e',
          'process.on("SIGTERM", () => setTimeout(() => { console.log("CLEANUP_DONE"); process.exit(0) }, 3200)); console.log("READY"); await new Promise(() => {});',
        ],
        cwd: process.cwd(),
        env: process.env,
        size: { columns: 80, rows: 24 },
        output: (bytes) => {
          output += new TextDecoder().decode(bytes)
          if (output.includes('READY')) Effect.runSync(Deferred.succeed(ready, undefined))
        },
      })
      yield* Deferred.await(ready)
      yield* run.cleanup
      return yield* run.awaitExit
    }),
  )
  expect(code).toBe(0)
  expect(output).toContain('CLEANUP_DONE')
}, 8000)

test('force-kills a TERM-ignoring group member after its leader exits', async () => {
  let leaderPid = 0
  let descendantPid = 0
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const ready = yield* Deferred.make<void>()
        let output = ''
        const run = yield* makePtyProcessDriver().start({
          name: 'exited-leader',
          run: 1,
          command: [
            '/bin/sh',
            '-c',
            "trap '' TERM HUP; while :; do sleep 1; done </dev/null >/dev/null 2>&1 & descendant=$!; printf '%s,%s\\n' $$ $descendant",
          ],
          cwd: process.cwd(),
          env: process.env,
          size: { columns: 80, rows: 24 },
          output: (bytes) => {
            output += new TextDecoder().decode(bytes)
            const match = output.match(/(\d+),(\d+)/)
            if (match) {
              leaderPid = Number(match[1])
              descendantPid = Number(match[2])
              Effect.runSync(Deferred.succeed(ready, undefined))
            }
          },
        })
        yield* Deferred.await(ready)
        expect(yield* run.awaitExit).toBe(0)
        expect(() => process.kill(-leaderPid, 0)).not.toThrow()
        yield* run.forceCleanup
        yield* run.cleanup
      }),
    )

    expect(leaderPid).toBeGreaterThan(0)
    expect(descendantPid).toBeGreaterThan(0)
    expect(() => process.kill(-leaderPid, 0)).toThrow()
  } finally {
    if (leaderPid > 0) {
      try {
        process.kill(-leaderPid, 'SIGKILL')
      } catch {
        // The expected implementation has already removed the process group.
      }
    }
  }
}, 8000)
