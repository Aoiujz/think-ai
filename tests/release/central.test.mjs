import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  realpathSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { publishCentral, pollCentral, uploadCentral } from '../../scripts/central.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ID = '28570f16-da32-4c14-bd2e-c1acc0782365';
const environment = {
  ...process.env,
  CENTRAL_TOKEN_USERNAME: 'offline-central-username',
  CENTRAL_TOKEN_PASSWORD: 'offline-central-password',
  GPG_KEY_ID: 'A'.repeat(40) + '!',
  MAVEN_GPG_PASSPHRASE: 'offline-only-passphrase',
};
const python = process.env.THINKAI_PYTHON || 'python';
const digest = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex');
const armored =
  '-----BEGIN PGP SIGNATURE-----\nFAKE OFFLINE SIGNATURE\n-----END PGP SIGNATURE-----\n';

function fixture(t) {
  const base = join(ROOT, '.artifacts/central-tests');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'fixture-'));
  t.after(() => {
    assert.ok(realpathSync(root).startsWith(realpathSync(base) + sep + 'fixture-'));
    rmSync(root, { recursive: true, force: true });
  });
  const info = {
    sdk: 'java',
    package: 'com.topthink:think-ai',
    version: '1.2.3',
    tag: 'java/v1.2.3',
  };
  const directory = join(root, '.artifacts/releases/java/1.2.3/build-fixture');
  mkdirSync(directory, { recursive: true });
  mkdirSync(join(root, 'scripts'));
  copyFileSync(join(ROOT, 'scripts/central-bundle.py'), join(root, 'scripts/central-bundle.py'));
  const originals = new Map();
  const files = [
    'think-ai-1.2.3.jar',
    'think-ai-1.2.3-sources.jar',
    'think-ai-1.2.3-javadoc.jar',
    'think-ai-1.2.3.pom',
  ].map((name, index) => {
    const bytes = Buffer.concat([
      Buffer.from('accepted ' + name + '\n'),
      Buffer.from([0, 255, index]),
    ]);
    originals.set(name, bytes);
    const path = `.artifacts/releases/java/1.2.3/build-fixture/${name}`;
    writeFileSync(join(root, path), bytes);
    return { path, size: bytes.length, sha256: digest('sha256', bytes) };
  });
  return { root, info, manifest: { ...info, files }, directory, originals, python, environment };
}
function runner(calls, { failSign = false } = {}) {
  return (command, args, options) => {
    calls.push({ command, args, input: options?.input, env: options?.env });
    if (command === 'gpg') {
      assert.equal(options.capture, true);
      assert.equal(options.quiet, true);
      assert.equal(options.allowFailure, true);
      assert.equal(options.env.MAVEN_GPG_PASSPHRASE, undefined);
      assert.equal(options.env.CENTRAL_TOKEN_PASSWORD, undefined);
      if (failSign) return { status: 2, stderr: environment.MAVEN_GPG_PASSPHRASE, stdout: '' };
      writeFileSync(args[args.indexOf('--output') + 1], armored);
      return { status: 0, stdout: '', stderr: '' };
    }
    const result = spawnSync(command, args, {
      cwd: options.cwd,
      env: options.env,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
}
function fakePortal({
  states = ['PENDING', 'VALIDATING', 'PUBLISHING', 'PUBLISHED'],
  beforeStatus = () => {},
} = {}) {
  const calls = [];
  let count = 0;
  const fetch = async (input, options) => {
    const url = new URL(input);
    calls.push({ url, options });
    assert.equal(url.origin, 'https://central.sonatype.com');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(
      options.headers.Authorization,
      'Bearer ' +
        Buffer.from(
          environment.CENTRAL_TOKEN_USERNAME + ':' + environment.CENTRAL_TOKEN_PASSWORD,
        ).toString('base64'),
    );
    if (url.pathname.endsWith('/upload')) {
      assert.equal(url.searchParams.get('publishingType'), 'AUTOMATIC');
      assert.deepEqual([...options.body.keys()], ['bundle']);
      const part = options.body.get('bundle');
      assert.equal(part.type, 'application/octet-stream');
      assert.equal(part.name, 'central-bundle.zip');
      return new Response(ID, { status: 201 });
    }
    beforeStatus();
    assert.equal(url.searchParams.get('id'), ID);
    return Response.json({
      deploymentId: ID,
      deploymentState: states[Math.min(count++, states.length - 1)],
      errors: { artifact: ['invalid signature'] },
    });
  };
  return { calls, fetch };
}

test('accepted four artifacts are signed without secret argv and a real 24-entry bundle preserves bytes/checksums', async (t) => {
  const options = fixture(t),
    commands = [],
    portal = fakePortal();
  let receiptId;
  portal.fetch = fakePortal({ beforeStatus: () => assert.equal(receiptId, ID) }).fetch;
  const result = await publishCentral({
    ...options,
    run: runner(commands),
    fetch: portal.fetch,
    delay: async () => {},
    onUploaded: async (id) => {
      receiptId = id;
    },
  });
  assert.deepEqual(result, { deploymentId: ID, deploymentState: 'PUBLISHED' });
  assert.equal(commands.filter((call) => call.command === 'gpg').length, 4);
  for (const command of commands.filter((call) => call.command === 'gpg')) {
    assert.equal(command.input, environment.MAVEN_GPG_PASSPHRASE + '\n');
    assert.ok(command.args.includes('--passphrase-fd'));
    assert.ok(command.args.includes('loopback'));
    assert.ok(!JSON.stringify(command.args).includes(environment.MAVEN_GPG_PASSPHRASE));
    assert.ok(!JSON.stringify(command.env).includes(environment.CENTRAL_TOKEN_PASSWORD));
  }
  const output = join(
    options.directory,
    readdirSync(options.directory).find((name) => name.startsWith('central-')),
  );
  const inspect = spawnSync(
    python,
    [
      '-c',
      'import zipfile,json,base64,sys; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps({n:base64.b64encode(z.read(n)).decode() for n in z.namelist()}))',
      join(output, 'central-bundle.zip'),
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  assert.equal(inspect.status, 0, inspect.stderr);
  const entries = JSON.parse(inspect.stdout);
  assert.equal(Object.keys(entries).length, 24);
  for (const [name, bytes] of options.originals) {
    const path = 'com/topthink/think-ai/1.2.3/' + name;
    assert.deepEqual(Buffer.from(entries[path], 'base64'), bytes);
    assert.deepEqual(readFileSync(join(options.directory, name)), bytes);
    assert.equal(Buffer.from(entries[path + '.asc'], 'base64').toString(), armored);
    for (const algorithm of ['md5', 'sha1', 'sha256', 'sha512'])
      assert.equal(
        Buffer.from(entries[path + '.' + algorithm], 'base64').toString(),
        digest(algorithm, bytes),
      );
  }
});

test('agent signing has no passphrase-fd/stdin, and upload receipt precedes FAILED status without retry', async (t) => {
  const options = fixture(t),
    commands = [],
    portal = fakePortal({ states: ['FAILED'] });
  const env = { ...environment };
  delete env.MAVEN_GPG_PASSPHRASE;
  let uploaded = false;
  await assert.rejects(
    publishCentral({
      ...options,
      environment: env,
      run: runner(commands),
      fetch: portal.fetch,
      onUploaded: (id) => {
        assert.equal(id, ID);
        uploaded = true;
      },
    }),
    (error) =>
      error.deploymentId === ID &&
      error.deploymentState === 'FAILED' &&
      /invalid signature/.test(error.message),
  );
  assert.equal(uploaded, true);
  assert.equal(portal.calls.length, 2);
  for (const command of commands.filter((call) => call.command === 'gpg')) {
    assert.equal(command.input, undefined);
    assert.ok(!command.args.includes('--passphrase-fd'));
    assert.ok(command.args.includes('error'));
  }
});

test('resume skips all filesystem packaging and signing/upload work, needs no GPG key and polls only', async () => {
  const env = { ...environment };
  delete env.GPG_KEY_ID;
  delete env.MAVEN_GPG_PASSPHRASE;
  const portal = fakePortal({ states: ['PUBLISHED'] });
  const result = await publishCentral({
    environment: env,
    resumeId: ID,
    run: () => assert.fail('resume must not invoke tools'),
    fetch: portal.fetch,
  });
  assert.equal(result.deploymentState, 'PUBLISHED');
  assert.equal(portal.calls.length, 1);
  assert.ok(portal.calls[0].url.pathname.endsWith('/status'));
});

test('poll timeout retains deployment ID and never retries upload', async () => {
  const portal = fakePortal({ states: ['PENDING'] });
  let time = 0;
  await assert.rejects(
    pollCentral({
      deploymentId: ID,
      environment,
      fetch: portal.fetch,
      timeoutMs: 15,
      pollIntervalMs: 10,
      now: () => time,
      delay: async (ms) => {
        time += ms;
      },
    }),
    (error) => error.deploymentId === ID && /deadline/.test(error.message),
  );
  assert.equal(portal.calls.length, 2);
  assert.ok(portal.calls.every((call) => call.url.pathname.endsWith('/status')));
});

test('signing failure redacts sensitive stderr and never invokes bundle or upload', async (t) => {
  const options = fixture(t),
    commands = [];
  await assert.rejects(
    publishCentral({
      ...options,
      run: runner(commands, { failSign: true }),
      fetch: () => assert.fail('must not upload'),
    }),
    (error) =>
      /GPG signing failed/.test(error.message) &&
      !error.message.includes(environment.MAVEN_GPG_PASSPHRASE),
  );
  assert.equal(commands.length, 1);
});

test('manifest tampering is rejected before any command or network', async (t) => {
  const options = fixture(t);
  writeFileSync(join(options.root, options.manifest.files[0].path), 'tampered');
  await assert.rejects(
    publishCentral({
      ...options,
      run: () => assert.fail('must not sign'),
      fetch: () => assert.fail('must not upload'),
    }),
    /checksum mismatch/,
  );
});

test('bundle helper rejects a changed staged artifact and upload is not attempted', async (t) => {
  const options = fixture(t),
    commands = [],
    originalRunner = runner(commands);
  const run = (command, args, settings) => {
    if (command === python) {
      const spec = JSON.parse(readFileSync(args[args.indexOf('--manifest') + 1], 'utf8'));
      writeFileSync(spec.files[0].path, 'changed');
      const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    }
    return originalRunner(command, args, settings);
  };
  await assert.rejects(
    publishCentral({ ...options, run, fetch: () => assert.fail('must not upload') }),
    /bundle construction failed/,
  );
});

test('HTTP upload/status errors do not retry and never expose credential values', async (t) => {
  const options = fixture(t),
    bundle = join(options.directory, 'fake-bundle.zip');
  writeFileSync(bundle, 'zip');
  let calls = 0;
  await assert.rejects(
    uploadCentral({
      bundlePath: bundle,
      name: 'offline',
      environment,
      fetch: async () => {
        calls++;
        return new Response(environment.CENTRAL_TOKEN_PASSWORD, { status: 401 });
      },
    }),
    (error) =>
      /HTTP 401/.test(error.message) && !error.message.includes(environment.CENTRAL_TOKEN_PASSWORD),
  );
  assert.equal(calls, 1);
  await assert.rejects(
    pollCentral({
      deploymentId: ID,
      environment,
      fetch: async () => new Response(environment.MAVEN_GPG_PASSPHRASE, { status: 500 }),
    }),
    (error) =>
      error.deploymentId === ID && !error.message.includes(environment.MAVEN_GPG_PASSPHRASE),
  );
});

test('receipt failure exposes deployment ID for safe resume and does not start polling', async (t) => {
  const options = fixture(t),
    commands = [],
    portal = fakePortal();
  await assert.rejects(
    publishCentral({
      ...options,
      run: runner(commands),
      fetch: portal.fetch,
      onUploaded: () => {
        throw new Error('offline receipt I/O');
      },
    }),
    (error) => error.deploymentId === ID && /receipt/.test(error.message),
  );
  assert.equal(portal.calls.length, 1);
});
