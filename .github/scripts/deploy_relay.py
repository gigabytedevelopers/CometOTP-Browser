#!/usr/bin/env python3
"""Deploy a relay release to the official relay on Coolify, and wait until it runs.

relay-release.yml runs this once the release's image is published. It gives the Coolify service
relay/deploy/coolify.yaml with the image filled in, pinned to its digest, and a description naming
the release; has Coolify pull the image and restart the relay; and waits until the relay answers
GET /v1/ with that version in X-Relay-Version.

From the environment: COOLIFY_URL, COOLIFY_TOKEN (a token with the write and deploy abilities),
COOLIFY_SERVICE_UUID, RELAY_URL, IMAGE (repository:version@sha256:digest), VERSION and COMMIT. The
token is sent only to COOLIFY_URL and never printed. Only the standard library is used.
"""
import base64
import json
import os
import pathlib
import re
import sys
import time
import urllib.error
import urllib.request

COMPOSE = pathlib.Path(__file__).resolve().parents[2] / 'relay' / 'deploy' / 'coolify.yaml'
PLACEHOLDER = '${RELAY_IMAGE}'
IMAGE = re.compile(r'ghcr\.io/gigabytedevelopers/cometotp-relay:(\d+\.\d+\.\d+)@sha256:[0-9a-f]{64}')
COMMIT = re.compile(r'[0-9a-f]{40}')
USER_AGENT = 'cometotp-relay-release'
# Pulling and restarting takes about a minute; a slow registry or server gets ten.
WAIT_SECONDS = 600
POLL_SECONDS = 10


def setting(name):
    value = os.environ.get(name, '').strip()
    if not value:
        sys.exit(f'{name} is not set: see "Releasing the relay image" in .github/RELEASING.md')
    return value


def compose_for(template, image):
    """The compose file Coolify gets: the template with the image in place of the placeholder."""
    if template.count(PLACEHOLDER) != 1:
        sys.exit(f'{COMPOSE.name} must name the image as {PLACEHOLDER} exactly once')
    return template.replace(PLACEHOLDER, image)


def description_for(version, commit):
    """What Coolify shows for the service. Its own form refuses semicolons, so there are none."""
    return f'Main commit {commit}, release relay-v{version}. Digest-pinned image built from relay/Dockerfile.'


def coolify(base, token, method, path, body=None):
    """Calls Coolify's API and returns its JSON answer; exits with Coolify's message on an error."""
    data = None if body is None else json.dumps(body).encode()
    headers = {'Authorization': f'Bearer {token}', 'Accept': 'application/json', 'User-Agent': USER_AGENT}
    if data is not None:
        headers['Content-Type'] = 'application/json'
    request = urllib.request.Request(f'{base}/api/v1{path}', data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.loads(response.read() or b'{}')
    except urllib.error.HTTPError as error:
        detail = error.read().decode('utf-8', errors='replace')[:500]
        sys.exit(f'Coolify answered {method} {path} with {error.code}: {detail}')
    except urllib.error.URLError as error:
        sys.exit(f'Coolify could not be reached for {method} {path}: {error.reason}')


def running_version(relay):
    """The version the relay says it runs, or None while it restarts or says none."""
    request = urllib.request.Request(f'{relay}/v1/', headers={'User-Agent': USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return response.headers.get('X-Relay-Version')
    except (urllib.error.URLError, TimeoutError, ConnectionError):
        return None


def main():
    base = setting('COOLIFY_URL').rstrip('/')
    token = setting('COOLIFY_TOKEN')
    service = setting('COOLIFY_SERVICE_UUID')
    relay = setting('RELAY_URL').rstrip('/')
    image = setting('IMAGE')
    version = setting('VERSION')
    commit = setting('COMMIT')
    match = IMAGE.fullmatch(image)
    if not match or match.group(1) != version:
        sys.exit(f'IMAGE must be the relay {version} pinned to its digest, not {image}')
    if not COMMIT.fullmatch(commit):
        sys.exit(f'COMMIT must be a full commit hash, not {commit}')

    compose = compose_for(COMPOSE.read_text(encoding='utf-8'), image)
    coolify(base, token, 'PATCH', f'/services/{service}', {
        'description': description_for(version, commit),
        'docker_compose_raw': base64.b64encode(compose.encode('utf-8')).decode('ascii'),
    })
    print(f'Coolify has the service with {image}.')
    coolify(base, token, 'POST', f'/services/{service}/restart?latest=true')
    print('Coolify is pulling the image and restarting the relay.')

    deadline = time.monotonic() + WAIT_SECONDS
    seen = None
    while time.monotonic() < deadline:
        seen = running_version(relay)
        if seen == version:
            print(f'{relay} runs relay {version}.')
            return 0
        time.sleep(POLL_SECONDS)
    sys.exit(f'{relay} still says {seen or "no version"} after {WAIT_SECONDS // 60} minutes, not {version}')


if __name__ == '__main__':
    sys.exit(main())
