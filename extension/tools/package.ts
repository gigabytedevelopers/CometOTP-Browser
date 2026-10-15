// Builds the extension for each browser from what `tsc` compiled into dist/src and the files in
// static/: an unpacked folder, dist/<target>/, to load for testing, and the zip that goes to the
// store, dist/cometotp-<target>-<version>.zip. Nothing is bundled or minified, so the code in the
// zips is the code tsc wrote, readable by store reviewers. Packages the extension imports are
// copied in under lib/, unchanged, and the imports pointed at the copies: the protocol package,
// qrcode-generator's ES module build (its licence is in its header), and hash-wasm's with its
// licence, which reviewers can compare with npm's.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { TARGETS, manifest, type Target } from './manifest.js';
import { zip } from './zip.js';

export const EXTENSION_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DIST_DIR = join(EXTENSION_DIR, 'dist');
const COMPILED_DIR = join(DIST_DIR, 'src');
const STATIC_DIR = join(EXTENSION_DIR, 'static');

/** A package the extension imports, and how it is copied into the build. */
interface Vendored {
  /** As the source imports it. */
  specifier: string;
  /** Where its entry point lands in the build. */
  entry: string;
  /** Its files in the build, by path. */
  files(): Map<string, Buffer>;
}

/** The directory of the file `specifier` resolves to. */
function resolvedDir(specifier: string): string {
  return dirname(fileURLToPath(import.meta.resolve(specifier)));
}

const VENDORED: Vendored[] = [
  {
    specifier: '@cometotp/protocol',
    entry: 'lib/protocol/index.js',
    files() {
      const dir = resolvedDir('@cometotp/protocol');
      const files = new Map<string, Buffer>();
      for (const path of listFiles(dir)) {
        if (path.endsWith('.js')) files.set(`lib/protocol/${path}`, readFileSync(join(dir, path)));
      }
      return files;
    },
  },
  {
    // Published as qrcode.mjs; copied as .js, which every browser serves as a module script.
    specifier: 'qrcode-generator',
    entry: 'lib/qrcode-generator/qrcode.js',
    files() {
      const file = fileURLToPath(import.meta.resolve('qrcode-generator'));
      return new Map([['lib/qrcode-generator/qrcode.js', readFileSync(file)]]);
    },
  },
  {
    specifier: 'hash-wasm/dist/index.esm.js',
    entry: 'lib/hash-wasm/index.esm.js',
    files() {
      const dist = resolvedDir('hash-wasm/dist/index.esm.js');
      return new Map([
        ['lib/hash-wasm/index.esm.js', readFileSync(join(dist, 'index.esm.js'))],
        ['lib/hash-wasm/LICENSE', readFileSync(join(dist, '..', 'LICENSE'))],
      ]);
    },
  },
];

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

function importPattern(specifier: string): RegExp {
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return new RegExp(`(\\bfrom\\s*|\\bimport\\s*\\(?\\s*)(['"])${escaped}\\2`, 'g');
}

/**
 * Points the imports of vendored packages in the JavaScript file at `path` (relative to the
 * extension's root) to their copies under lib/: browsers cannot resolve package names.
 */
export function rewriteImports(source: string, path: string): string {
  let rewritten = source;
  for (const { specifier, entry } of VENDORED) {
    let target = posix.relative(posix.dirname(path), entry);
    if (!target.startsWith('.')) target = `./${target}`;
    rewritten = rewritten.replace(importPattern(specifier), (_match, prefix: string, quote: string) => `${prefix}${quote}${target}${quote}`);
  }
  return rewritten;
}

/** The compiled scripts, by path, with their imports rewritten; and the vendored packages they import. */
function scripts(): { files: Map<string, Buffer>; used: Vendored[] } {
  const files = new Map<string, Buffer>();
  const used = new Set<Vendored>();
  for (const path of listFiles(COMPILED_DIR)) {
    if (!path.endsWith('.js')) continue;
    const source = readFileSync(join(COMPILED_DIR, path), 'utf8');
    for (const vendored of VENDORED) if (importPattern(vendored.specifier).test(source)) used.add(vendored);
    files.set(path, Buffer.from(rewriteImports(source, path), 'utf8'));
  }
  return { files, used: VENDORED.filter((v) => used.has(v)) };
}

export function build(): void {
  if (!existsSync(COMPILED_DIR)) throw new Error('Compile first: tsc -p tsconfig.json');
  const { files: compiled, used } = scripts();
  const shared = new Map<string, Buffer>(compiled);
  for (const vendored of used) for (const [path, data] of vendored.files()) shared.set(path, data);
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
