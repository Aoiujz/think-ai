import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { ROOT, expectedArtifacts, versionInfo } from '../../scripts/release.mjs';
import { stage, main } from '../../scripts/ci-artifacts.mjs';

const SOURCES = ['composer.json', 'php/VERSION', 'python/pyproject.toml', 'python/src/thinkai/_version.py', 'typescript/package.json', 'typescript/package-lock.json', 'typescript/src/version.ts', 'java/pom.xml', 'java/src/main/java/com/topthink/ai/ThinkAIClient.java', 'dotnet/TopThink.ThinkAI/TopThink.ThinkAI.csproj', 'dotnet/TopThink.ThinkAI/ThinkAIClient.cs'];
const SUPPORTED = ['php', 'python', 'typescript', 'java', 'dotnet'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function fixture(t) {
  const base = join(ROOT, '.artifacts/ci-artifact-tests'); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'fixture-'));
  t.after(() => { assert.ok(realpathSync(root).startsWith(realpathSync(base) + sep + 'fixture-')); rmSync(root, { recursive: true, force: true }); });
  for (const source of SOURCES) { const destination = join(root, source); mkdirSync(dirname(destination), { recursive: true }); copyFileSync(join(ROOT, source), destination); }
  return root;
}
function sourcePath(root, sdk, name) {
  return sdk === 'php' ? join(root, '.artifacts/think-ai-php.zip')
    : sdk === 'python' ? join(root, 'python/dist', name)
    : sdk === 'typescript' ? join(root, 'typescript', name)
    : sdk === 'java' ? join(root, name.endsWith('.pom') ? 'java/pom.xml' : 'java/target/' + name)
    : join(root, 'dotnet/artifacts', name);
}
function packages(root, sdk) {
  const info = versionInfo(root, sdk), bytes = new Map();
  for (const name of expectedArtifacts(sdk, info.version)) {
    const path = sourcePath(root, sdk, name);
    mkdirSync(dirname(path), { recursive: true });
    if (sdk !== 'java' || !name.endsWith('.pom')) writeFileSync(path, Buffer.concat([Buffer.from('checked ' + sdk + '/' + name), Buffer.from([0,255,42])]));
    bytes.set(name, readFileSync(path));
  }
  const old = info.version === '0.0.0' ? '0.0.1' : '0.0.0';
  for (const name of expectedArtifacts(sdk, old)) {
    if (sdk === 'php' || (sdk === 'java' && name.endsWith('.pom'))) continue;
    writeFileSync(sourcePath(root, sdk, name), 'old version');
  }
  return { info, bytes };
}

for (const sdk of SUPPORTED) test(`${sdk}: stage copies only current exact artifacts, never old packages or consumer caches`, t => {
  const root = fixture(t), { info, bytes } = packages(root, sdk);
  const sourceDir = dirname(sourcePath(root, sdk, expectedArtifacts(sdk, info.version)[0]));
  mkdirSync(join(sourceDir, 'package-consumer/target'), { recursive: true }); writeFileSync(join(sourceDir, 'package-consumer/target/consumer.jar'), 'consumer cache');
  writeFileSync(join(sourceDir, 'unrelated-package.zip'), 'other package');
  const result = stage(root, sdk);
  assert.equal(result.version, info.version); assert.ok(resolve(result.path).startsWith(resolve(root, '.artifacts/ci', sdk) + sep + 'stage-'));
  assert.deepEqual(result.files.map(file => file.name).sort(), expectedArtifacts(sdk, info.version).sort());
  assert.deepEqual(readdirSync(result.path).sort(), [...bytes.keys(), 'manifest.json'].sort());
  for (const file of result.files) {
    assert.deepEqual(readFileSync(join(result.path, file.name)), bytes.get(file.name)); assert.equal(file.size, bytes.get(file.name).length); assert.equal(file.sha256, sha(bytes.get(file.name)));
  }
  const manifest = JSON.parse(readFileSync(join(result.path, 'manifest.json')));
  assert.equal(manifest.sdk, sdk); assert.equal(manifest.version, info.version); assert.deepEqual(manifest.files, result.files);
  if (sdk === 'php') assert.ok(existsSync(join(result.path, `topthink-think-ai-${info.version}.zip`)));
  if (sdk === 'java') assert.deepEqual(readFileSync(join(result.path, `think-ai-${info.version}.pom`)), readFileSync(join(root, 'java/pom.xml')));
  const again = stage(root, sdk); assert.notEqual(again.path, result.path); assert.deepEqual(readdirSync(again.path).sort(), readdirSync(result.path).sort());
});

for (const sdk of SUPPORTED) test(`${sdk}: missing current package rejects even when old packages exist`, t => {
  const root = fixture(t), { info } = packages(root, sdk);
  const missing = expectedArtifacts(sdk, info.version).find(name => !name.endsWith('.pom'));
  rmSync(sourcePath(root, sdk, missing));
  assert.throws(() => stage(root, sdk), /Missing current/); assert.equal(existsSync(join(root, '.artifacts/ci', sdk)), false);
});

test('Go and unknown SDKs have no staged package and cause no output writes', t => {
  const root = fixture(t);
  for (const sdk of ['go', 'rust', undefined]) assert.throws(() => stage(root, sdk), /Go has no packaged upload/);
  assert.equal(existsSync(join(root, '.artifacts/ci')), false);
});

test('CLI appends version and absolute staged path to GITHUB_OUTPUT without overwriting prior step outputs', t => {
  const root = fixture(t), { info } = packages(root, 'python'), output = join(root, '.artifacts/github-output');
  mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, 'previous=kept\n');
  const result = main(['python'], root, { GITHUB_OUTPUT: output });
  assert.equal(readFileSync(output, 'utf8'), `previous=kept\nversion=${info.version}\npath=${result.path}\n`);
  assert.equal(result.files.length, 2);
  assert.throws(() => main([], root, {}), /Usage:/); assert.throws(() => main(['java', '--upload'], root, {}), /Usage:/);
});
