// Checks each built package (dist/<target>/) for what stores and reviewers object to, and what
// would break it in the browser. It is the extension's lint, next to TypeScript's strict checks:
// - the manifest is the one tools/manifest.ts makes, asks for no permission outside
//   ALLOWED_PERMISSIONS and keeps the strict content security policy;
// - every file the manifest names exists, and nothing else is shipped but code, pages and images;
// - pages run no inline script or handler and load nothing from elsewhere;
// - scripts use no eval, string timers, document.write or HTML injection, and import only files
//   that are in the package.
// It reads text with patterns, so it guards against mistakes rather than proving anything.
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ALLOWED_PERMISSIONS, EXTENSION_PAGES_CSP, MAX_DESCRIPTION, TARGETS, manifest, type Target } from './manifest.js';
import { listFiles, targetDir, version } from './package.js';

const SHIPPED = /\.(js|html|css|png|svg|json|wasm)$/;

const SCRIPT_RULES: [RegExp, string][] = [
  [/\beval\s*\(/, 'calls eval'],
  [/\bnew\s+Function\s*\(/, 'builds a function from a string'],
  [/\bset(?:Timeout|Interval)\s*\(\s*['"`]/, 'passes a string to a timer'],
  [/\bdocument\.write(?:ln)?\s*\(/, 'uses document.write'],
  [/\.(?:innerHTML|outerHTML)\s*=|\binsertAdjacentHTML\s*\(/, 'injects HTML'],
];

const IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g;

/** Every permission-like list in the manifest, which must stay within ALLOWED_PERMISSIONS. */
function requested(m: Record<string, unknown>): string[] {
  const lists = ['permissions', 'optional_permissions', 'host_permissions', 'optional_host_permissions'];
  return lists.flatMap((key) => (Array.isArray(m[key]) ? (m[key] as unknown[]).map(String) : []));
}

/** Files the manifest refers to. */
function referenced(m: Record<string, unknown>): string[] {
  const out: string[] = [];
  const icons = (value: unknown) => {
    if (value && typeof value === 'object') out.push(...Object.values(value as Record<string, string>));
  };
  icons(m.icons);
  const action = m.action as Record<string, unknown> | undefined;
  if (action) {
    icons(action.default_icon);
    if (typeof action.default_popup === 'string') out.push(action.default_popup);
  }
  const background = m.background as Record<string, unknown> | undefined;
  if (background) {
    if (typeof background.service_worker === 'string') out.push(background.service_worker);
    if (Array.isArray(background.scripts)) out.push(...background.scripts.map(String));
  }
  return out;
}

export function checkPackage(target: Target, dir = targetDir(target)): string[] {
  const problems: string[] = [];
  if (!existsSync(join(dir, 'manifest.json'))) return [`${target}: no manifest.json; build first`];
  const files = listFiles(dir);
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Record<string, unknown>;

  if (JSON.stringify(m) !== JSON.stringify(manifest(target, version()))) {
    problems.push('manifest.json is not the one tools/manifest.ts makes');
  }
  if (m.manifest_version !== 3) problems.push('manifest_version is not 3');
  for (const permission of requested(m)) {
    if (!ALLOWED_PERMISSIONS.includes(permission)) problems.push(`asks for "${permission}", which is not in ALLOWED_PERMISSIONS`);
  }
  if (typeof m.description !== 'string' || m.description.length > MAX_DESCRIPTION) {
    problems.push(`the description must be at most ${MAX_DESCRIPTION} characters`);
  }
  const csp = (m.content_security_policy as Record<string, unknown> | undefined)?.extension_pages;
  if (csp !== EXTENSION_PAGES_CSP) problems.push('the content security policy is not EXTENSION_PAGES_CSP');
  if ('web_accessible_resources' in m) problems.push('exposes files to web pages (web_accessible_resources)');
  if ('externally_connectable' in m) problems.push('accepts messages from web pages (externally_connectable)');
  for (const path of referenced(m)) {
    if (!files.includes(path)) problems.push(`the manifest names ${path}, which is missing`);
  }

  for (const path of files) {
    if (!SHIPPED.test(path)) {
      problems.push(`${path}: not a file the extension should ship`);
      continue;
    }
    if (path.endsWith('.html')) {
      const html = readFileSync(join(dir, path), 'utf8');
      for (const tag of html.match(/<script\b[^>]*>/gi) ?? []) {
        if (!/\bsrc\s*=/.test(tag)) problems.push(`${path}: inline script`);
      }
      if (/<[^>]+\son[a-z]+\s*=/i.test(html)) problems.push(`${path}: inline event handler`);
      if (/\b(?:src|href)\s*=\s*["']?(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(html)) problems.push(`${path}: loads something from elsewhere`);
    }
    if (path.endsWith('.js')) {
      const js = readFileSync(join(dir, path), 'utf8');
      for (const [pattern, what] of SCRIPT_RULES) if (pattern.test(js)) problems.push(`${path}: ${what}`);
      for (const [, specifier] of js.matchAll(IMPORT)) {
        if (!specifier!.startsWith('./') && !specifier!.startsWith('../')) {
          problems.push(`${path}: imports "${specifier}", which the browser cannot resolve`);
        } else if (!files.includes(posix.normalize(posix.join(posix.dirname(path), specifier!)))) {
          problems.push(`${path}: imports ${specifier}, which is not in the package`);
        }
      }
    }
  }
  return problems.map((problem) => `${target}: ${problem}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problems = TARGETS.flatMap((target) => checkPackage(target));
  for (const problem of problems) console.error(problem);
  console.log(`Extension check: ${problems.length} problem(s) in ${TARGETS.join(' and ')}.`);
  process.exitCode = problems.length ? 1 : 0;
}
