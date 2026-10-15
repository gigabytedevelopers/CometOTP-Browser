// How the popup writes services and codes, apart from the page.
import type { Service } from '@cometotp/protocol';

/** A code in two groups, as CometOTP shows it: "123 456", "1234 5678"; Steam's as it is. */
export function groupCode(code: string, type: Service['type'] = 'totp'): string {
  if (type === 'steam' || code.length < 6) return code;
  const half = Math.floor(code.length / 2);
  return `${code.slice(0, half)} ${code.slice(half)}`;
}

/** "Updated just now", "Updated 5 minutes ago", "Updated 3 days ago". */
export function updatedText(updatedSeconds: number, nowMs: number): string {
  const seconds = Math.max(0, Math.floor(nowMs / 1000) - updatedSeconds);
  const units: [number, string][] = [
    [86_400, 'day'],
    [3_600, 'hour'],
    [60, 'minute'],
  ];
  for (const [size, unit] of units) {
    const count = Math.floor(seconds / size);
    if (count >= 1) return `Updated ${count} ${unit}${count === 1 ? '' : 's'} ago`;
  }
  return 'Updated just now';
}

/** The person's own initials, or the first letters of the issuer's (or else the label's) words. */
export function initials(service: Pick<Service, 'initials' | 'issuer' | 'label'>): string {
  if (service.initials) return service.initials;
  const words = (service.issuer || service.label).split(/[\s._@-]+/).filter(Boolean);
  const letters = words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0] ?? '?').slice(0, 2);
  return [...letters].slice(0, 2).join('').toUpperCase() || '?';
}

const BADGES = ['#3949ab', '#00897b', '#6d4c41', '#8e24aa', '#c62828', '#2e7d32', '#ef6c00', '#00838f', '#5e35b1', '#ad1457'];

/** The person's badge colour, or one picked from the service id, the same each time. */
export function badgeColor(service: Pick<Service, 'badge' | 'id'>): string {
  if (service.badge) return service.badge;
  let hash = 0;
  for (const char of service.id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return BADGES[hash % BADGES.length]!;
}

/** Whether a search matches the issuer, label or a tag, ignoring case and accents. */
export function matches(service: Pick<Service, 'issuer' | 'label' | 'tags'>, query: string): boolean {
  const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const wanted = fold(query.trim());
  if (!wanted) return true;
  return [service.issuer, service.label, ...(service.tags ?? [])].some((text) => fold(text).includes(wanted));
}

/** How far the clock is off, in words: "45 seconds", "3 minutes". */
export function skewText(skewMs: number): string {
  const seconds = Math.round(Math.abs(skewMs) / 1000);
  if (seconds < 120) return `${seconds} seconds`;
  return `${Math.round(seconds / 60)} minutes`;
}
