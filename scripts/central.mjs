/** Publish the exact accepted Java artifacts; never rebuild them during publish. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const PORTAL = 'https://central.sonatype.com/api/v1/publisher/';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export class CentralError extends Error {
  constructor(message, details = {}) { super(message); this.name = 'CentralError'; Object.assign(this, details); }
}
function credentials(environment) {
  const username = environment.CENTRAL_TOKEN_USERNAME, password = environment.CENTRAL_TOKEN_PASSWORD;
  if (!username || !password) throw new CentralError('CENTRAL_TOKEN_USERNAME and CENTRAL_TOKEN_PASSWORD are required');
  return 'Bearer ' + Buffer.from(username + ':' + password, 'utf8').toString('base64');
}
function safe(value, environment) {
  let result = String(value);
  const secrets = [environment.CENTRAL_TOKEN_USERNAME, environment.CENTRAL_TOKEN_PASSWORD, environment.MAVEN_GPG_PASSPHRASE];
  if (environment.CENTRAL_TOKEN_USERNAME && environment.CENTRAL_TOKEN_PASSWORD) secrets.push(Buffer.from(environment.CENTRAL_TOKEN_USERNAME + ':' + environment.CENTRAL_TOKEN_PASSWORD).toString('base64'));
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) result = result.split(secret).join('[redacted]');
  return result;
}
function childEnvironment(environment) {
  const child = { ...environment };
  delete child.CENTRAL_TOKEN_USERNAME; delete child.CENTRAL_TOKEN_PASSWORD; delete child.MAVEN_GPG_PASSPHRASE;
  return child;
}
function deploymentId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new CentralError('Central returned an invalid deployment ID; inspect Portal before retrying upload');
  return value;
}

export async function uploadCentral({ bundlePath, name, environment, fetch: request = globalThis.fetch, requestTimeoutMs = 120_000 }) {
  const authorization = credentials(environment);
  const body = new FormData();
  body.append('bundle', new Blob([readFileSync(bundlePath)], { type: 'application/octet-stream' }), basename(bundlePath));
  const url = new URL('upload', PORTAL); url.searchParams.set('name', name); url.searchParams.set('publishingType', 'AUTOMATIC');
  let response;
  try { response = await request(url, { method: 'POST', headers: { Authorization: authorization }, body, redirect: 'error', signal: AbortSignal.timeout(requestTimeoutMs) }); }
  catch { throw new CentralError('Central upload did not return a deployment ID; its outcome may be uncertain, inspect Portal before retrying'); }
  if (response.status !== 201) {
    const raw = safe(await response.text(), environment);
    throw new CentralError(`Central upload failed (HTTP ${response.status}): ${raw}`, { httpStatus: response.status });
  }
  try { return deploymentId((await response.text()).trim()); }
  catch (error) { if (error instanceof CentralError) throw error; throw new CentralError('Central upload response was interrupted; inspect Portal before retrying'); }
}

export async function pollCentral({ deploymentId: id, environment, fetch: request = globalThis.fetch, delay = sleep, now = Date.now, timeoutMs = 30 * 60_000, pollIntervalMs = 10_000, requestTimeoutMs = 30_000 }) {
  deploymentId(id);
  const authorization = credentials(environment), deadline = now() + timeoutMs;
  if (!(timeoutMs > 0 && pollIntervalMs > 0 && requestTimeoutMs > 0)) throw new CentralError('Central polling timeouts must be positive');
  while (true) {
    const remaining = deadline - now();
    if (remaining <= 0) throw new CentralError(`Central deployment ${id} is still pending after the polling deadline; resume this deployment without uploading again`, { deploymentId: id });
    const url = new URL('status', PORTAL); url.searchParams.set('id', id);
    let response;
    try { response = await request(url, { method: 'POST', headers: { Authorization: authorization }, redirect: 'error', signal: AbortSignal.timeout(Math.max(1, Math.min(remaining, requestTimeoutMs))) }); }
    catch { throw new CentralError(`Central deployment ${id} status request failed; resume polling without uploading again`, { deploymentId: id }); }
    if (!response.ok) {
      const raw = safe(await response.text(), environment);
      throw new CentralError(`Central deployment ${id} status failed (HTTP ${response.status}): ${raw}`, { deploymentId: id, httpStatus: response.status });
    }
    let status;
    try { status = await response.json(); }
    catch { throw new CentralError(`Central deployment ${id} returned invalid status JSON`, { deploymentId: id }); }
    if (status.deploymentId && status.deploymentId !== id) throw new CentralError(`Central status returned a different deployment ID`, { deploymentId: id });
    const state = status.deploymentState;
    if (state === 'PUBLISHED') return { deploymentId: id, deploymentState: state };
    if (state === 'FAILED') throw new CentralError(`Central deployment ${id} FAILED: ${safe(JSON.stringify(status.errors ?? {}), environment)}`, { deploymentId: id, deploymentState: state });
    if (!['PENDING', 'VALIDATING', 'VALIDATED', 'PUBLISHING'].includes(state)) throw new CentralError(`Central deployment ${id} returned an unknown state`, { deploymentId: id });
    await delay(Math.max(1, Math.min(pollIntervalMs, deadline - now())));
  }
}

export async function publishCentral({ root, info, manifest, python, environment, resumeId, onUploaded = () => {}, run, fetch, delay, now, timeoutMs, pollIntervalMs, requestTimeoutMs }) {
  credentials(environment);
  if (resumeId) return pollCentral({ deploymentId: resumeId, environment, fetch, delay, now, timeoutMs, pollIntervalMs, requestTimeoutMs });
  if (info?.sdk !== 'java' || info.package !== 'com.topthink:think-ai' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(info.version)) throw new CentralError('Expected a stable com.topthink:think-ai Java release');
  if (manifest?.version !== info.version || manifest.sdk !== 'java' || !Array.isArray(manifest.files) || manifest.files.length !== 4) throw new CentralError('Java manifest does not match the release');
  if (!environment.GPG_KEY_ID) throw new CentralError('GPG_KEY_ID is required to sign accepted Java artifacts');
  if (typeof run !== 'function' || !python) throw new CentralError('A command runner and Python are required');
  const passphrase = environment.MAVEN_GPG_PASSPHRASE;
  if (passphrase && /[\r\n]/.test(passphrase)) throw new CentralError('GPG stdin passphrase must be a single line');
  const expected = [`think-ai-${info.version}.jar`, `think-ai-${info.version}-sources.jar`, `think-ai-${info.version}-javadoc.jar`, `think-ai-${info.version}.pom`].sort();
  if (manifest.files.map(file => basename(file.path)).sort().some((name, index) => name !== expected[index])) throw new CentralError('Java manifest must contain exactly the accepted JAR, sources, javadoc and POM');
  const releaseRoot = realpathSync(join(root, '.artifacts/releases/java', info.version));
  const accepted = manifest.files.map(file => {
    const path = realpathSync(resolve(root, file.path));
    if (!path.startsWith(releaseRoot + sep)) throw new CentralError('Java artifacts must stay within the release directory');
    const bytes = readFileSync(path);
    if (bytes.length !== file.size || hash(bytes) !== file.sha256) throw new CentralError(`Java accepted artifact checksum mismatch: ${basename(path)}`);
    return { name: basename(path), source: path, bytes, sha256: file.sha256, size: file.size };
  });
  const directory = dirname(accepted[0].source);
  if (accepted.some(file => dirname(file.source) !== directory)) throw new CentralError('Java accepted artifacts must share one build directory');
  const output = join(directory, 'central-' + randomUUID()); mkdirSync(output);
  const childEnv = childEnvironment(environment), bundleFiles = [];
  for (const file of accepted) {
    const path = join(output, file.name), signature = path + '.asc'; writeFileSync(path, file.bytes);
    const args = ['--batch', '--yes', '--armor', '--detach-sign', '--local-user', environment.GPG_KEY_ID, '--output', signature];
    if (passphrase) args.push('--pinentry-mode', 'loopback', '--passphrase-fd', '0'); else args.push('--pinentry-mode', 'error');
    args.push(path);
    let result;
    try { result = await run('gpg', args, { cwd: root, env: childEnv, capture: true, quiet: true, allowFailure: true, ...(passphrase ? { input: passphrase + '\n' } : {}) }); }
    catch { throw new CentralError(`GPG signing failed for ${file.name}`); }
    if (result.status !== 0) throw new CentralError(`GPG signing failed for ${file.name} (exit ${result.status})`);
    bundleFiles.push({ name: file.name, path, signature, sha256: file.sha256, size: file.size });
  }
  const specification = join(output, 'bundle-inputs.json'), bundlePath = join(output, 'central-bundle.zip');
  writeFileSync(specification, JSON.stringify({ version: info.version, files: bundleFiles }) + '\n');
  const bundled = await run(python, [join(root, 'scripts/central-bundle.py'), '--manifest', specification, '--output', bundlePath], { cwd: root, env: childEnv, capture: true, quiet: true, allowFailure: true });
  if (bundled.status !== 0) throw new CentralError('Central bundle construction failed');
  // Recheck original files immediately before the first external write as well.
  for (const file of accepted) if (hash(readFileSync(file.source)) !== file.sha256) throw new CentralError(`Java accepted artifact changed during signing: ${file.name}`);
  const id = await uploadCentral({ bundlePath, name: `${info.package}:${info.version}`, environment, fetch, requestTimeoutMs });
  try { await onUploaded(id); }
  catch { throw new CentralError(`Central deployment ${id} uploaded, but its receipt could not be saved; resume this ID without uploading again`, { deploymentId: id }); }
  return pollCentral({ deploymentId: id, environment, fetch, delay, now, timeoutMs, pollIntervalMs, requestTimeoutMs });
}
