import { createInterface } from 'node:readline'

console.log('\x1b[36mcmdz demo\x1b[0m')
console.log("Type a message, 'size', or 'exit'. Ctrl-C stops this process.")

const input = createInterface({ input: process.stdin, output: process.stdout })
input.setPrompt('demo> ')
input.prompt()
process.on('SIGWINCH', () => {
  console.log(`resized:${process.stdout.columns}x${process.stdout.rows}`)
  input.prompt()
})
input.on('line', (line) => {
  if (line === 'exit') {
    input.close()
    return
  }
  console.log(
    line === 'size'
      ? `size:${process.stdout.columns}x${process.stdout.rows}`
      : `You typed: ${line}`,
  )
  input.prompt()
})
