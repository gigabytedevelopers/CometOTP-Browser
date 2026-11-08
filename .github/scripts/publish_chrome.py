#!/usr/bin/env python3
"""Upload an extension release to the Chrome Web Store and submit it for review.

extension-chrome.yml runs this once a GitHub release of the extension is published, with the
release's Chromium zip, already checked against the release's SHA256SUMS and the tag. Through the
Chrome Web Store API (v2) it uploads the zip to the item, waits until the store has processed it,
checks that it holds VERSION, and submits it for review: it goes live once Google approves it.

From the environment: ACCESS_TOKEN (for the service account the publisher added in the developer
dashboard, with the chromewebstore scope), PUBLISHER_ID, ITEM_ID, VERSION and ZIP (the zip's path).
The token is sent only to the Chrome Web Store API and never printed. Only the standard library is
used.
"""
import json
import os
import pathlib
import re
import sys
import time
import urllib.error
import urllib.request

API = 'https://chromewebstore.googleapis.com'
ITEM_ID = re.compile(r'[a-p]{32}')
PUBLISHER_ID = re.compile(r'[A-Za-z0-9-]{1,64}')
VERSION = re.compile(r'\d+\.\d+\.\d+')
USER_AGENT = 'cometotp-extension-release'
# The store usually processes a package within seconds; a busy one gets five minutes.
WAIT_SECONDS = 300
POLL_SECONDS = 10


def setting(name):
    value = os.environ.get(name, '').strip()
    if not value:
        sys.exit(f'{name} is not set: see "Publishing to the Chrome Web Store" in .github/RELEASING.md')
    return value


def store(token, method, path, body=None, content_type='application/json'):
    """Calls the Chrome Web Store API and returns its JSON answer; exits with its message on an error."""
    if isinstance(body, dict):
        body = json.dumps(body).encode()
    headers = {'Authorization': f'Bearer {token}', 'Accept': 'application/json', 'User-Agent': USER_AGENT}
    if body is not None:
        headers['Content-Type'] = content_type
    request = urllib.request.Request(f'{API}{path}', data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return json.loads(response.read() or b'{}')
    except urllib.error.HTTPError as error:
        detail = error.read().decode('utf-8', errors='replace')
        try:
            detail = json.loads(detail)['error']['message']
        except (ValueError, KeyError, TypeError):
            detail = detail[:500]
        sys.exit(f'The Chrome Web Store answered {method} {path} with {error.code}: {detail}')
    except urllib.error.URLError as error:
        sys.exit(f'The Chrome Web Store could not be reached for {method} {path}: {error.reason}')


def upload(token, item, package, version):
    """Uploads the package, waits until the store has processed it, and checks its version."""
    answer = store(token, 'POST', f'/upload/v2/{item}:upload', package.read_bytes(), 'application/zip')
    state = answer.get('uploadState')
    deadline = time.monotonic() + WAIT_SECONDS
    while state == 'IN_PROGRESS' and time.monotonic() < deadline:
        time.sleep(POLL_SECONDS)
        state = store(token, 'GET', f'/v2/{item}:fetchStatus').get('lastAsyncUploadState')
    if state == 'IN_PROGRESS':
        sys.exit(f'The store was still processing the package after {WAIT_SECONDS // 60} minutes')
    if state != 'SUCCEEDED':
        sys.exit(f'The store did not take the package: its upload state is {state}')
    uploaded = answer.get('crxVersion')
    if uploaded and uploaded != version:
        sys.exit(f'The store read version {uploaded} from the package, not {version}')
    print(f'The store has {package.name}.')


def publish(token, item):
    """Submits the uploaded version for review, to go live once approved; returns its state."""
    answer = store(token, 'POST', f'/v2/{item}:publish', {'publishType': 'DEFAULT_PUBLISH'})
    for warning in (answer.get('warningInfo') or {}).get('warnings') or []:
        print(f'::warning::The Chrome Web Store warns: {json.dumps(warning)}')
    state = answer.get('state')
    if state not in ('PENDING_REVIEW', 'PUBLISHED', 'STAGED'):
        sys.exit(f'The store did not take the submission: its state is {state}')
    return state


def main():
    token = setting('ACCESS_TOKEN')
    publisher = setting('PUBLISHER_ID')
    item_id = setting('ITEM_ID')
    version = setting('VERSION')
    package = pathlib.Path(setting('ZIP'))
    if not PUBLISHER_ID.fullmatch(publisher):
        sys.exit(f'PUBLISHER_ID is not a publisher id: {publisher}')
    if not ITEM_ID.fullmatch(item_id):
        sys.exit(f'ITEM_ID is not a Chrome Web Store item id: {item_id}')
    if not VERSION.fullmatch(version):
        sys.exit(f'VERSION is not X.Y.Z: {version}')
    if not package.is_file():
        sys.exit(f'There is no package at {package}')

    item = f'publishers/{publisher}/items/{item_id}'
    upload(token, item, package, version)
    state = publish(token, item)
    said = {
        'PENDING_REVIEW': 'is submitted for review, and goes live once Google approves it',
        'PUBLISHED': 'is published',
        'STAGED': 'is approved and staged: publish it from the developer dashboard',
    }[state]
    print(f'CometOTP {version} {said}.')
    summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary:
        with open(summary, 'a', encoding='utf-8') as out:
            out.write(f'CometOTP {version} {said} on the Chrome Web Store.\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
