import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import childProcess, { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { ROOT, SDKS, versionInfo, prepare, tagFor, stableVersion, expectedArtifacts, validateManifest, publishPreview, publish, verifyPublished, registryCommand, parseRemoteRefs, tagState, composerCommand, gitState, main } from '../../scripts/release.mjs';

const SOURCE_FILES = ['composer.json', 'php/VERSION', 'python/pyproject.toml', 'python/src/thinkai/_version.py', 'python/README.md', 'typescript/package.json', 'typescript/package-lock.json', 'typescript/src/version.ts', 'typescript/README.md', 'go/client.go', 'go/go.mod', 'go/README.md', 'java/pom.xml', 'java/src/main/java/com/topthink/ai/ThinkAIClient.java', 'java/README.md', 'dotnet/TopThink.ThinkAI/TopThink.ThinkAI.csproj', 'dotnet/TopThink.ThinkAI/ThinkAIClient.cs', 'dotnet/README.md'];
const COMMIT = 'a'.repeat(40),
  OTHER = 'b'.repeat(40);
const hash = (value) => createHash('sha256').update(value).digest('hex');
function fixture(t, git = false) {
  const workspace = join(ROOT, '.artifacts/release-tests');
  mkdirSync(workspace, { recursive: true });
  const root = mkdtempSync(join(workspace, 'thinkai-release-tests-'));
  t.after(() => {
    assert.ok(resolve(root).startsWith(resolve(workspace) + sep + 'thinkai-release-tests-'));
    rmSync(root, { recursive: true, force: true });
  });
  for (const file of SOURCE_FILES) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    copyFileSync(join(ROOT, file), join(root, file));
  }
  writeFileSync(join(root, '.gitignore'), '.artifacts/\n');
  if (git) {
    const run = (args) => {
      const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    run(['init', '--quiet']);
    run(['config', 'core.autocrlf', 'false']);
    run(['add', '.']);
    run(['-c', 'user.name=ThinkAI Offline Tests', '-c', 'user.email=offline@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture']);
  }
  return root;
}
function manifest(root, sdk, overrides = {}) {
  const info = versionInfo(root, sdk),
    directory = join(root, '.artifacts/releases', sdk, info.version),
    output = join(directory, 'build-fixture');
  mkdirSync(output, { recursive: true });
  const files = expectedArtifacts(sdk, info.version).map((name) => {
    const contents = Buffer.from('test artifact ' + name),
      path = join(output, name);
    writeFileSync(path, contents);
    return {
      path: `.artifacts/releases/${sdk}/${info.version}/build-fixture/${name}`,
      size: contents.length,
      sha256: hash(contents),
    };
  });
  const result = { schema: 1, ...info, commit: COMMIT, dirty: false, files, ...overrides };
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(result));
  return result;
}
function releaseReceiptPath(root, sdk) {
  return join(root, '.artifacts/releases', sdk, versionInfo(root, sdk).version, 'publish-result.json');
}
function publisher(root, sdk, options = {}) {
  const info = versionInfo(root, sdk),
    calls = [];
  const deps = {
    gitState: () => ({ commit: COMMIT, dirty: false, branch: 'master', ...options.state }),
    git: (_root, args) => {
      if (args[0] === 'remote') return { stdout: 'git@github.com:top-think/think-ai.git\n' };
      if (args[0] === 'ls-remote') {
        return {
          stdout: `${options.remoteHead || COMMIT}\trefs/heads/master\n` + (options.remoteTag ? `${OTHER}\trefs/tags/${info.tag}\n${options.remoteTag}\trefs/tags/${info.tag}^{}\n` : ''),
        };
      }
      if (args[0] === 'rev-parse') return { stdout: options.localTag || '' };
      throw new Error('Unexpected Git read: ' + args);
    },
    run: (command, args, execution) => {
      calls.push({ command, args });
      if (args.includes('--version')) return { stdout: options.dotnetVersion || '10.0.301\n' };
      if (options.failUpload && args.includes('upload')) {
        throw new Error('Offline upload fixture failed');
      }
      if (options.assertEnvironment) options.assertEnvironment(execution?.env);
      return { stdout: '', status: 0 };
    },
    verify: async () => ({ indexed: true }),
  };
  return { deps, calls };
}
async function withEnvironment(changes, callback) {
  const before = {};
  for (const [key, value] of Object.entries(changes)) {
    before[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await callback();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test('Composer resolves Windows PHAR installations without executing a batch shell', (t) => {
  const root = fixture(t),
    bin = join(root, 'Composer bin with spaces');
  mkdirSync(bin);
  const phar = join(bin, 'composer.phar');
  writeFileSync(phar, 'offline placeholder');
  assert.deepEqual(composerCommand(root, { PATH: '"' + bin + '"' }, 'win32'), ['php', [phar]]);
  assert.deepEqual(composerCommand(root, { THINKAI_COMPOSER_PHAR: phar }, 'win32'), ['php', [phar]]);
  assert.throws(() => composerCommand(root, { THINKAI_COMPOSER_PHAR: phar + '-missing' }, 'win32'), /existing composer.phar/);
  assert.throws(() => composerCommand(root, {}, 'win32'), /THINKAI_COMPOSER_PHAR/);
  assert.deepEqual(composerCommand(root, {}, 'linux'), ['composer', []]);
});

for (const sdk of SDKS) {
  test(`prepare ${sdk}: preview does not write, execute synchronizes only selected SDK`, (t) => {
    const root = fixture(t),
      before = new Map(SOURCE_FILES.map((file) => [file, readFileSync(join(root, file))]));
    const plan = prepare(root, sdk, '1.2.3');
    assert.equal(plan.execute, false);
    assert.equal(plan.tag, tagFor(sdk, '1.2.3'));
    for (const [file, bytes] of before) assert.deepEqual(readFileSync(join(root, file)), bytes);
    prepare(root, sdk, '1.2.3', true);
    assert.equal(versionInfo(root, sdk).version, '1.2.3');
    for (const other of SDKS.filter((value) => value !== sdk)) {
      assert.equal(versionInfo(root, other).version, versionInfo(ROOT, other).version);
    }
    for (const file of SOURCE_FILES.filter((file) => !plan.files.includes(file))) {
      assert.deepEqual(readFileSync(join(root, file)), before.get(file));
    }
    if (sdk === 'typescript') {
      const lock = JSON.parse(readFileSync(join(root, 'typescript/package-lock.json')));
      assert.equal(lock.version, '1.2.3');
      assert.equal(lock.packages[''].version, '1.2.3');
    }
    if (sdk === 'java') {
      assert.ok(readFileSync(join(root, 'java/pom.xml'), 'utf8').includes('<jackson.version>2.20.1</jackson.version>'));
    }
    if (sdk === 'php') {
      assert.equal(JSON.parse(readFileSync(join(root, 'composer.json'))).version, undefined);
    }
  });
}
test('reject invalid/prerelease versions and Go v2 without changing files', (t) => {
  const root = fixture(t),
    before = readFileSync(join(root, 'go/client.go'));
  for (const value of ['v1.0.0', '01.0.0', '../1.0.0', '1.0.0-rc.1', '1.0', '1.0.0\n']) {
    assert.throws(() => stableVersion(value));
  }
  assert.throws(() => prepare(root, 'go', '2.0.0', true), /module-path/);
  assert.deepEqual(readFileSync(join(root, 'go/client.go')), before);
});
test('malformed runtime version cannot leave a partial version update', (t) => {
  const root = fixture(t),
    project = readFileSync(join(root, 'python/pyproject.toml'));
  writeFileSync(join(root, 'python/src/thinkai/_version.py'), '__version__ = "9.9.9"');
  assert.throws(() => prepare(root, 'python', '1.0.0', true), /differs/);
  assert.deepEqual(readFileSync(join(root, 'python/pyproject.toml')), project);
});
test('publish preview is read-only, performs no fetch and prints no credential values', async (t) => {
  const root = fixture(t, true),
    before = readFileSync(join(root, '.git/index')),
    mtime = statSync(join(root, '.git/index')).mtimeMs;
  const fetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    throw new Error('Preview must not fetch');
  };
  t.after(() => {
    globalThis.fetch = fetch;
  });
  await withEnvironment({ TWINE_PASSWORD: 'never-print-this-token' }, async () => {
    const plan = publishPreview(root, 'python');
    assert.equal(plan.dry_run, true);
    assert.ok(plan.blocked.some((value) => value.includes('Build first')));
    assert.ok(!JSON.stringify(plan).includes(process.env.TWINE_PASSWORD));
  });
  assert.equal(requests, 0);
  assert.deepEqual(readFileSync(join(root, '.git/index')), before);
  assert.equal(statSync(join(root, '.git/index')).mtimeMs, mtime);
  assert.ok(!existsSync(join(root, '.artifacts')));
});
for (const sdk of SDKS) {
  test(`manifest ${sdk}: validates exact version artifact set and SHA256`, (t) => {
    const root = fixture(t),
      info = versionInfo(root, sdk),
      state = { commit: COMMIT };
    const result = manifest(root, sdk);
    assert.equal(validateManifest(root, info, state).sdk, sdk);
    if (result.files.length) {
      writeFileSync(join(root, result.files[0].path), 'tampered');
      assert.throws(() => validateManifest(root, info, state), /checksum/);
    } else {
      manifest(root, sdk, { dirty: true });
      assert.throws(() => validateManifest(root, info, state), /stale/);
    }
  });
}
test('manifest rejects wrong commit, dirty build and escaped artifact paths', (t) => {
  const root = fixture(t),
    info = versionInfo(root, 'python');
  manifest(root, 'python');
  assert.throws(() => validateManifest(root, info, { commit: OTHER }), /stale/);
  manifest(root, 'python', { dirty: true });
  assert.throws(() => validateManifest(root, info, { commit: COMMIT }), /stale/);
  const result = manifest(root, 'python');
  result.files[0].path = '../' + basenameForTest(result.files[0].path);
  writeFileSync(join(root, '.artifacts/releases/python', info.version, 'manifest.json'), JSON.stringify(result));
  assert.throws(() => validateManifest(root, info, { commit: COMMIT }), /inside/);
});
function basenameForTest(path) {
  return path.split('/').at(-1);
}
test('annotated tags compare peeled commit and same-commit remote tags are reused', () => {
  const refs = parseRemoteRefs(`${OTHER}\trefs/tags/go/v0.1.0\n${COMMIT}\trefs/tags/go/v0.1.0^{}\n`);
  assert.deepEqual(tagState(refs, 'go/v0.1.0', COMMIT, COMMIT), {
    remoteExists: true,
    localExists: true,
  });
  assert.throws(() => tagState(refs, 'go/v0.1.0', OTHER), /another commit/);
  assert.throws(() => tagState(refs, 'go/v0.1.0', COMMIT, OTHER), /another commit/);
  assert.deepEqual(tagState(new Map(), 'go/v0.1.0', COMMIT, COMMIT), {
    remoteExists: false,
    localExists: true,
  });
});
test('dirty source blocks every publish command before any subprocess', async (t) => {
  const root = fixture(t),
    { deps, calls } = publisher(root, 'python', { state: { dirty: true } });
  await assert.rejects(publish(root, 'python', true, deps), /Commit all changes/);
  assert.equal(calls.length, 0);
});
test('missing credentials block before tag creation', async (t) => {
  const root = fixture(t);
  manifest(root, 'python');
  const { deps, calls } = publisher(root, 'python');
  await withEnvironment({ TWINE_PASSWORD: undefined }, async () => {
    await assert.rejects(publish(root, 'python', true, deps), /Missing credentials/);
  });
  assert.equal(calls.length, 0);
});
test('unpublished branch HEAD blocks before tag or upload', async (t) => {
  const root = fixture(t);
  manifest(root, 'python');
  const { deps, calls } = publisher(root, 'python', { remoteHead: OTHER });
  await withEnvironment({ TWINE_PASSWORD: 'offline-token' }, async () => {
    await assert.rejects(publish(root, 'python', true, deps), /Push the current branch/);
  });
  assert.ok(!calls.some((call) => call.args.includes('tag') || call.args.includes('push') || call.args.includes('upload')));
});
test('a new release pushes only its exact tag, then exact artifacts, without secret argv', async (t) => {
  const root = fixture(t);
  const result = manifest(root, 'python');
  const { deps, calls } = publisher(root, 'python');
  await withEnvironment({ TWINE_PASSWORD: 'offline-secret' }, async () => {
    assert.equal((await publish(root, 'python', true, deps)).stage, 'published');
    assert.ok(!JSON.stringify(calls).includes('offline-secret'));
  });
  assert.ok(calls.some((call) => call.command === 'git' && call.args[0] === 'tag'));
  assert.deepEqual(calls.find((call) => call.command === 'git' && call.args.includes('push')).args, ['-c', 'push.followTags=false', 'push', 'git@github.com:top-think/think-ai.git', 'refs/tags/' + tagFor('python', versionInfo(root, 'python').version)]);
  const upload = calls.find((call) => call.args.includes('upload'));
  assert.ok(upload);
  assert.ok(!upload.args.some((arg) => arg.includes('*')));
  for (const file of result.files) assert.ok(upload.args.includes(resolve(root, file.path)));
});
test('remote same-commit tag retries upload without tag creation or push', async (t) => {
  const root = fixture(t);
  manifest(root, 'python');
  const { deps, calls } = publisher(root, 'python', { remoteTag: COMMIT, localTag: COMMIT });
  await withEnvironment({ TWINE_PASSWORD: 'offline-token' }, async () => {
    await publish(root, 'python', true, deps);
  });
  assert.ok(!calls.some((call) => call.command === 'git'));
  assert.ok(calls.some((call) => call.args.includes('upload')));
});
test('tag push followed by upload failure records partial success and permits same-tag resume', async (t) => {
  const root = fixture(t);
  manifest(root, 'python');
  await withEnvironment({ TWINE_PASSWORD: 'offline-token' }, async () => {
    const failed = publisher(root, 'python', { failUpload: true });
    await assert.rejects(publish(root, 'python', true, failed.deps), /progress is recorded/);
    const result = JSON.parse(readFileSync(releaseReceiptPath(root, 'python')));
    assert.equal(result.stage, 'tag-pushed');
    assert.match(result.error, /Offline upload/);
    const resumed = publisher(root, 'python', { remoteTag: COMMIT });
    assert.equal((await publish(root, 'python', true, resumed.deps)).stage, 'published');
    assert.ok(!resumed.calls.some((call) => call.command === 'git'));
  });
});
test('NuGet requires an SDK that supports API-key environment and never puts key in argv', async (t) => {
  const root = fixture(t);
  manifest(root, 'dotnet');
  await withEnvironment({ NUGET_API_KEY: 'offline-nuget-secret' }, async () => {
    const old = publisher(root, 'dotnet', { dotnetVersion: '10.0.100' });
    await assert.rejects(publish(root, 'dotnet', true, old.deps), /10.0.300/);
    assert.ok(!old.calls.some((call) => call.command === 'git'));
    const current = publisher(root, 'dotnet');
    await publish(root, 'dotnet', true, current.deps);
    const push = current.calls.find((call) => call.args.includes('nuget'));
    assert.ok(push);
    assert.ok(!push.args.includes('--api-key'));
    assert.ok(!JSON.stringify(current.calls).includes('offline-nuget-secret'));
  });
});

test('Java passes accepted artifacts to Central, saves deployment before polling and resumes without reupload', async (t) => {
  const root = fixture(t),
    accepted = manifest(root, 'java');
  const id = '28570f16-da32-4c14-bd2e-c1acc0782365';
  const receiptPath = releaseReceiptPath(root, 'java');
  await withEnvironment(
    {
      CENTRAL_TOKEN_USERNAME: 'offline-username',
      CENTRAL_TOKEN_PASSWORD: 'offline-password',
      GPG_KEY_ID: 'offline-key',
    },
    async () => {
      const first = publisher(root, 'java');
      first.deps.publishCentral = async (options) => {
        assert.deepEqual(options.manifest, accepted);
        assert.equal(options.resumeId, undefined);
        assert.equal(options.environment.CENTRAL_TOKEN_PASSWORD, 'offline-password');
        await options.onUploaded(id);
        const receipt = JSON.parse(readFileSync(receiptPath));
        assert.equal(receipt.deployment_id, id);
        assert.equal(receipt.stage, 'central-uploaded');
        throw new Error('Offline polling interruption');
      };
      await assert.rejects(publish(root, 'java', true, first.deps), /Offline polling interruption/);
      assert.equal(JSON.parse(readFileSync(receiptPath)).stage, 'central-uploaded');
      assert.ok(!first.calls.some((call) => call.args.includes('deploy') || call.args.includes('verify')));
      assert.ok(!JSON.stringify(first.calls).includes('offline-password'));
      const resumed = publisher(root, 'java', { remoteTag: COMMIT });
      resumed.deps.publishCentral = async (options) => {
        assert.equal(options.resumeId, id);
        assert.deepEqual(options.manifest, accepted);
        return { deploymentId: id, deploymentState: 'PUBLISHED' };
      };
      const result = await withEnvironment({ GPG_KEY_ID: undefined, MAVEN_GPG_PASSPHRASE: undefined }, () => publish(root, 'java', true, resumed.deps));
      assert.equal(result.stage, 'published');
      assert.equal(result.deployment_id, id);
      assert.ok(!resumed.calls.some((call) => call.command === 'git'));
      assert.ok(!resumed.calls.some((call) => call.command === 'gpg'));
      await assert.rejects(publish(root, 'java', true, resumed.deps), /already recorded as published/);
    },
  );
});

test('Java resume preview requires tokens and shows only the Central status operation', async (t) => {
  const root = fixture(t, true),
    state = gitState(root);
  const accepted = manifest(root, 'java', { commit: state.commit });
  const id = '28570f16-da32-4c14-bd2e-c1acc0782365';
  writeFileSync(releaseReceiptPath(root, 'java'), JSON.stringify({ ...accepted, deployment_id: id, stage: 'central-uploaded' }));
  await withEnvironment(
    {
      CENTRAL_TOKEN_USERNAME: 'offline-name',
      CENTRAL_TOKEN_PASSWORD: 'offline-token',
      GPG_KEY_ID: undefined,
    },
    async () => {
      const plan = publishPreview(root, 'java');
      assert.deepEqual(plan.blocked, []);
      assert.equal(plan.resume_deployment_id, id);
      assert.ok(plan.commands.at(-1)[1].includes('/status?id=' + id));
      assert.ok(!JSON.stringify(plan.commands).includes('/upload'));
    },
  );
});

test('source changed during preflight prevents the first tag or receipt write', async (t) => {
  const root = fixture(t);
  manifest(root, 'python');
  const { deps, calls } = publisher(root, 'python');
  let reads = 0;
  deps.gitState = () => ({ commit: COMMIT, branch: 'master', dirty: ++reads > 1 });
  await withEnvironment({ TWINE_PASSWORD: 'offline-token' }, async () => {
    await assert.rejects(publish(root, 'python', true, deps), /Source changed during release preflight/);
  });
  assert.ok(!calls.some((call) => call.command === 'git' || call.args.includes('upload')));
  assert.ok(!existsSync(releaseReceiptPath(root, 'python')));
});

for (const sdk of ['php', 'go']) {
  test(`${sdk} explicit manual publish pushes only its exact tag and then verifies its index`, async (t) => {
    const root = fixture(t),
      info = versionInfo(root, sdk);
    manifest(root, sdk);
    const { deps, calls } = publisher(root, sdk);
    let verified = 0;
    deps.verify = async (directory, selected) => {
      assert.equal(directory, root);
      assert.equal(selected, sdk);
      verified++;
      assert.equal(JSON.parse(readFileSync(releaseReceiptPath(root, sdk))).stage, 'index-pending');
      assert.equal(calls.filter((call) => call.command === 'git' && call.args.includes('push')).length, 1);
      return { indexed: true };
    };
    assert.equal((await publish(root, sdk, true, deps)).stage, 'published');
    assert.equal(verified, 1);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], {
      command: 'git',
      args: ['tag', '-a', info.tag, COMMIT, '-m', `${sdk} ${info.version}`],
    });
    assert.deepEqual(calls[1], {
      command: 'git',
      args: ['-c', 'push.followTags=false', 'push', 'git@github.com:top-think/think-ai.git', 'refs/tags/' + info.tag],
    });
  });
}
for (const sdk of ['php', 'go']) {
  test(`${sdk} same-HEAD remote tag is reused for index verification without another tag push`, async (t) => {
    const root = fixture(t);
    manifest(root, sdk);
    const { deps, calls } = publisher(root, sdk, { remoteTag: COMMIT, localTag: COMMIT });
    let verified = 0;
    deps.verify = async () => {
      verified++;
      return { indexed: true };
    };
    assert.equal((await publish(root, sdk, true, deps)).stage, 'published');
    assert.equal(verified, 1);
    assert.deepEqual(calls, []);
  });
}
test('PHP and Go index failures remain pending until verification succeeds', async (t) => {
  for (const sdk of ['php', 'go']) {
    const root = fixture(t);
    manifest(root, sdk);
    const first = publisher(root, sdk);
    first.deps.verify = async () => {
      throw new Error('Offline registry index pending');
    };
    await assert.rejects(publish(root, sdk, true, first.deps), /registry index pending/);
    const path = releaseReceiptPath(root, sdk),
      pending = JSON.parse(readFileSync(path));
    assert.equal(pending.stage, 'index-pending');
    assert.match(pending.error, /Offline registry index pending/);
    const resumed = publisher(root, sdk, { remoteTag: COMMIT, localTag: COMMIT });
    assert.equal((await publish(root, sdk, true, resumed.deps)).stage, 'published');
    assert.equal(JSON.parse(readFileSync(path)).stage, 'published');
    assert.deepEqual(resumed.calls, []);
  }
});
test('PHP/Go manual publishing still requires a clean tree, matching pushed HEAD and manifest', async (t) => {
  for (const sdk of ['php', 'go']) {
    for (const scenario of ['dirty', 'unpushed HEAD', 'missing manifest']) {
      const root = fixture(t);
      if (scenario !== 'missing manifest') manifest(root, sdk);
      const { deps, calls } = publisher(root, sdk, {
        state: { dirty: scenario === 'dirty' },
        ...(scenario === 'unpushed HEAD' ? { remoteHead: OTHER } : {}),
      });
      const expected = scenario === 'dirty' ? /Commit all changes/ : scenario === 'unpushed HEAD' ? /Push the current branch/ : /Build first/;
      await assert.rejects(publish(root, sdk, true, deps), expected);
      assert.deepEqual(calls, []);
      assert.ok(!existsSync(releaseReceiptPath(root, sdk)));
    }
  }
});
for (const sdk of ['php', 'go']) {
  test(`${sdk} verify remains available and makes only read-only index checks`, async (t) => {
    const root = fixture(t),
      info = versionInfo(root, sdk),
      calls = [],
      originalRead = fs.readFileSync;
    const restore = () => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    };
    t.after(restore);
    t.mock.method(childProcess, 'spawnSync', (command, args) => {
      calls.push({ command, args });
      assert.equal(command, 'git');
      if (args[1] === 'remote') {
        return { status: 0, stdout: 'git@github.com:top-think/think-ai.git\n' };
      }
      assert.equal(args[1], 'ls-remote');
      return { status: 0, stdout: `${COMMIT}\trefs/tags/${info.tag}\n` };
    });
    t.mock.method(fs, 'readFileSync', (file, ...args) => {
      assert.ok(!String(file).endsWith('publish-result.json'));
      return originalRead(file, ...args);
    });
    t.mock.method(fs, 'writeFileSync', () => assert.fail('verify must not write'));
    t.mock.method(fs, 'mkdirSync', () => assert.fail('verify must not create directories'));
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      calls.push({ url });
      assert.ok(options.signal);
      const expected = sdk === 'php' ? 'https://repo.packagist.org/p2/topthink/think-ai.json' : `https://proxy.golang.org/${info.package}/@v/v${info.version}.info`;
      assert.equal(url, expected);
      return {
        ok: true,
        status: 200,
        json: async () => (sdk === 'php' ? { packages: { [info.package]: [{ version: 'v' + info.version }] } } : { Version: 'v' + info.version }),
      };
    });
    syncBuiltinESMExports();
    assert.equal((await verifyPublished(root, sdk)).indexed, true);
    assert.equal(calls.filter((call) => call.url).length, 1);
    assert.equal(calls.filter((call) => call.command === 'git').length, sdk === 'go' ? 2 : 0);
  });
}
test('CLI help supports every SDK and PHP/Go default previews show plans without publishing', async (t) => {
  const fixtures = ['php', 'go'].map((sdk) => {
    const root = fixture(t, true),
      index = join(root, '.git/index');
    return { sdk, root, index, bytes: readFileSync(index), mtime: statSync(index).mtimeMs };
  });
  const output = [],
    calls = [],
    originalSpawn = childProcess.spawnSync;
  const restore = () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  };
  t.after(restore);
  t.mock.method(console, 'log', (message) => output.push(message));
  t.mock.method(childProcess, 'spawnSync', (command, args, options) => {
    calls.push({ command, args });
    assert.equal(command, 'git');
    assert.ok(!args.some((arg) => ['push', 'tag', 'ls-remote'].includes(arg)));
    return originalSpawn(command, args, options);
  });
  t.mock.method(globalThis, 'fetch', () => assert.fail('Preview must not fetch a registry'));
  t.mock.method(fs, 'writeFileSync', () => assert.fail('Preview must not write a receipt'));
  t.mock.method(fs, 'mkdirSync', () => assert.fail('Preview must not create output directories'));
  syncBuiltinESMExports();
  await main(['--help'], fixtures[0].root);
  const help = output.shift();
  assert.match(help, /publish <sdk> \[--execute\]/);
  assert.match(help, /SDKs: php, python, typescript, go, java, dotnet/);
  assert.match(help, /requires an explicit --execute/);
  for (const { sdk, root, index, bytes, mtime } of fixtures) {
    const info = versionInfo(root, sdk);
    for (const plan of [publishPreview(root, sdk), await publish(root, sdk)]) {
      assert.equal(plan.dry_run, true);
      assert.equal(plan.tag, info.tag);
      assert.ok(plan.commands.some((command) => command[0] === 'git' && command[1] === 'tag' && command[3] === info.tag));
      assert.deepEqual(
        plan.commands.find((command) => command.includes('push')),
        ['git', '-c', 'push.followTags=false', 'push', '<origin push URL>', 'refs/tags/' + info.tag],
      );
    }
    await main(['publish', sdk], root);
    const plan = JSON.parse(output.shift());
    assert.equal(plan.dry_run, true);
    assert.equal(plan.tag, info.tag);
    assert.deepEqual(readFileSync(index), bytes);
    assert.equal(statSync(index).mtimeMs, mtime);
    assert.ok(!existsSync(join(root, '.artifacts')));
  }
  assert.ok(calls.length > 0);
});
test('PHP/Go registry commands describe only their exact tag and reject unknown SDKs', () => {
  for (const sdk of ['php', 'go']) {
    const info = versionInfo(ROOT, sdk);
    assert.deepEqual(registryCommand(info, []), ['git', '-c', 'push.followTags=false', 'push', '<origin push URL>', 'refs/tags/' + info.tag]);
  }
  assert.throws(() => registryCommand({ sdk: 'unknown', tag: 'v1.0.0' }, []), /SDK must be one of/);
});
test('registry commands do not hide conflicts or publish wildcard artifact sets', () => {
  for (const sdk of ['python', 'typescript', 'dotnet']) {
    const command = registryCommand(versionInfo(ROOT, sdk), ['artifact-1', 'artifact-2']);
    assert.ok(!command.includes('--skip-existing'));
    assert.ok(!command.includes('--skip-duplicate'));
    assert.ok(!command.some((value) => value.includes('*')));
  }
});
