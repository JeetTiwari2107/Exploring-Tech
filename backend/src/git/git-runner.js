import { spawn } from 'node:child_process';

const defaultOutputLimit = 1024 * 1024;

function gitEnvironment() {
  const keep = ['PATH', 'SYSTEMROOT', 'WINDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'SSH_AUTH_SOCK', 'SSH_AGENT_PID'];
  const env = Object.fromEntries(keep.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
  env.GIT_TERMINAL_PROMPT = '0';
  env.GCM_INTERACTIVE = 'Never';
  env.GIT_OPTIONAL_LOCKS = '0';
  return env;
}

export function runGit(cwd, args, { timeoutMs = 10_000, outputLimit = defaultOutputLimit } = {}) {
  if (typeof cwd !== 'string' || !Array.isArray(args) || args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
    return Promise.reject(new TypeError('Git requires a working directory and a string argument list.'));
  }
  const timeout = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(timeoutMs, 60_000)) : 10_000;
  const limit = Number.isFinite(outputLimit) ? Math.max(0, Math.min(outputLimit, 4 * 1024 * 1024)) : defaultOutputLimit;

  return new Promise((resolve, reject) => {
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const stdout = [];
    const stderr = [];
    const safeArgs = ['-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', ...args];
    const child = spawn('git', safeArgs, {
      cwd,
      env: gitEnvironment(),
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const capture = (chunks, chunk, used, stream) => {
      const remaining = Math.max(0, limit - stdoutBytes - stderrBytes);
      const accepted = chunk.subarray(0, remaining);
      if (accepted.length < chunk.length) truncated = true;
      if (accepted.length) chunks.push(accepted);
      if (stream === 'stdout') stdoutBytes += accepted.length;
      else stderrBytes += accepted.length;
      return used;
    };
    child.stdout.on('data', (chunk) => capture(stdout, chunk, stdoutBytes, 'stdout'));
    child.stderr.on('data', (chunk) => capture(stderr, chunk, stderrBytes, 'stderr'));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeout);
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(error.code === 'ENOENT' ? 'Git is not installed or is not available on PATH.' : 'Git could not be started.'));
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        exitCode: timedOut ? null : code,
        timedOut,
        truncated,
      });
    });
    child.stdin.end();
  });
}
