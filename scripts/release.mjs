#!/usr/bin/env node
/** ThinkAI releases. No registry or Git writes without an explicit --execute. */
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, statSync, mkdtempSync, unlinkSync, rmdirSync, realpathSync } from 'node:fs';
import { dirname, resolve, join, relative, sep, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SDKS = ['php', 'python', 'typescript', 'go', 'java', 'dotnet'];
const PACKAGES = {
  php: 'topthink/think-ai',
  python: 'topthink-think-ai',
  typescript: '@topthink/think-ai',
  go: 'github.com/top-think/think-ai/go',
  java: 'com.topthink:think-ai',
  dotnet: 'TopThink.ThinkAI',
};
const PREFIXES = {
  php: 'v',
  python: 'python/v',
  typescript: 'typescript/v',
  go: 'go/v',
  java: 'java/v',
  dotnet: 'dotnet/v',
};
const SHA256 = (bytes) => createHash('sha256')
  .update(bytes)
  .digest('hex');
const text = (root, path) => readFileSync(join(root, path), 'utf8');
const capture = (source, pattern, label) => {
  const match = source.match(pattern);
  if (!match) throw new Error(`Cannot read ${label}`);
  return match[1];
};
export function stableVersion(value) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    throw new Error('Use a stable X.Y.Z version (without v). Prereleases require ecosystem-specific version mapping.');
  }
  return value;
}
function sdkName(sdk) {
  if (!SDKS.includes(sdk)) throw new Error(`SDK must be one of: ${SDKS.join(', ')}`);
  return sdk;
}
export const tagFor = (sdk, version) => PREFIXES[sdkName(sdk)] + stableVersion(version);

export function versionInfo(root, sdk) {
  sdkName(sdk);
  let version, runtime;
  if (sdk === 'php') {
    version = text(root, 'php/VERSION')
      .trim();
    const composer = JSON.parse(text(root, 'composer.json'));
    if (composer.name !== PACKAGES.php || composer.autoload?.['psr-4']?.['think\\ai\\'] !== 'php/src/') {
      throw new Error('PHP Composer identity/autoload changed');
    }
  } else if (sdk === 'python') {
    const metadata = text(root, 'python/pyproject.toml');
    if (capture(metadata, /^name\s*=\s*"([^"]+)"/m, 'Python package name') !== PACKAGES.python) {
      throw new Error('Python package identity changed');
    }
    version = capture(metadata, /^version\s*=\s*"([^"]+)"/m, 'Python version');
    runtime = capture(text(root, 'python/src/thinkai/_version.py'), /__version__\s*=\s*['"]([^'"]+)['"]/, 'Python runtime version');
  } else if (sdk === 'typescript') {
    const metadata = JSON.parse(text(root, 'typescript/package.json'));
    const lock = JSON.parse(text(root, 'typescript/package-lock.json'));
    if (metadata.name !== PACKAGES.typescript) throw new Error('npm package identity changed');
    version = metadata.version;
    if (lock.version !== version || lock.packages?.['']?.version !== version) {
      throw new Error('npm package-lock root version differs');
    }
    runtime = capture(text(root, 'typescript/src/version.ts'), /VERSION\s*=\s*['"]([^'"]+)['"]/, 'TypeScript runtime version');
  } else if (sdk === 'go') {
    version = capture(text(root, 'go/client.go'), /\bVersion\s*=\s*"([^"]+)"/, 'Go version');
    if (capture(text(root, 'go/go.mod'), /^module\s+(\S+)/m, 'Go module') !== PACKAGES.go) {
      throw new Error('Go module identity changed');
    }
    if (Number(version.split('.')[0]) >= 2) {
      throw new Error('Go v2+ requires a separate module-path migration before using this publisher');
    }
  } else if (sdk === 'java') {
    version = capture(text(root, 'java/pom.xml'), /<groupId>com\.topthink<\/groupId>\s*<artifactId>think-ai<\/artifactId>\s*<version>([^<]+)<\/version>/, 'Maven project version');
    runtime = capture(text(root, 'java/src/main/java/com/topthink/ai/ThinkAIClient.java'), /\bVERSION\s*=\s*"([^"]+)"/, 'Java runtime version');
  } else {
    const metadata = text(root, 'dotnet/TopThink.ThinkAI/TopThink.ThinkAI.csproj');
    if (capture(metadata, /<PackageId>([^<]+)<\/PackageId>/, 'NuGet package') !== PACKAGES.dotnet) {
      throw new Error('NuGet package identity changed');
    }
    version = capture(metadata, /<Version>([^<]+)<\/Version>/, '.NET project version');
    runtime = capture(text(root, 'dotnet/TopThink.ThinkAI/ThinkAIClient.cs'), /\bVersion\s*=\s*"([^"]+)"/, '.NET runtime version');
  }
  stableVersion(version);
  if (runtime && runtime !== version) {
    throw new Error(`${sdk}: package version ${version} differs from runtime ${runtime}`);
  }
  return { sdk, package: PACKAGES[sdk], version, tag: tagFor(sdk, version) };
}

