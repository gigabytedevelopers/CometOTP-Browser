# CometOTP browser extension: privacy policy

Last updated: 24 October 2026

This policy covers the CometOTP browser extension and the relay it syncs through. Gigabyte
Developers makes both, and runs the official relay at `relay.gigabytedevelopers.com`. The CometOTP
app on your phone has its own privacy policy, which covers what the app keeps.

In short: your codes' secrets are encrypted on your phone with a key that only your phone and your
browser have. The relay passes the encrypted copy along and cannot read it. The extension has no
accounts and no ads, and nothing it handles is sold or shared. It sends usage statistics only if
you turn them on in its settings, and they never include your codes, your services or the sites
you use.

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
- **Usage statistics, only if you turned them on:** the random ID made for them. While the browser
  runs, it also holds in memory when the current visit began.

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

## Usage statistics (only if you turn them on)

Usage statistics are off unless you turn them on, under **Usage statistics** in the extension's
settings. In Firefox, its own setting for technical and interaction data must be on too; Firefox
asks you if it is not. They help us see how many people use the extension and which parts, to
decide what to work on.

When they are on, the extension sends Google Analytics a short message each time you:

- open its popup,
- copy a code, or fill one into a site,
- pair this browser with your phone, or disconnect it.

Each message holds only what happened, the extension's version, whether your browser is Firefox
or Chrome-like, a random ID made when you turned the statistics on, and a number for the current
visit. They never include your codes or their secrets, your services' names, your phone's name,
your password, the relay you use, the sites you visit or fill codes into, or anything from web
pages.

- **Who receives them:** Google, which runs Google Analytics for us as our processor under the
  Google Ads Data Processing Terms. The messages go to Google's endpoint that collects in the
  European Union, `region1.google-analytics.com`; Google may process them elsewhere, including in
  the United States, under those terms.
- **Your IP address:** like any server, Google sees the address the message comes from. Google
  says that Google Analytics does not log or store IP addresses. We turned off collecting your
  city and details about your device.
- **No ads:** every message marks consent for advertising as denied. We turned off ads
  personalization and Google signals, and link Google Analytics to no advertising account.
- **How long:** Google Analytics deletes what is tied to the random ID after 2 months. Totals
  that cannot be traced to anyone, such as how many people used the extension in a week, are kept.
- **Withdrawing:** turn usage statistics off in the extension's settings. The extension stops
  sending at once and deletes the random ID. Nothing we hold links that ID to you, so we cannot
  find your statistics to delete them sooner; they are deleted after 2 months.

If you are in the European Economic Area, the United Kingdom or Switzerland, we rely on your
consent, which you give by turning usage statistics on and can withdraw at any time as above.

## Passkeys

If you unlock with a passkey, your browser and your authenticator (such as Touch ID, Windows Hello,
your phone or a security key) work out a key for the extension on your device. Nothing about it is
sent anywhere.

## Removing your data

- **Turning usage statistics off** stops them and deletes their random ID from your browser.
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
