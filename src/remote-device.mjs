import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const AGENT_NAME = '@wonderwhy-er/desktop-commander';
const AGENT_VERSION = '0.3.0';
const AGENT_ENTRY = 'agent/node_modules/@wonderwhy-er/desktop-commander/dist/index.js';
const RUNTIME_ENTRY = 'runtime/node.exe';
const DASHBOARD_URL = 'https://mcp.desktopcommander.app/';
const DOCUMENTATION_URL = 'https://github.com/desktop-commander/remote-desktop-commander/blob/main/docs/SETUP.md';
const MAX_LINES = 120;
const MAX_LINE = 2000;
const MAX_BUFFER = 8192;

function plainLog(value) {
  return String(value)
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .replace(/\bBearer\s+[^\s,;"'<>]+/gi, 'Bearer [skjult]')
    .replace(/(["']?(?:(?:access|refresh|id|session)[_-]?)?token["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&"'<>]+)/gi, '$1[skjult]')
    .replace(/(["']?(?:authorization|client[_-]?secret|api[_-]?key|password|credentials|secret)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&"'<>]+)/gi, '$1[skjult]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[skjult token]')
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g, '[skjult nøkkel]')
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[skjult]@');
}

function isFileWithin(root, relative) {
  const resolved = realpathSync(path.join(root, relative));
  const inside = path.relative(realpathSync(root), resolved);
  return inside && !inside.startsWith(`..${path.sep}`) && inside !== '..' && !path.isAbsolute(inside) && statSync(resolved).isFile();
}

function probeBundle(runtimeDirectory, platform) {
  let packagedRuntime = false;
  try {
    packagedRuntime = Boolean(isFileWithin(runtimeDirectory, RUNTIME_ENTRY));
    if (platform !== 'win32') return { available: false, packagedRuntime, error: 'PC-tilkobling støttes foreløpig bare på Windows.' };
    if (!packagedRuntime) throw new Error();
    const manifest = JSON.parse(readFileSync(path.join(runtimeDirectory, 'bundle.json'), 'utf8'));
    const version = /^(\d+)\.(\d+)\.(\d+)$/.exec(manifest.runtime?.version || '');
    if (!version || Number(version[1]) < 22 || (Number(version[1]) === 22 && Number(version[2]) < 12)
      || manifest.runtime?.entry !== RUNTIME_ENTRY || manifest.agent?.entry !== AGENT_ENTRY
      || manifest.agent?.name !== AGENT_NAME || manifest.agent?.version !== AGENT_VERSION || manifest.license !== 'MIT') throw new Error();
    if (!isFileWithin(runtimeDirectory, AGENT_ENTRY) || !isFileWithin(runtimeDirectory, 'agent/node_modules/@wonderwhy-er/desktop-commander/package.json')) throw new Error();
    const agent = JSON.parse(readFileSync(path.join(runtimeDirectory, 'agent/node_modules/@wonderwhy-er/desktop-commander/package.json'), 'utf8'));
    if (agent.name !== AGENT_NAME || agent.version !== AGENT_VERSION || agent.license !== 'MIT') throw new Error();
    return { available: true, packagedRuntime: true };
  } catch {
    return { available: false, packagedRuntime, error: 'Remote Desktop Commander mangler eller har feil versjon i denne pakken. Last ned en komplett Windows-pakke.' };
  }
}

function childEnvironment(runtimeDirectory, platform) {
  const environment = { ...process.env };
  const pathKey = Object.keys(environment).find(key => key.toLowerCase() === 'path') || 'PATH';
  environment[pathKey] = `${path.join(runtimeDirectory, 'runtime')}${platform === 'win32' ? ';' : ':'}${environment[pathKey] || ''}`;
  // Keep the student's own home and certificate settings, but never inherit TLS bypasses or injected Node loaders.
  for (const key of Object.keys(environment)) {
    if (['node_options', 'node_tls_reject_unauthorized', 'electron_run_as_node'].includes(key.toLowerCase())) delete environment[key];
  }
  const safeOptions = (process.env.NODE_OPTIONS || '').split(/\s+/).filter(option => /^(?:--enable-source-maps|--max-old-space-size=\d{1,6}|--stack-size=\d{1,6})$/.test(option));
  if (safeOptions.length) environment.NODE_OPTIONS = safeOptions.join(' ');
  environment.NODE_USE_SYSTEM_CA = '1';
  environment.MCP_SERVER_URL = 'https://mcp.desktopcommander.app';
  return environment;
}

function taskkill(spawnImpl, pid) {
  return new Promise((resolve, reject) => {
    let killer, timer;
    const finish = (error) => { clearTimeout(timer); error ? reject(error) : resolve(); };
    try {
      const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
      killer = spawnImpl(executable, ['/PID', String(pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
      killer.once('error', finish);
      killer.once('close', code => finish(code === 0 ? null : new Error('Prosessene kunne ikke stoppes.')));
      timer = setTimeout(() => { try { killer.kill(); } catch {} finish(new Error('Tidsavbrudd ved stopp av PC-tilkobling.')); }, 10000);
    } catch (error) { finish(error); }
  });
}

/** Runs the bundled agent only after start(). It does not register, enroll, or configure a computer. */
export function createRemoteDeviceService({ runtimeDirectory, directory, onStatus = () => {}, spawnImpl = spawn, platform = process.platform }) {
  runtimeDirectory = path.resolve(runtimeDirectory);
  directory = path.resolve(directory);
  let state = 'stopped', error = null, logs = [], generation = 0, current = null, launch = null, stopping = null;

  function status() {
    const bundle = probeBundle(runtimeDirectory, platform);
    return { ...bundle, state, running: Boolean(current && !current.closed), logs: [...logs], ...(error ? { error } : {}), dashboardUrl: DASHBOARD_URL, documentationUrl: DOCUMENTATION_URL };
  }
  function publish() { const value = status(); try { onStatus(value); } catch { /* A closed renderer does not change the owned process lifecycle. */ } return value; }
  function fail(reason) { error = plainLog(reason?.message || reason || 'PC-tilkoblingen kunne ikke startes.').slice(0, MAX_LINE); state = 'error'; return publish(); }
  function append(value) {
    const line = plainLog(value).slice(0, MAX_LINE).trim();
    if (!line) return;
    logs.push(line); if (logs.length > MAX_LINES) logs.splice(0, logs.length - MAX_LINES);
    publish();
  }
  function watchOutput(stream, record) {
    if (!stream?.on) return;
    const decoder = new StringDecoder('utf8');
    let buffer = '', dropping = false;
    function consume(value, final = false) {
      if (record !== current || record.generation !== generation) return;
      buffer += value;
      for (;;) {
        const end = buffer.indexOf('\n');
        if (end < 0) break;
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!dropping) append(line.length > MAX_BUFFER ? '[Lang logglinje utelatt]' : line);
        dropping = false;
      }
      if (buffer.length > MAX_BUFFER) { if (!dropping) append('[Lang logglinje utelatt]'); buffer = ''; dropping = true; }
      if (final && buffer && !dropping) { append(buffer); buffer = ''; }
    }
    stream.on('data', value => consume(decoder.write(Buffer.isBuffer(value) ? value : Buffer.from(String(value)))));
    stream.once('end', () => consume(decoder.end(), true));
  }

  async function start() {
    if (stopping) { await stopping; if (current && !current.closed) return status(); return start(); }
    if (launch) return launch;
    if (current && !current.closed) return status();
    const bundle = probeBundle(runtimeDirectory, platform);
    if (!bundle.available) return fail(bundle.error);
    const attempt = ++generation;
    logs = []; error = null; state = 'starting'; publish();
    const pending = (async () => {
      try {
        await mkdir(directory, { recursive: true });
        if (attempt !== generation) return status();
        const checked = probeBundle(runtimeDirectory, platform);
        if (!checked.available) return fail(checked.error);
        const child = spawnImpl(path.join(runtimeDirectory, RUNTIME_ENTRY), [path.join(runtimeDirectory, AGENT_ENTRY), 'remote'], {
          cwd: directory, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: childEnvironment(runtimeDirectory, platform),
        });
        let readyResolve, closedResolve;
        const record = { child, generation: attempt, closed: false, spawned: false, ready: new Promise(resolve => { readyResolve = resolve; }), done: new Promise(resolve => { closedResolve = resolve; }) };
        record.resolveReady = readyResolve;
        current = record;
        watchOutput(child.stdout, record); watchOutput(child.stderr, record);
        child.once('spawn', () => {
          record.spawned = true;
          if (current === record && generation === record.generation) { state = 'running'; error = null; publish(); }
          readyResolve();
        });
        child.on('error', reason => {
          if (!record.spawned) { record.closed = true; closedResolve(); }
          if (current === record && generation === record.generation) { if (!record.spawned) current = null; fail(reason); }
          readyResolve();
        });
        child.once('close', (code, signal) => {
          record.closed = true; closedResolve(); readyResolve();
          if (current !== record || generation !== record.generation) return;
          current = null;
          if (code === 0) { state = 'stopped'; error = null; publish(); }
          else fail(`PC-tilkoblingen avsluttet (${signal || code || 'ukjent feil'}).`);
        });
        await record.ready;
        return status();
      } catch (reason) { return attempt === generation ? fail(reason) : status(); }
    })();
    launch = pending;
    try { return await pending; } finally { if (launch === pending) launch = null; }
  }

  async function stop() {
    if (stopping) return stopping;
    ++generation;
    const pending = (async () => {
      const record = current;
      try {
        if (record && !record.closed) {
          if (platform === 'win32' && Number.isSafeInteger(record.child.pid) && record.child.pid > 0) {
            await taskkill(spawnImpl, record.child.pid);
            record.closed = true; // Successful taskkill /T confirms that the owned process tree has ended.
            record.resolveReady();
          } else {
            if (!record.child.kill('SIGTERM')) throw new Error('PC-tilkoblingen kunne ikke stoppes.');
            await record.done;
          }
        }
        if (launch) await launch;
        if (current === record) current = null;
        state = 'stopped'; error = null;
        return publish();
      } catch (reason) {
        if (record === current && !record.closed) record.generation = generation;
        return fail(reason);
      }
    })();
    stopping = pending;
    try { return await pending; } finally { if (stopping === pending) stopping = null; }
  }

  return { status, start, stop };
}
