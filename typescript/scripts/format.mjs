/** Canonical layout: Prettier, then chain newlines and their indentation. */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Linter } from 'eslint';
import * as prettier from 'prettier';
import layout from '../eslint.config.mjs';

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const root = dirname(project);
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
  throw new Error('Usage: node scripts/format.mjs [--check]');
}
const check = args[0] === '--check';
const linter = new Linter();

function collect(directory, extension) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? collect(path, extension) : entry.isFile() && entry.name.endsWith(extension) ? [path] : [];
    });
}

const files = [...collect(join(project, 'src'), '.ts'), ...collect(join(project, 'tests'), '.mjs'), ...collect(join(project, 'scripts'), '.mjs'), ...collect(join(root, 'scripts'), '.mjs'), ...collect(join(root, 'tests/contracts'), '.mjs'), ...collect(join(root, 'tests/release'), '.mjs'), join(project, 'eslint.config.mjs')].sort();

let changed = 0;
for (const file of files) {
  const original = readFileSync(file, 'utf8');
  const options = await prettier.resolveConfig(file);
  const base = await prettier.format(original, { ...options, filepath: file });
  const formatted = linter.verifyAndFix(base, layout, { filename: basename(file) });
  if (formatted.messages.some((message) => message.severity === 2)) {
    throw new Error(`${relative(root, file)}: ${JSON.stringify(formatted.messages)}`);
  }
  if (formatted.output !== original) {
    changed++;
    if (check) {
      console.error(relative(root, file));
    } else {
      writeFileSync(file, formatted.output);
    }
  }
}
if (check && changed) {
  console.error(`Run npm --prefix typescript run format to fix ${changed} file(s).`);
  process.exitCode = 1;
} else {
  console.log(`${files.length} files ${check ? 'match' : 'use'} the configured layout.`);
}
