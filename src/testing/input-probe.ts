process.stdin.setRawMode(true);
let received = Buffer.alloc(0);
const size = () => console.log(`SIZE:${process.stdout.columns}x${process.stdout.rows}`);
process.stdout.on("resize", size);
process.stdin.on("data", (bytes: Buffer) => {
  received = Buffer.concat([received, bytes]);
  console.log(`RX:${received.toString("hex")}`);
  size();
});
console.log("PROBE_READY");
size();
