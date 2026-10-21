#!/usr/bin/env python3
"""Read tracked files without executing repository code. Block incident indicators."""
import json
import pathlib
import re
import subprocess
import sys

FORBIDDEN_NAMES = {'fa-solid-300.llf', 'fa-solid.lfk', 'temp_auto_push.bat',
                   'temp_interactive_push.bat', 'branch_structure.json'}
FORBIDDEN_SUFFIXES = ('.llf', '.lfk')
HIDDEN_IGNORE = {'temp_auto_push.bat', 'temp_interactive_push.bat', 'branch_structure.json'}
# Code pushed off-screen: hundreds of tabs, or of spaces, then something on the same line. The
# incident's payloads start with `global[`, `var _0x` or, in api.js, `import{createRequire}`, so
# what follows is not matched: any code that far to the right is hidden on purpose.
CONCEALED = re.compile(rb'(?:\t{100,}|[ ]{200,})[^\s]')
# npm runs these by itself, on install or publish: nothing here needs them.
LIFECYCLE_SCRIPTS = {'preinstall', 'install', 'postinstall', 'prepare', 'prepublish',
                     'prepublishonly', 'prepack', 'postpack', 'dependencies'}
# Package scripts run node only on what tsc compiled into dist/. The incident's build hook was
# `node api.js && ...`, a file in the source tree.
NODE_TARGET = re.compile(r'\bnode\s+((?:--?[\w-]+(?:=\S+)?\s+)*)([^\s&|;]+)')

def script_problems(text):
    """Problems with a package.json's scripts; nothing for one that is not JSON."""
    try:
        scripts = json.loads(text).get('scripts') or {}
    except (ValueError, AttributeError):
        return []
    problems = []
    for name, command in scripts.items():
        if name.lower() in LIFECYCLE_SCRIPTS:
            problems.append('package script runs automatically on install or publish')
        for match in NODE_TARGET.finditer(str(command)):
            target = match.group(2).lstrip('./')
            if not target.startswith('dist/'):
                problems.append('package script runs a file outside dist/ with node')
    return problems

def violations(path, data):
    """Return reasons without logging file contents or credentials."""
    lower = path.lower().replace('\\', '/')
    name = lower.rsplit('/', 1)[-1]
    problems = []
    if name in FORBIDDEN_NAMES or lower.endswith(FORBIDDEN_SUFFIXES):
        problems.append('incident payload or propagation filename')
    text = data.decode('utf-8', errors='replace')
    if ('.vscode/' in lower or lower.endswith('.code-workspace')):
        # Accept JSONC without evaluating it. Decode escaped strings too.
        strings = []
        for match in re.finditer(r'"(?:[^"\\]|\\.)*"', text):
            try:
                strings.append(json.loads(match.group()))
            except ValueError:
                pass
        if 'folderOpen' in strings:
            problems.append('editor task runs automatically when a folder opens')
        if re.search(r'"task\.allowAutomaticTasks"\s*:\s*(?:"on"|true)', text):
            problems.append('editor enables automatic tasks without approval')
        if 'task.allowAutomaticTasks' in strings and 'on' in strings:
            problems.append('editor enables automatic tasks without approval')
    if name == '.gitignore':
        for line in text.splitlines():
            if line.strip().lstrip('/').lower() in HIDDEN_IGNORE:
                problems.append('ignore rule conceals incident propagation tools')
    if name == 'package.json':
        problems.extend(script_problems(text))
    # The incident JavaScript is concealed behind hundreds of tabs, even if renamed. Binary files
    # (a NUL early on) are left out: whitespace in them means nothing.
    if b'\0' not in data[:8192] and CONCEALED.search(data):
        problems.append('concealed incident JavaScript')
    font_headers = {'.woff': (b'wOFF',), '.woff2': (b'wOF2',),
                    '.ttf': (b'\x00\x01\x00\x00', b'true', b'ttcf'), '.otf': (b'OTTO',)}
    suffix = pathlib.PurePosixPath(lower).suffix
    if suffix in font_headers and not data.startswith(font_headers[suffix]):
        problems.append('font extension does not match a valid font header')
    if re.search(rb'-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----', data):
        problems.append('private signing key committed to repository')
    if re.search(rb'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b', data):
        problems.append('GitHub access token committed to repository')
    return sorted(set(problems))

def main():
    root = pathlib.Path(subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], text=True).strip())
    paths = subprocess.check_output(['git', 'ls-files', '-z']).decode('utf-8', errors='surrogateescape').split('\0')
    failures = []
    for path in filter(None, paths):
        target = root / path
        if target.is_symlink() or not target.is_file():
            # Never follow repository symlinks outside the checkout.
            continue
        # Inspect all small files, regardless of extension, including disguised fonts.
        if target.stat().st_size > 8 * 1024 * 1024:
            continue
        for reason in violations(path, target.read_bytes()):
            failures.append((path, reason))
    for path, reason in failures:
        print(json.dumps({'path': path, 'reason': reason}, ensure_ascii=True))
    print(f'Repository security: {len(failures)} violation(s), {len(paths) - 1} tracked files checked.')
    return 1 if failures else 0

if __name__ == '__main__':
    sys.exit(main())
