/** Build/pack/install a local npm artifact and exercise installed ESM/CJS/types. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve, sep } from 'node:path';

const project = fileURLToPath(new URL('..', import.meta.url));
const metadata = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8'));
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run this script with npm run check:package');
const runNpm = (args, cwd = project) => execFileSync(process.execPath, [npm, ...args], { cwd, encoding: 'utf8' });
process.stdout.write(runNpm(['run', 'build']));
const workspace = join(project, '.package-check');
mkdirSync(workspace, { recursive: true });
const directory = mkdtempSync(join(workspace, 'consumer-'));
try {
  const [artifact] = JSON.parse(runNpm(['pack', '--ignore-scripts', '--json', '--pack-destination', directory]));
  for (const expected of ['LICENSE', 'dist/esm/index.js', 'dist/cjs/index.js', 'dist/esm/index.d.ts', 'dist/cjs/index.d.ts']) {
    if (!artifact.files.some(file => file.path === expected)) throw new Error(`Missing package entry ${expected}`);
  }
  if (artifact.files.some(file => file.path.startsWith('src/') || file.path.startsWith('tests/'))) throw new Error('Unexpected development files in npm artifact');
  writeFileSync(join(directory, 'package.json'), '{"private":true,"type":"module"}\n');
  process.stdout.write(runNpm(['install', '--ignore-scripts', '--no-audit', '--no-fund', join(directory, artifact.filename)], directory));
  const esm = `import assert from 'node:assert/strict'; import {Client,EventStream,VERSION} from '@topthink/think-ai'; import {fileURLToPath} from 'node:url'; assert.ok(fileURLToPath(import.meta.resolve('@topthink/think-ai')).includes('node_modules')); assert.equal(VERSION,${JSON.stringify(metadata.version)}); assert.equal(new Client('offline').timeout,300); assert.equal(typeof EventStream,'function'); console.log('Installed ESM OK');\n`;
  const cjs = `const assert=require('node:assert/strict'); const sdk=require('@topthink/think-ai'); assert.ok(require.resolve('@topthink/think-ai').includes('node_modules')); assert.equal(sdk.VERSION,${JSON.stringify(metadata.version)}); assert.equal(new sdk.Client('offline').timeout,300); console.log('Installed CommonJS OK');\n`;
  writeFileSync(join(directory, 'consumer.mjs'), esm);
  writeFileSync(join(directory, 'consumer.cjs'), cjs);
  for (const file of ['consumer.mjs', 'consumer.cjs']) execFileSync(process.execPath, [file], { cwd: directory, stdio: 'inherit' });
  const typed = "import {Client, type Result, type ChatParams} from '@topthink/think-ai'; const client = new Client('offline'); const params: ChatParams = {model:'test',messages:[{role:'user',content:'你好'}],stream:false,custom_option:{enabled:true}}; const response: Promise<Result> = client.chat.completions(params); void response;\n";
  for (const extension of ['mts', 'cts']) writeFileSync(join(directory, `consumer.${extension}`), typed);
  execFileSync(process.execPath, [join(project, 'node_modules/typescript/lib/tsc.js'), '--noEmit', '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--skipLibCheck', 'consumer.mts', 'consumer.cts'], { cwd: directory, stdio: 'inherit' });
  console.log('Installed ESM/CommonJS declaration consumers OK');
} finally {
  if (!resolve(directory).startsWith(resolve(workspace) + sep)) throw new Error('Refusing to remove an unexpected consumer directory');
  rmSync(directory, { recursive: true, force: true });
}
