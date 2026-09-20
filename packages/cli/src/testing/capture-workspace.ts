import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import type { CapturedFrame } from '@opentui/core'
import { parse } from 'opentype.js'

import { createWorkspace } from './workspace'

const cellWidth = 10
const cellHeight = 20
const padding = 16
const defaultBackground = '#0d1117'
const defaultForeground = '#e6edf3'
const demoDirectory = resolve(import.meta.dir, '..')
const captureFonts = Promise.all([
  loadFont('DejaVuSansMono.ttf'),
  loadFont('DejaVuSansMono-Bold.ttf'),
])

/** File paths emitted for one captured TUI state. */
export interface WorkspaceCapture {
  readonly name: 'navigation' | 'input' | 'help'
  readonly svg: string
  readonly png?: string | undefined
}

/** Captures representative cmdz states through the real workspace and PTY adapters. */
export async function captureWorkspace(
  outputDirectory: string,
): Promise<readonly WorkspaceCapture[]> {
  const output = resolve(outputDirectory)
  await mkdir(output, { recursive: true })
  const workspace = await createWorkspace([
    {
      name: 'Demo',
      title: 'Demo',
      command: 'bun run demo-command.ts',
      cwd: demoDirectory,
      env: {},
      autostart: true,
    },
    {
      name: 'Optional',
      title: 'Optional',
      command: 'bun run demo-command.ts',
      cwd: demoDirectory,
      env: {},
      autostart: false,
    },
  ])
  const captures: WorkspaceCapture[] = []

  try {
    await workspace.waitFor('Demo [running]')
    await workspace.waitFor('cmdz demo')
    captures.push(await saveFrame(output, 'navigation', workspace.captureSpans()))

    workspace.mockInput.pressEnter()
    await workspace.waitFor('INPUT')
    await workspace.mockInput.typeText('hello from Amp')
    workspace.mockInput.pressEnter()
    await workspace.waitFor('You typed: hello from Amp')
    captures.push(await saveFrame(output, 'input', workspace.captureSpans()))

    workspace.mockInput.pressKey('z', { ctrl: true })
    await workspace.waitFor('NAVIGATION')
    workspace.mockInput.pressKey('?')
    await workspace.waitFor('cmdz shortcuts')
    captures.push(await saveFrame(output, 'help', workspace.captureSpans()))
  } finally {
    await workspace.close()
  }

  return captures
}

async function saveFrame(
  outputDirectory: string,
  name: WorkspaceCapture['name'],
  frame: CapturedFrame,
): Promise<WorkspaceCapture> {
  const svg = resolve(outputDirectory, `${name}.svg`)
  await writeFile(svg, await renderSvg(frame), 'utf8')

  const magick = Bun.which('magick')
  if (!magick) return { name, svg }

  const png = resolve(outputDirectory, `${name}.png`)
  const converted = Bun.spawnSync([magick, svg, png], { stderr: 'pipe' })
  if (converted.exitCode !== 0) {
    const diagnostic = converted.stderr.toString().trim()
    throw new Error(`Unable to convert ${name}.svg to PNG${diagnostic ? `: ${diagnostic}` : '.'}`)
  }
  return { name, svg, png }
}

async function renderSvg(frame: CapturedFrame) {
  const width = frame.cols * cellWidth + padding * 2
  const height = frame.rows * cellHeight + padding * 2
  const [regular, bold] = await captureFonts
  const elements = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="${width}" height="${height}" rx="10" fill="${defaultBackground}"/>`,
  ]

  for (const [row, line] of frame.lines.entries()) {
    let column = 0
    for (const span of line.spans) {
      const x = padding + column * cellWidth
      const y = padding + row * cellHeight
      const background = color(span.bg.toInts(), defaultBackground)
      const foreground = color(span.fg.toInts(), defaultForeground)
      if (background !== defaultBackground)
        elements.push(
          `<rect x="${x}" y="${y}" width="${span.width * cellWidth}" height="${cellHeight}" fill="${background}"/>`,
        )
      if (span.text) {
        const font = span.attributes & 1 ? bold : regular
        const path = font.getPath(span.text, x, y + 15, 15, { kerning: false }).toPathData(2)
        elements.push(
          `<path d="${path}" fill="${foreground}" aria-label="${escapeXml(span.text)}"/>`,
        )
      }
      column += span.width
    }
  }

  elements.push('</svg>')
  return elements.join('\n')
}

async function loadFont(name: 'DejaVuSansMono.ttf' | 'DejaVuSansMono-Bold.ttf') {
  const bytes = await Bun.file(resolve(import.meta.dir, 'fonts', name)).arrayBuffer()
  return parse(bytes)
}

function color([red, green, blue, alpha]: [number, number, number, number], fallback: string) {
  return alpha === 0 ? fallback : `rgb(${red} ${green} ${blue})`
}

function escapeXml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

if (import.meta.main) {
  const outputDirectory = process.argv[2] ?? '.amp/in/artifacts/cmdz'
  const captures = await captureWorkspace(outputDirectory)
  for (const capture of captures) console.log(`${capture.name}: ${capture.png ?? capture.svg}`)
}
