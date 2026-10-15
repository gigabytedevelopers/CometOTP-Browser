# CometOTP browser extension: privacy policy

Last updated: 15 October 2026

This policy covers the CometOTP browser extension and the relay it syncs through. Gigabyte
Developers makes both, and runs the official relay at `relay.gigabytedevelopers.com`. The CometOTP
app on your phone has its own privacy policy, which covers what the app keeps.

In short: your codes' secrets are encrypted on your phone with a key that only your phone and your
browser have. The relay passes the encrypted copy along and cannot read it. The extension has no
accounts, no analytics, no ads and no tracking, and nothing it handles is sold or shared.

## What the extension keeps on your computer

In the browser's storage for the extension:

- **Its lock:** a random local key, sealed with a key derived from your extension password (and,
  if you add one, a second copy sealed with your passkey). Neither your password nor the local key
  is stored in a readable form.
- **The pairing with your phone:** the relay's address, the vault's random id, the token that lets
  this browser download the vault, and the highest version of it accepted. The vault's key and
  your phone's name are sealed under the local key.
- **The copy of your services,** as downloaded: encrypted with the vault's key. For each service
  your phone shares, it holds the secret, issuer, label, code settings, icon name, initials, badge
  colour and tags. Never usage counts or when a code was last used.
- **The sites you filled codes on,** sealed under the local key, so the menu offers the right
  service first.
- **Settings:** how soon the extension locks, the name your phone shows for this browser, the relay
  chosen for pairing, and when it last checked for a new copy.

While the extension is unlocked, the local key is held in memory only. Locking, the computer
locking, a time without use, or quitting the browser removes it.

## What goes to the relay

- **Pairing:** your browser and your phone exchange a few messages through a short-lived pairing
  channel on the relay. They are encrypted between the two devices, and the relay cannot read them.
- **Keeping the copy current:** the extension downloads the encrypted vault with its token when the
  browser starts, when you open its popup, and every 15 minutes. It says which version it has, so
  an unchanged vault is not sent again. It uses the time in the relay's answer to warn you if your
  computer's clock is off.
- **Disconnect** deletes the vault on the relay.

Like any server, the relay sees the IP address a request comes from and when it arrives.

## What the relay keeps

For each paired browser: the vault's random id, hashes of the two tokens (one for the phone, one
for the browser), the vault's version number, the encrypted vault (padded, so its size says little
about how many services it holds), when it was created, and the day it was last downloaded.

- Pairing channels and their encrypted messages last a few minutes and are then forgotten.
- A vault never downloaded within 7 days of being made, or not downloaded for 180 days, is deleted.
- After a vault is deleted, a hash of its id is kept for 180 days, so the relay can tell your phone
  or browser that it is gone.

The relay keeps no IP addresses. To limit how often a client can call it, it counts requests in
memory for up to an hour, keyed by a hash of the address under a key that changes each time the
relay starts. The official relay keeps no access logs.

The relay cannot read your services: the vault's key never leaves your phone and your browser. You
can also run your own relay ([running your own](self-hosting.md)); then that relay is yours, and
nothing reaches ours.

## Web pages

Only if you turn on **Fill codes into sites** in the extension's settings does it ask your browser
for access to sites. It then runs a script on https sites that looks for one-time-code fields, to
put a CometOTP button in them. It reads nothing else from pages and sends nothing from them
anywhere. The list of services opens in a part of the page the site cannot read. A site receives
only the code you choose to fill into it, as if you had typed it. Turning filling off takes the
access back.

## Passkeys

If you unlock with a passkey, your browser and your authenticator (such as Touch ID, Windows Hello,
your phone or a security key) work out a key for the extension on your device. Nothing about it is
sent anywhere.

## Removing your data

- **Disconnect** in the extension's settings deletes the vault on the relay and everything the
  pairing kept in the browser.
- **Remove** in CometOTP on your phone deletes the vault on the relay; the extension then deletes
  its copy when it next checks.
- Removing the extension from your browser deletes everything it kept there. Its vault stays on
  the relay until your phone removes this browser, or until it has not been downloaded for 180
  days.
- **Reset the extension** (from "Forgot your password?") deletes everything it kept, password
  included.

## Changes

Changes to this policy are made in this file, whose history shows each one.

## Contact

support@gigabytedevelopers.com
