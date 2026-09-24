import { stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { WorkspaceDefinition } from '@cmdz/core/workspace-definition'
import { Effect, Schema, flow } from 'effect'

const Definition = Schema.Struct({
  name: Schema.String,
  command: Schema.String,
  cwd: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  autostart: Schema.optionalKey(Schema.Boolean),
})

export class ConfigError extends Schema.TaggedError<ConfigError>()('ConfigError', {
  message: Schema.String,
}) {}

const resolveConfig = Effect.fn('config.validate')(function* (
  definitions: readonly (typeof Definition.Type)[],
  directory: string,
) {
  if (definitions.length === 0)
    return yield* Effect.fail(new ConfigError({ message: 'Define at least one command.' }))
  const names = new Set<string>()
  const result: WorkspaceDefinition[] = []
  for (const definition of definitions) {
    if (!definition.name.trim() || !definition.command.trim() || definition.title?.trim() === '') {
      return yield* Effect.fail(
        new ConfigError({
          message: 'Command names, titles, and command strings must not be empty.',
        }),
      )
    }
    if (names.has(definition.name)) {
      return yield* Effect.fail(
        new ConfigError({ message: `Duplicate command name: ${definition.name}` }),
      )
    }
    names.add(definition.name)
    const env = definition.env ?? {}
    if (
      definition.command.includes('\0') ||
      Object.entries(env).some(([key, value]) => !key || /[=\0]/.test(key) || value.includes('\0'))
    ) {
      return yield* Effect.fail(
        new ConfigError({
          message: `Invalid command or environment encoding for ${definition.name}.`,
        }),
      )
    }
    const cwd = resolve(directory, definition.cwd ?? '.')
    const info = yield* Effect.tryPromise({
      try: () => stat(cwd),
      catch: () =>
        new ConfigError({ message: `Working directory unavailable for ${definition.name}.` }),
    })
    if (!info.isDirectory())
      return yield* Effect.fail(
        new ConfigError({
          message: `Working directory is not a directory for ${definition.name}.`,
        }),
      )
    result.push({
      ...definition,
      cwd,
      env,
      title: definition.title ?? definition.name,
      autostart: definition.autostart ?? true,
    })
  }
  return result
})

export const parseConfig = (directory: string) =>
  flow(
    Schema.decodeUnknownEffect(Schema.Array(Definition), { onExcessProperty: 'error' }),
    Effect.mapError(
      () =>
        new ConfigError({
          message:
            'cmdz.ts must default-export an array of Command definitions with valid field types.',
        }),
    ),
    Effect.flatMap((definitions) => resolveConfig(definitions, directory)),
  )

export const loadConfig = Effect.fn('config.load')(function* (file: string) {
  const absolute = resolve(file)
  const module: unknown = yield* Effect.tryPromise({
    try: () => import(pathToFileURL(absolute).href),
    catch: () =>
      new ConfigError({
        message: `Unable to load ${absolute}. Check that it exists and imports successfully.`,
      }),
  })
  const exported = yield* Schema.decodeUnknownEffect(Schema.Struct({ default: Schema.Unknown }))(
    module,
  ).pipe(Effect.mapError(() => new ConfigError({ message: 'cmdz.ts must have a default export.' })))
  return yield* parseConfig(dirname(absolute))(exported.default)
})