export function prepare(root, sdk, next, execute = false) {
  const current = versionInfo(root, sdk);
  stableVersion(next);
  if (sdk === 'go' && Number(next.split('.')[0]) >= 2) {
    throw new Error('Go v2+ needs a module-path migration');
  }
  const edits = new Map();
  const edit = (path, pattern, replacement) => {
    const before = text(root, path);
    if (!pattern.test(before)) throw new Error(`Version field missing: ${path}`);
    edits.set(path, { before, after: before.replace(pattern, replacement) });
  };
  if (sdk === 'php') {
    edits.set('php/VERSION', { before: text(root, 'php/VERSION'), after: next + '\n' });
  }
  if (sdk === 'python') {
    edit('python/pyproject.toml', /^(version\s*=\s*")[^"]+(".*)$/m, `$1${next}$2`);
    edit('python/src/thinkai/_version.py', /(__version__\s*=\s*['"])[^'"]+(['"])/, `$1${next}$2`);
  }
  if (sdk === 'typescript') {
    for (const path of ['typescript/package.json', 'typescript/package-lock.json']) {
      const before = text(root, path),
        metadata = JSON.parse(before);
      metadata.version = next;
      if (path.endsWith('package-lock.json')) metadata.packages[''].version = next;
      edits.set(path, { before, after: JSON.stringify(metadata, null, 2) + '\n' });
    }
    edit('typescript/src/version.ts', /(VERSION\s*=\s*['"])[^'"]+(['"])/, `$1${next}$2`);
  }
  if (sdk === 'go') {
    edit('go/client.go', /(\bVersion\s*=\s*")[^"]+(")/, (_, prefix, suffix) => prefix + next + suffix);
  }
  if (sdk === 'java') {
    edit('java/pom.xml', /(<groupId>com\.topthink<\/groupId>\s*<artifactId>think-ai<\/artifactId>\s*<version>)[^<]+(<\/version>)/, `$1${next}$2`);
    edit('java/src/main/java/com/topthink/ai/ThinkAIClient.java', /(\bVERSION\s*=\s*")[^"]+(")/, (_, prefix, suffix) => prefix + next + suffix);
  }
  if (sdk === 'dotnet') {
    edit('dotnet/TopThink.ThinkAI/TopThink.ThinkAI.csproj', /(<Version>)[^<]+(<\/Version>)/, `$1${next}$2`);
    edit('dotnet/TopThink.ThinkAI/ThinkAIClient.cs', /(\bVersion\s*=\s*")[^"]+(")/, (_, prefix, suffix) => prefix + next + suffix);
  }
  if (sdk !== 'php' && current.version !== next) {
    const path = `${sdk}/README.md`,
      before = text(root, path);
    edits.set(path, { before, after: before.split(current.version)
      .join(next) });
  }
  const changed = [...edits].filter(([, value]) => value.before !== value.after);
  // Parse all fields first; no file is written until every edit has been validated.
  if (execute) {
    const written = [];
    try {
      for (const [path, value] of changed) {
        writeFileSync(join(root, path), value.after);
        written.push(path);
      }
      versionInfo(root, sdk);
    } catch (error) {
      for (const path of written.reverse()) writeFileSync(join(root, path), edits.get(path).before);
      throw error;
    }
  }
  return {
    sdk,
    from: current.version,
    to: next,
    tag: tagFor(sdk, next),
    execute,
    files: changed.map(([path]) => path),
  };
}

export function run(command, args, { cwd = ROOT, env = process.env, capture: captured = false, allowFailure = false, quiet = false, input } = {}) {
  if (!quiet && !captured) console.log('>', command, ...args.map((arg) => JSON.stringify(arg)));
  const result = spawnSync(command, args, {
    cwd,
    env,
    input,
    encoding: 'utf8',
    stdio: captured ? 'pipe' : 'inherit',
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw new Error(`Cannot run ${basename(command)}: ${result.error.message}`);
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${basename(command)} failed (exit ${result.status})${captured ? ': ' + (result.stderr || '').trim() : ''}`);
  }
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}
const git = (root, args, options = {}) => run('git', ['--no-optional-locks', ...args], { cwd: root, capture: true, ...options });
export function gitState(root) {
  const commit = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  const branch = git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
    allowFailure: true,
  }).stdout.trim();
  const dirty = Boolean(git(root, ['status', '--porcelain=v1', '--untracked-files=all']).stdout.trim());
  return { commit, branch, dirty };
}

export function composerCommand(root, environment = process.env, platform = process.platform) {
  const explicit = environment.THINKAI_COMPOSER_PHAR;
  if (explicit && !existsSync(explicit)) {
    throw new Error('THINKAI_COMPOSER_PHAR must point to an existing composer.phar');
  }
  const local = join(root, '.tools/composer.phar');
  if (explicit || existsSync(local)) return ['php', [explicit || local]];
  if (platform === 'win32') {
    for (const entry of (environment.PATH || environment.Path || '').split(';')) {
      const directory = entry.trim()
        .replace(/^"(.*)"$/, '$1');
      if (!directory) continue;
      const phar = join(directory, 'composer.phar'),
        executable = join(directory, 'composer.exe');
      if (existsSync(phar)) return ['php', [phar]];
      if (existsSync(executable)) return [executable, []];
    }
    throw new Error('Windows Composer needs composer.phar on PATH, or set THINKAI_COMPOSER_PHAR to its full path');
  }
  return ['composer', []];
}
function tools(root, needMaven = false, needComposer = false) {
  const environment = { ...process.env, PYTHONUTF8: '1' };
  const localPython = join(root, 'python/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const python = process.env.THINKAI_PYTHON || (existsSync(localPython) ? localPython : 'python');
  const composer = needComposer ? composerCommand(root) : ['composer', []];
  const npmCandidates = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')].filter(Boolean);
  const npmPath = process.env.THINKAI_NPM_CLI || npmCandidates.find((path) => existsSync(path));
  const npm = npmPath ? [process.execPath, [npmPath]] : ['npm', []];
  const javaTools = join(root, 'java/.tools');
  const directories = existsSync(javaTools) ? readdirSync(javaTools) : [];
  if (!environment.JAVA_HOME) {
    const localJdk = directories.find((name) => name.startsWith('jdk-'));
    if (localJdk) environment.JAVA_HOME = join(javaTools, localJdk);
  }
  let maven = ['mvn', []];
  if (process.platform === 'win32' && needMaven) {
    const pathMavenBin = (process.env.PATH || '')
      .split(';')
      .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
      .find((directory) => directory && existsSync(join(directory, 'mvn.cmd')));
    const mavenHome =
      process.env.MAVEN_HOME ||
      (directories.find((name) => name.startsWith('apache-maven-'))
        ? join(
          javaTools,
          directories.find((name) => name.startsWith('apache-maven-')),
        )
        : pathMavenBin
          ? resolve(pathMavenBin, '..')
          : null);
    if (mavenHome) {
      const boot = join(mavenHome, 'boot'),
        jar = readdirSync(boot)
          .find((name) => /^plexus-classworlds-.*\.jar$/.test(name));
      if (!jar) throw new Error('Maven bootstrap JAR is missing');
      const java = environment.JAVA_HOME ? join(environment.JAVA_HOME, 'bin/java.exe') : 'java';
      maven = [java, ['-classpath', join(boot, jar), `-Dclassworlds.conf=${join(mavenHome, 'bin/m2.conf')}`, `-Dmaven.home=${mavenHome}`, `-Dmaven.multiModuleProjectDirectory=${join(root, 'java')}`, 'org.codehaus.plexus.classworlds.launcher.Launcher']];
    } else {
      throw new Error('Windows Maven needs MAVEN_HOME or its bin directory on PATH');
    }
  }
  return { environment, python, composer, npm, maven };
}

export function expectedArtifacts(sdk, version) {
  return {
    php: [`topthink-think-ai-${version}.zip`],
    python: [`topthink_think_ai-${version}-py3-none-any.whl`, `topthink_think_ai-${version}.tar.gz`],
    typescript: [`topthink-think-ai-${version}.tgz`],
    go: [],
    java: [`think-ai-${version}.jar`, `think-ai-${version}-sources.jar`, `think-ai-${version}-javadoc.jar`, `think-ai-${version}.pom`],
    dotnet: [`TopThink.ThinkAI.${version}.nupkg`],
  }[sdkName(sdk)];
}
const releaseDirectory = (root, info) => join(root, '.artifacts/releases', info.sdk, stableVersion(info.version));
export function validateManifest(root, info, state = gitState(root)) {
  const directory = releaseDirectory(root, info);
  const path = join(directory, 'manifest.json');
  if (!existsSync(path)) throw new Error(`Build first: node scripts/release.mjs build ${info.sdk}`);
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  if (manifest.schema !== 1 || manifest.sdk !== info.sdk || manifest.version !== info.version || manifest.tag !== info.tag || manifest.commit !== state.commit || manifest.dirty) {
    throw new Error('Release manifest is stale or was built from uncommitted files; commit/push, then rebuild');
  }
  const expected = expectedArtifacts(info.sdk, info.version)
    .sort();
  if (
    !Array.isArray(manifest.files) ||
    manifest.files.length !== expected.length ||
    manifest.files
      .map((file) => basename(file.path))
      .sort()
      .some((name, index) => name !== expected[index])
  ) {
    throw new Error('Release artifact set does not match this version');
  }
  for (const file of manifest.files) {
    const artifact = resolve(root, file.path);
    if (!artifact.startsWith(resolve(directory) + sep) || !realpathSync(artifact)
      .startsWith(realpathSync(directory) + sep)) {
      throw new Error('Artifact must stay inside the release directory');
    }
    if (statSync(artifact).size !== file.size || SHA256(readFileSync(artifact)) !== file.sha256) {
      throw new Error(`Artifact checksum mismatch: ${basename(artifact)}`);
    }
  }
  return manifest;
}

export function build(root, sdk) {
  const info = versionInfo(root, sdk),
    before = gitState(root),
    tool = tools(root, sdk === 'java', sdk === 'php');
  const directory = releaseDirectory(root, info),
    output = join(directory, 'build-' + randomUUID());
  mkdirSync(output, { recursive: true });
  const call = (command, args, cwd = root) => run(command, args, { cwd, env: tool.environment });
  const npm = (args) => call(tool.npm[0], [...tool.npm[1], ...args], join(root, 'typescript'));
  if (sdk === 'php') {
    call(tool.composer[0], [...tool.composer[1], 'validate', '--strict']);
    call(tool.python, ['tests/php/verify-migration.py']);
    call(tool.python, ['tests/packaging/php-dist.py', '--composer', tool.composer[0], ...tool.composer[1]]);
    copyFileSync(join(root, '.artifacts/think-ai-php.zip'), join(output, expectedArtifacts(sdk, info.version)[0]));
  } else if (sdk === 'python') {
    call(tool.python, ['-m', 'pytest', 'python/tests', '-q']);
    call(tool.python, ['python/scripts/check_package.py', ...(process.env.THINKAI_PIP_PYTHON ? ['--pip-python', process.env.THINKAI_PIP_PYTHON] : [])]);
    call(tool.python, ['-m', 'build', 'python', '--no-isolation', '--outdir', output]);
    call(tool.python, ['-m', 'twine', 'check', '--strict', ...expectedArtifacts(sdk, info.version)
      .map((name) => join(output, name))]);
  } else if (sdk === 'typescript') {
    npm(['test']);
    npm(['run', 'check:package']);
    npm(['pack', '--pack-destination', output]);
  } else if (sdk === 'go') {
    call('go', ['test', './...', '-count=1', '-timeout=120s'], join(root, 'go'));
    call('go', ['vet', './...'], join(root, 'go'));
    call('go', ['mod', 'tidy', '-diff'], join(root, 'go'));
  } else if (sdk === 'java') {
    const args = ['-B', '-f', join(root, 'java/pom.xml')];
    if (process.env.THINKAI_JAVA_SOCKET_DIR) {
      args.push(`-DargLine=-Djdk.net.unixdomain.tmpdir=${process.env.THINKAI_JAVA_SOCKET_DIR}`);
    }
    call(tool.maven[0], [...tool.maven[1], ...args, 'verify']);
    call(tool.python, ['java/scripts/verify_package.py']);
    for (const name of expectedArtifacts(sdk, info.version)) {
      copyFileSync(join(root, name.endsWith('.pom') ? 'java/pom.xml' : 'java/target/' + name), join(output, name));
    }
  } else {
    call('dotnet', ['test', 'dotnet/TopThink.ThinkAI.Tests', '-c', 'Release']);
    call(tool.python, ['dotnet/scripts/verify_package.py']);
    call('dotnet', ['pack', 'dotnet/TopThink.ThinkAI', '-c', 'Release', '-o', output]);
  }
  const after = gitState(root);
  if (before.commit !== after.commit || versionInfo(root, sdk).version !== info.version) {
    throw new Error('Source commit/version changed during the build');
  }
  const manifest = {
    schema: 1,
    ...info,
    commit: after.commit,
    dirty: before.dirty || after.dirty,
    built_at: new Date()
      .toISOString(),
    files: expectedArtifacts(sdk, info.version)
      .map((name) => {
        const path = join(output, name);
        return {
          path: relative(root, path)
            .split(sep)
            .join('/'),
          size: statSync(path).size,
          sha256: SHA256(readFileSync(path)),
        };
      }),
  };
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify(manifest, null, 2));
  return manifest;
}

export function credentialRequirements(sdk, env = process.env, { resumeId } = {}) {
  const required =
    {
      python: ['TWINE_PASSWORD'],
      java: ['CENTRAL_TOKEN_USERNAME', 'CENTRAL_TOKEN_PASSWORD', ...(resumeId ? [] : ['GPG_KEY_ID'])],
      dotnet: ['NUGET_API_KEY'],
    }[sdk] || [];
  return required.filter((name) => !env[name]);
}
export function registryCommand(info, artifacts, resumeId) {
  sdkName(info.sdk);
  if (info.sdk === 'python') {
    return ['python', '-m', 'twine', 'upload', '--non-interactive', '--repository-url', 'https://upload.pypi.org/legacy/', ...artifacts];
  }
  if (info.sdk === 'typescript') {
    return ['npm', 'publish', artifacts[0], '--access', 'public', '--registry', 'https://registry.npmjs.org/', '--tag', 'latest', '--ignore-scripts'];
  }
  if (info.sdk === 'dotnet') {
    return ['dotnet', 'nuget', 'push', artifacts[0], '--source', 'https://api.nuget.org/v3/index.json'];
  }
  if (info.sdk === 'java') {
    return resumeId ? ['POST', 'https://central.sonatype.com/api/v1/publisher/status?id=' + encodeURIComponent(resumeId), 'wait-for-PUBLISHED'] : ['POST', 'https://central.sonatype.com/api/v1/publisher/upload?publishingType=AUTOMATIC', '<signed bundle of manifest artifacts>', 'wait-for-PUBLISHED'];
  }
  return ['git', '-c', 'push.followTags=false', 'push', '<origin push URL>', 'refs/tags/' + info.tag];
}
function readReceipt(root, info) {
  const path = join(releaseDirectory(root, info), 'publish-result.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
}
export function publishPreview(root, sdk) {
  const info = versionInfo(root, sdk),
    state = gitState(root),
    blocked = [];
  if (state.dirty) blocked.push('Working tree has uncommitted/untracked files');
  if (!state.branch) blocked.push('Checkout a branch before publishing');
  const localTag = git(root, ['rev-parse', '--verify', '--quiet', 'refs/tags/' + info.tag + '^{commit}'], { allowFailure: true }).stdout.trim();
  if (localTag && localTag !== state.commit) {
    blocked.push('Existing local tag points at another commit; choose a new version');
  }
  let manifest;
  try {
    manifest = validateManifest(root, info, state);
  } catch (error) {
    blocked.push(error.message);
  }
  let previous;
  try {
    previous = readReceipt(root, info);
  } catch {
    blocked.push('Cannot parse local publish-result.json');
  }
  const resumeId = previous?.commit === state.commit ? previous.deployment_id : undefined;
  if (previous?.stage === 'published' && previous.commit === state.commit) {
    blocked.push('Already recorded as published; use verify instead');
  }
  for (const name of credentialRequirements(sdk, process.env, { resumeId })) {
    blocked.push(`Missing environment variable: ${name}`);
  }
  return {
    ...info,
    commit: state.commit,
    dry_run: true,
    ...(resumeId ? { resume_deployment_id: resumeId } : {}),
    blocked,
    commands: [['git', 'ls-remote', '<origin push URL>', 'refs/heads/' + state.branch, 'refs/tags/' + info.tag, 'refs/tags/' + info.tag + '^{}'], ['git', 'tag', '-a', info.tag, state.commit, '-m', `${sdk} ${info.version}`], ['git', '-c', 'push.followTags=false', 'push', '<origin push URL>', 'refs/tags/' + info.tag], ...(['php', 'go'].includes(sdk) ? [] : [registryCommand(info, manifest?.files.map((file) => file.path) || expectedArtifacts(sdk, info.version).map((name) => '<release-dir>/' + name), resumeId)])],
    note: 'No tag/push/upload, network request, or credential file is executed in preview. Existing same-commit tags are reused. PHP/Go verify the registry index after pushing.',
  };
}
function originPushURL(root, readGit = git) {
  const value = readGit(root, ['remote', 'get-url', '--push', 'origin']).stdout.trim();
  if (!/^(?:git@github\.com:|https:\/\/github\.com\/)top-think\/think-ai(?:\.git)?\/?$/.test(value)) {
    throw new Error('origin push URL must be the ThinkAI GitHub repository, without embedded credentials');
  }
  return value;
}
export function parseRemoteRefs(output) {
  return new Map(
    output
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [sha, ref] = line.split(/\s+/);
        return [ref, sha];
      }),
  );
}
export function tagState(refs, tag, commit, localCommit = '') {
  const reference = 'refs/tags/' + tag;
  const remoteCommit = refs.get(reference + '^{}') || refs.get(reference) || '';
  if ((remoteCommit && remoteCommit !== commit) || (localCommit && localCommit !== commit)) {
    throw new Error('Existing release tag points at another commit; never overwrite release tags');
  }
  return { remoteExists: Boolean(remoteCommit), localExists: Boolean(localCommit) };
}
function temporaryConfig(contents, filename) {
  const directory = mkdtempSync(join(tmpdir(), 'thinkai-release-')),
    path = join(directory, filename);
  writeFileSync(path, contents, { mode: 0o600 });
  return {
    path,
    close() {
      unlinkSync(path);
      rmdirSync(directory);
    },
  };
}

export async function verifyPublished(root, sdk) {
  const info = versionInfo(root, sdk);
  if (sdk === 'go') {
    // A proxy lookup before the tag exists can cache a negative result.
    const url = originPushURL(root),
      refs = parseRemoteRefs(git(root, ['ls-remote', '--tags', url, 'refs/tags/' + info.tag, 'refs/tags/' + info.tag + '^{}']).stdout);
    if (!refs.has('refs/tags/' + info.tag)) {
      throw new Error('Push the Go version tag before requesting the module proxy');
    }
    const indexURL = `https://proxy.golang.org/${PACKAGES.go}/@v/v${info.version}.info`;
    const response = await fetch(indexURL, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok || (await response.json()).Version !== 'v' + info.version) {
      throw new Error(`Go tag may be pushed, but the public module proxy is not ready (HTTP ${response.status}); retry verify later`);
    }
    return { ...info, indexed: true, url: indexURL };
  }
  const urls = {
    php: 'https://repo.packagist.org/p2/topthink/think-ai.json',
    python: `https://pypi.org/pypi/topthink-think-ai/${info.version}/json`,
    typescript: `https://registry.npmjs.org/@topthink%2fthink-ai/${info.version}`,
    java: `https://repo.maven.apache.org/maven2/com/topthink/think-ai/${info.version}/think-ai-${info.version}.pom`,
    dotnet: `https://api.nuget.org/v3-flatcontainer/topthink.thinkai/${info.version}/topthink.thinkai.nuspec`,
  };
  const response = await fetch(urls[sdk], { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    throw new Error(`Registry version is not visible yet (HTTP ${response.status}); retry verify later`);
  }
  if (sdk === 'php') {
    const result = await response.json();
    if (!result.packages?.[PACKAGES.php]?.some((item) => item.version.replace(/^v/, '') === info.version)) {
      throw new Error('Tag may be pushed, but Packagist has not indexed this version; check its webhook, then retry verify');
    }
  } else {
    await response.arrayBuffer();
  }
  return { ...info, indexed: true, url: urls[sdk] };
}

export async function publish(root, sdk, execute = false, dependencies = {}) {
  if (!execute) return publishPreview(root, sdk);
  const readState = dependencies.gitState || gitState;
  const readGit = dependencies.git || git;
  const executeCommand = dependencies.run || run;
  const verify = dependencies.verify || verifyPublished;
  const info = versionInfo(root, sdk),
    state = readState(root);
  if (state.dirty || !state.branch) {
    throw new Error('Commit all changes and push the current branch before publishing');
  }
  const manifest = validateManifest(root, info, state),
    previous = readReceipt(root, info);
  if (previous?.stage === 'published' && previous.commit === state.commit) {
    throw new Error('This local release is already recorded as published; use verify instead');
  }
  const resumeId = previous?.commit === state.commit ? previous.deployment_id : undefined;
  const missing = credentialRequirements(sdk, process.env, { resumeId });
  if (missing.length) throw new Error('Missing credentials: ' + missing.join(', '));
  const tool = tools(root),
    environment = { ...tool.environment },
    temporary = [];
  let receipt;
  try {
    if (sdk === 'python') {
      environment.TWINE_USERNAME = '__token__';
      executeCommand(tool.python, ['-m', 'twine', '--version'], { cwd: root, env: environment });
    }
    if (sdk === 'typescript') {
      if (process.env.NPM_TOKEN) {
        const config = temporaryConfig('//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n', 'npmrc');
        temporary.push(config);
        environment.NPM_CONFIG_USERCONFIG = config.path;
      }
      executeCommand(tool.npm[0], [...tool.npm[1], 'whoami', '--registry', 'https://registry.npmjs.org/'], { cwd: root, env: environment });
    }
    if (sdk === 'dotnet') {
      const version = executeCommand('dotnet', ['--version'], { capture: true }).stdout.trim();
      const [major, minor, patch] = version.split('.')
        .map(Number);
      if (!(major > 10 || (major === 10 && (minor > 0 || patch >= 300)))) {
        throw new Error('Publishing with NUGET_API_KEY requires .NET SDK 10.0.300+');
      }
    }
    if (sdk === 'java' && !resumeId) {
      executeCommand('gpg', ['--list-secret-keys', process.env.GPG_KEY_ID.replace(/!$/, '')], {
        cwd: root,
        capture: true,
      });
    }
    const url = originPushURL(root, readGit);
    const refs = parseRemoteRefs(readGit(root, ['ls-remote', '--heads', '--tags', url, 'refs/heads/' + state.branch, 'refs/tags/' + info.tag, 'refs/tags/' + info.tag + '^{}']).stdout);
    if (refs.get('refs/heads/' + state.branch) !== state.commit) {
      throw new Error('Push the current branch HEAD to origin before publishing');
    }
    const localCommit = readGit(root, ['rev-parse', '--verify', '--quiet', 'refs/tags/' + info.tag + '^{commit}'], { allowFailure: true }).stdout.trim();
    const tags = tagState(refs, info.tag, state.commit, localCommit);
    const receiptPath = join(releaseDirectory(root, info), 'publish-result.json');
    receipt = {
      ...info,
      commit: state.commit,
      stage: 'starting',
      updated_at: new Date()
        .toISOString(),
    };
    if (previous?.commit === state.commit && previous.deployment_id) {
      receipt.deployment_id = previous.deployment_id;
    }
    const save = (stage) => {
      receipt.stage = stage;
      receipt.updated_at = new Date()
        .toISOString();
      writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
    };
    // Recheck after all preflight subprocesses, immediately before the first write.
    const current = readState(root);
    if (current.dirty || current.commit !== state.commit || current.branch !== state.branch) {
      throw new Error('Source changed during release preflight');
    }
    validateManifest(root, info, current);
    save('starting');
    try {
      if (!tags.remoteExists) {
        if (!tags.localExists) {
          executeCommand('git', ['tag', '-a', info.tag, state.commit, '-m', `${sdk} ${info.version}`], { cwd: root });
        }
        executeCommand('git', ['-c', 'push.followTags=false', 'push', url, 'refs/tags/' + info.tag], { cwd: root });
      }
      save('tag-pushed');
      const artifacts = manifest.files.map((file) => resolve(root, file.path));
      if (sdk === 'java') {
        const { publishCentral } = await import('./central.mjs');
        await (dependencies.publishCentral || publishCentral)({
          root,
          info,
          manifest,
          python: tool.python,
          environment,
          resumeId: receipt.deployment_id,
          run: executeCommand,
          onUploaded: (id) => {
            receipt.deployment_id = id;
            save('central-uploaded');
          },
        });
      } else if (!['php', 'go'].includes(sdk)) {
        let [command, ...args] = registryCommand(info, artifacts);
        if (command === 'python') command = tool.python;
        if (command === 'npm') {
          command = tool.npm[0];
          args = [...tool.npm[1], ...args];
        }
        executeCommand(command, args, { cwd: root, env: environment });
      }
      if (sdk === 'php' || sdk === 'go') {
        save('index-pending');
        await verify(root, sdk);
      }
      save('published');
      return receipt;
    } catch (error) {
      receipt.error = error.message;
      save(receipt.stage);
      throw new Error(`${error.message}. Release progress is recorded in ${relative(root, receiptPath)}; do not delete/rewrite tags or assume an upload was rolled back.`);
    }
  } finally {
    for (const config of temporary.reverse()) config.close();
  }
}

export async function main(argv = process.argv.slice(2), root = ROOT) {
  if (Number(process.versions.node.split('.')[0]) < 22) {
    throw new Error('Release tools require Node.js 22+');
  }
  const [command, sdk, value, ...rest] = argv;
  if (!command || ['--help', 'help', '-h'].includes(command)) {
    console.log('ThinkAI release tools (Node.js 22+)\n\nstatus\ncheck <sdk|all>\nprepare <sdk> <X.Y.Z> [--execute]\nbuild <sdk|all>\npublish <sdk> [--execute]\nverify <sdk>\n\nSDKs: php, python, typescript, go, java, dotnet. prepare/publish default to a read-only preview. Publishing any SDK requires an explicit --execute. build runs tests and local packaging. No credentials are required for preview/build. See docs/PUBLISHING.md.');
    return;
  }
  if (command === 'status' || command === 'check') {
    if (command === 'status' && argv.length !== 1) throw new Error('status takes no arguments');
    if (command === 'check' && argv.length !== 2) {
      throw new Error('check takes exactly one SDK or all');
    }
    const selected = command === 'status' || sdk === 'all' ? SDKS : [sdkName(sdk)];
    console.log(
      JSON.stringify(
        selected.map((item) => versionInfo(root, item)),
        null,
        2,
      ),
    );
    return;
  }
  sdkName(sdk === 'all' && command === 'build' ? 'php' : sdk);
  const flags = command === 'prepare' ? rest : argv.slice(2);
  if (flags.some((flag) => !['--execute', '--dry-run'].includes(flag)) || (flags.includes('--execute') && flags.includes('--dry-run'))) {
    throw new Error('Only --execute or --dry-run is supported');
  }
  if (command === 'prepare') {
    console.log(JSON.stringify(prepare(root, sdk, value, flags.includes('--execute')), null, 2));
  } else if (command === 'build') {
    if (flags.length) throw new Error('build runs local checks; it takes no flags');
    for (const item of sdk === 'all' ? SDKS : [sdk]) build(root, item);
  } else if (command === 'publish') {
    console.log(JSON.stringify(await publish(root, sdk, flags.includes('--execute')), null, 2));
  } else if (command === 'verify') {
    if (flags.length) throw new Error('verify takes no flags');
    console.log(JSON.stringify(await verifyPublished(root, sdk), null, 2));
  } else {
    throw new Error('Unknown command; use --help');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main()
    .catch((error) => {
      console.error('Release error:', error.message);
      process.exitCode = 1;
    });
}
