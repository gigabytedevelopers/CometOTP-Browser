// Builds the extension for each browser from what `tsc` compiled into dist/src and the files in
// static/: an unpacked folder, dist/<target>/, to load for testing, and the zip that goes to the
// store, dist/cometotp-<target>-<version>.zip. Nothing is bundled or minified, so the code in the
// zips is the code tsc wrote, readable by store reviewers. The protocol package is copied in, under
// lib/protocol/, only once the extension imports it.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { TARGETS, manifest, type Target } from './manifest.js';
import { zip } from './zip.js';

export const EXTENSION_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DIST_DIR = join(EXTENSION_DIR, 'dist');
const COMPILED_DIR = join(DIST_DIR, 'src');
const STATIC_DIR = join(EXTENSION_DIR, 'static');

const PROTOCOL = '@cometotp/protocol';
const PROTOCOL_DIR = 'lib/protocol';

export function version(): string {
  return (JSON.parse(readFileSync(join(EXTENSION_DIR, 'package.json'), 'utf8')) as { version: string }).version;
}

export function targetDir(target: Target): string {
  return join(DIST_DIR, target);
}

export function zipPath(target: Target): string {
  return join(DIST_DIR, `cometotp-${target}-${version()}.zip`);
}

/** Every file under `dir`, as paths relative to it with `/` separators, sorted. */
export function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(dir, full).split(sep).join('/'));
    }
  };
  walk(dir);
  return out;
}

const IMPORT_PATTERN = /(\bfrom\s*|\bimport\s*\(?\s*)(['"])@cometotp\/protocol\2/g;

/**
 * Points `@cometotp/protocol` imports in the JavaScript file at `path` (relative to the extension's
 * root) to the copy under lib/protocol/: browsers cannot resolve package names.
 */
export function rewriteImports(source: string, path: string): string {
  let target = posix.relative(posix.dirname(path), `${PROTOCOL_DIR}/index.js`);
  if (!target.startsWith('.')) target = `./${target}`;
  return source.replace(IMPORT_PATTERN, (_match, prefix: string, quote: string) => `${prefix}${quote}${target}${quote}`);
}

/** The compiled scripts, by path, with their imports rewritten; and whether any imports the protocol. */
function scripts(): { files: Map<string, Buffer>; usesProtocol: boolean } {
  const files = new Map<string, Buffer>();
  let usesProtocol = false;
  for (const path of listFiles(COMPILED_DIR)) {
    if (!path.endsWith('.js')) continue;
    const source = readFileSync(join(COMPILED_DIR, path), 'utf8');
    const rewritten = rewriteImports(source, path);
    if (rewritten !== source) usesProtocol = true;
    files.set(path, Buffer.from(rewritten, 'utf8'));
  }
  return { files, usesProtocol };
}

function protocolFiles(): Map<string, Buffer> {
  const dir = dirname(fileURLToPath(import.meta.resolve(PROTOCOL)));
  const files = new Map<string, Buffer>();
  for (const path of listFiles(dir)) {
    if (path.endsWith('.js')) files.set(`${PROTOCOL_DIR}/${path}`, readFileSync(join(dir, path)));
  }
  return files;
}

export function build(): void {
  if (!existsSync(COMPILED_DIR)) throw new Error('Compile first: tsc -p tsconfig.json');
  const { files: compiled, usesProtocol } = scripts();
  const shared = new Map<string, Buffer>(compiled);
  if (usesProtocol) for (const [path, data] of protocolFiles()) shared.set(path, data);
  for (const path of listFiles(STATIC_DIR)) shared.set(path, readFileSync(join(STATIC_DIR, path)));

  for (const target of TARGETS) {
    const files = new Map(shared);
    files.set('manifest.json', Buffer.from(`${JSON.stringify(manifest(target, version()), null, 2)}\n`, 'utf8'));

    const dir = targetDir(target);
    rmSync(dir, { recursive: true, force: true });
    for (const [path, data] of files) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), data);
    }
    writeFileSync(zipPath(target), zip([...files].map(([path, data]) => ({ path, data }))));
    console.log(`${target}: ${files.size} files in ${relative(EXTENSION_DIR, dir)}, ${relative(EXTENSION_DIR, zipPath(target))}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) build();
