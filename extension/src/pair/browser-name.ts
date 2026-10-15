// How the phone will show this browser, such as "Chrome on macOS" (protocol §3.1, at most 64 bytes).
// It can be renamed on the phone.

interface UserAgentData {
  brands?: { brand: string }[];
  platform?: string;
}

const BRANDS: [RegExp, string][] = [
  [/edge/i, 'Edge'],
  [/opera/i, 'Opera'],
  [/brave/i, 'Brave'],
  [/vivaldi/i, 'Vivaldi'],
  [/google chrome/i, 'Chrome'],
];

function platformName(text: string): string | null {
  if (/mac/i.test(text)) return 'macOS';
  if (/win/i.test(text)) return 'Windows';
  if (/cros|chrome ?os/i.test(text)) return 'ChromeOS';
  if (/android/i.test(text)) return 'Android';
  if (/linux/i.test(text)) return 'Linux';
  return null;
}

export function browserName(userAgent: string, data?: UserAgentData): string {
  let browser: string;
  if (/firefox/i.test(userAgent)) browser = 'Firefox';
  else {
    const brands = (data?.brands ?? []).map((b) => b.brand).join(' ');
    browser = BRANDS.find(([pattern]) => pattern.test(brands) || pattern.test(userAgent))?.[1] ?? 'Chrome';
  }
  const platform = platformName(data?.platform || '') ?? platformName(userAgent);
  return platform ? `${browser} on ${platform}` : browser;
}

export function thisBrowser(): string {
  return browserName(navigator.userAgent, (navigator as { userAgentData?: UserAgentData }).userAgentData);
}
