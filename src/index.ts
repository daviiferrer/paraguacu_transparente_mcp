#!/usr/bin/env node

const originalStdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = function (chunk: any, ...args: any[]) {
  const str = typeof chunk === 'string' ? chunk : (Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk));
  if (str.trimStart().startsWith('{') && str.includes('"jsonrpc"')) {
    return originalStdoutWrite(chunk, ...args);
  }
  return process.stderr.write(chunk, ...args);
};
console.log = (...args) => process.stderr.write(args.map(String).join(' ') + '\n');
console.warn = (...args) => process.stderr.write(args.map(String).join(' ') + '\n');
console.info = (...args) => process.stderr.write(args.map(String).join(' ') + '\n');
console.debug = (...args) => process.stderr.write(args.map(String).join(' ') + '\n');
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  process.stderr.write(`[Node Warning] ${warning.name}: ${warning.message}\n`);
});

import { TRANSPORT_MODE } from './runtime.js';
import { startHttp, startStdio } from './transports.js';

async function main(): Promise<void> {
  if (TRANSPORT_MODE === 'http') {
    await startHttp();
    return;
  }
  await startStdio();
}

main().catch((err) => {
  process.stderr.write(`Falha ao iniciar MCP: ${String(err)}\n`);
  process.exit(1);
});
