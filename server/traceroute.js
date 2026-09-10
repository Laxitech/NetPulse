import { spawn } from 'node:child_process';
import { detectCommand } from './parser.js';

let command = null;

async function ensureCommand() {
  if (command) return command;
  command = await detectCommand();
  return command;
}

function validateDestination(dest) {
  if (!dest || typeof dest !== 'string') return false;
  const trimmed = dest.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('-')) return false;
  // Allow IPv4, IPv6, hostnames
  if (/^[a-zA-Z0-9._:/-]+$/.test(trimmed)) return true;
  return false;
}

function runTraceroute(destination, onHop, onComplete, onError) {
  if (!validateDestination(destination)) {
    onError(new Error('Invalid destination'));
    return null;
  }

  let cmd = command;
  if (!cmd) {
    onError(new Error('Traceroute command not found. Install traceroute or tracepath.'));
    return null;
  }

  const args = cmd === 'traceroute'
    ? ['-n', '-q', '1', '-w', '2', destination]
    : ['-n', destination];

  const proc = spawn(cmd, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let buffer = '';
  let lineCount = 0;

  proc.stdout.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      lineCount++;
      if (lineCount === 1) continue; // skip header
      onHop(line);
    }
  });

  proc.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) {
      // Don't treat stderr as fatal — tracepath writes to stderr
    }
  });

  proc.on('close', (code) => {
    if (buffer.trim()) {
      lineCount++;
      if (lineCount > 1) onHop(buffer);
    }
    onComplete(code);
  });

  proc.on('error', (err) => {
    onError(err);
  });

  return proc;
}

export { runTraceroute, validateDestination, ensureCommand };
