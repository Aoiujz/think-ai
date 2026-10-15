#!/usr/bin/env node
/** Stage exactly the current SDK's checked local packages for CI artifact upload. */
import { randomUUID, createHash } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, versionInfo, expectedArtifacts } from './release.mjs';

const SUPPORTED = ['php', 'python', 'typescript', 'java', 'dotnet'];

export function stage(root, sdk) {
  if (!SUPPORTED.includes(sdk))
    throw new Error(
      `CI package staging supports only: ${SUPPORTED.join(', ')}; Go has no packaged upload`,
    );
  const info = versionInfo(root, sdk),
    names = expectedArtifacts(sdk, info.version);
  const sources = names.map((name) => {
    const source =
      sdk === 'php'
        ? join(root, '.artifacts/think-ai-php.zip')
        : sdk === 'python'
          ? join(root, 'python/dist', name)
          : sdk === 'typescript'
            ? join(root, 'typescript', name)
            : sdk === 'java'
              ? join(root, name.endsWith('.pom') ? 'java/pom.xml' : 'java/target/' + name)
              : join(root, 'dotnet/artifacts', name);
    let present = false;
    try {
      present = statSync(source).isFile();
    } catch {
      /* Give a useful missing-current-version error below. */
    }
    if (!present) throw new Error(`Missing current ${sdk} package: ${relative(root, source)}`);
    return { name, source };
  });
  const parent = resolve(root, '.artifacts/ci', sdk);
  mkdirSync(parent, { recursive: true });
  const path = join(parent, 'stage-' + randomUUID());
  mkdirSync(path);
  const files = sources.map(({ name, source }) => {
    const destination = join(path, name);
    copyFileSync(source, destination);
    const bytes = readFileSync(destination);
    return { name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  writeFileSync(
    join(path, 'manifest.json'),
    JSON.stringify(
      { schema: 1, sdk, package: info.package, version: info.version, files },
      null,
      2,
    ) + '\n',
  );
  return { version: info.version, path, files };
}

export function main(argv = process.argv.slice(2), root = ROOT, environment = process.env) {
  if (argv.length !== 1)
    throw new Error('Usage: node scripts/ci-artifacts.mjs <php|python|typescript|java|dotnet>');
  const result = stage(root, argv[0]);
  if (environment.GITHUB_OUTPUT) {
    if (/[\r\n]/.test(result.path))
      throw new Error('Stage path cannot contain line breaks in GitHub output');
    appendFileSync(environment.GITHUB_OUTPUT, `version=${result.version}\npath=${result.path}\n`);
  }
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error('CI artifact staging error:', error.message);
    process.exitCode = 1;
  }
}
