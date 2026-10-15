// The content script, loaded by fill/content.js on the sites the person allowed. When a
// one-time-code field is focused, it puts a small CometOTP button at its end. The button opens a
// menu: an extension page in a frame, which lists the services. The page sees neither them nor any
// secret, only the code filled into the field the person chose. What this adds to the page sits
// in a closed shadow root and is styled through the CSS object model, which page styles and
// content security policies leave alone.
import { isCodeField, isCodeGroup, type FieldInfo } from './detect.js';
import { isFillClose, isFillCode, isFillOpened, isFillSize, type FillHere, type FillOpen } from './messages.js';

const MENU_PAGE = chrome.runtime.getURL('fill/menu.html');
const MENU_WIDTH = 300;
const BUTTON = 24;
const GAP = 4;

/** The brand mark, as in CometOTP (ic_logo_mark). */
const LOGO =
  'M29.17,0.04C31.76,-0.21 33.83,-0.12 36.04,0C38.26,0.12 39.76,0.25 42.46,0.75C45.15,1.25 49.11,2.12 52.21,3C55.31,3.88 58.32,4.96 61.04,6C63.76,7.04 66.14,8.08 68.54,9.25C70.94,10.42 73.17,11.6 75.46,13C77.75,14.4 80.26,16.12 82.29,17.67C84.32,19.21 86.01,20.67 87.62,22.25C89.24,23.83 90.74,25.53 92,27.12C93.26,28.72 94.17,30.01 95.17,31.79C96.17,33.57 97.28,35.85 98,37.79C98.72,39.74 99.17,41.93 99.5,43.46C99.83,44.99 100,45.17 100,46.96C100,48.75 99.89,52.24 99.5,54.21C99.11,56.18 98.33,57.51 97.67,58.79C97,60.07 96.58,60.76 95.5,61.88C94.42,62.99 92.88,64.56 91.21,65.5C89.53,66.44 87.53,67.25 85.46,67.5C83.39,67.75 80.81,67.46 78.79,67C76.78,66.54 75.53,66.17 73.38,64.75C71.22,63.33 69.37,62.44 65.83,58.46C62.3,54.48 55.58,45.02 52.17,40.88C48.76,36.73 47.73,35.6 45.38,33.58C43.02,31.56 40.29,29.83 38.04,28.75C35.79,27.67 33.86,27.28 31.88,27.08C29.89,26.89 27.86,27.14 26.12,27.58C24.39,28.03 23.01,28.62 21.46,29.75C19.91,30.88 17.99,32.74 16.83,34.38C15.67,36.01 14.93,37.61 14.5,39.54C14.07,41.47 13.99,43.9 14.25,45.96C14.51,48.01 15.24,50.22 16.08,51.88C16.92,53.53 17.86,54.67 19.29,55.92C20.72,57.17 24.37,58.9 24.67,59.38C24.96,59.85 22.4,59.15 21.04,58.75C19.69,58.35 18.47,58.12 16.54,57C14.61,55.88 11.22,53.49 9.46,52C7.7,50.51 6.95,49.3 6,48.04C5.05,46.78 4.62,46.39 3.75,44.46C2.88,42.53 1.38,38.54 0.75,36.46C0.12,34.37 0.12,33.49 0,31.96C-0.12,30.43 -0.31,29.29 0,27.29C0.31,25.29 0.78,22.62 1.83,19.96C2.89,17.29 4.65,13.7 6.33,11.29C8.02,8.88 10.3,6.88 11.96,5.5C13.62,4.12 14.87,3.67 16.29,3C17.71,2.33 18.31,1.99 20.46,1.5C22.6,1.01 26.57,0.29 29.17,0.04Z';

/** The inputs a code goes into: one, or one per character. */
type Target = HTMLInputElement[];

/** Sets styles, each important, so page styles cannot override them. */
function style(element: HTMLElement | SVGElement, styles: Record<string, string>): void {
  for (const [property, value] of Object.entries(styles)) element.style.setProperty(property, value, 'important');
}

function describe(input: HTMLInputElement): FieldInfo {
  const named = (input.getAttribute('aria-labelledby') ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => input.ownerDocument.getElementById(id)?.textContent ?? '');
  const labels = [...(input.labels ?? [])].map((label) => label.textContent ?? '');
  return {
    type: input.type,
    autocomplete: (input.getAttribute('autocomplete') ?? '').toLowerCase(),
    name: input.name,
    id: input.id,
    placeholder: input.placeholder,
    label: [input.getAttribute('aria-label') ?? '', input.title, ...labels, ...named].join(' ').slice(0, 500),
    maxLength: input.maxLength,
    inputMode: input.inputMode.toLowerCase(),
    pattern: input.pattern,
  };
}

function shown(input: HTMLInputElement): boolean {
  return input.type !== 'hidden' && !input.disabled && !input.readOnly && input.getClientRects().length > 0;
}

/** The code field `input` belongs to, if it is one. */
function targetOf(input: HTMLInputElement): Target | null {
  if (!shown(input)) return null;
  if (input.maxLength !== 1) return isCodeField(describe(input)) ? [input] : null;
  // A box per character: the closest container with five or more inputs must hold only such boxes.
  let container = input.parentElement;
  for (let depth = 0; container && depth < 4; depth++, container = container.parentElement) {
    const inputs = [...container.querySelectorAll('input')].filter(shown);
    if (inputs.length < 5) continue;
    return inputs.every((box) => box.maxLength === 1) && isCodeGroup(inputs.map(describe)) ? inputs : null;
  }
  return null;
}

// What this adds to the page: a host element, and in its closed shadow root the button and the menu.
const host = document.createElement('cometotp-fill');
style(host, { all: 'initial', position: 'fixed', top: '0', left: '0', width: '0', height: '0', 'z-index': '2147483647' });
const root = host.attachShadow({ mode: 'closed' });

const button = document.createElement('button');
button.type = 'button';
button.title = 'Fill a code with CometOTP';
button.setAttribute('aria-label', 'Fill a code with CometOTP');
style(button, {
  all: 'initial',
  position: 'absolute',
  width: `${BUTTON}px`,
  height: `${BUTTON}px`,
  'box-sizing': 'border-box',
  padding: '5px 4px',
  display: 'grid',
  'place-items': 'center',
  'border-radius': '6px',
  background: '#29339b',
  color: '#ffffff',
  cursor: 'pointer',
  'box-shadow': '0 1px 3px rgba(0, 0, 0, 0.3)',
});
const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
svg.setAttribute('viewBox', '0 0 100 67.5');
svg.setAttribute('aria-hidden', 'true');
style(svg, { width: '100%', height: 'auto', display: 'block' });
const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
path.setAttribute('d', LOGO);
path.setAttribute('fill', 'currentColor');
path.setAttribute('fill-rule', 'evenodd');
svg.append(path);
button.append(svg);
root.append(button);

/** The focused code field, while the button shows. */
let current: Target | null = null;
/** The open menu, if any: its frame, its name and the field it fills. */
let menu: { frame: HTMLIFrameElement; name: string | null; target: Target; height: number } | null = null;
/** Whether this frame may show the button; asked once, and only in frames. */
let allowed: Promise<boolean> | null = window === window.top ? Promise.resolve(true) : null;

function mayShow(): Promise<boolean> {
  allowed ??= chrome.runtime.sendMessage({ type: 'fill-here' } satisfies FillHere).then((answer) => answer === true, () => false);
  return allowed;
}

let placing = 0;

/** Moves the button and the menu to the field, after the next frame. */
function place(): void {
  if (placing) return;
  placing = requestAnimationFrame(() => {
    placing = 0;
    const target = menu?.target ?? current;
    const field = target?.[target.length - 1];
    if (!target || !field?.isConnected) return hide();
    const rect = field.getBoundingClientRect();
    const inside = rect.width >= 80;
    const left = inside ? rect.right - BUTTON - 6 : rect.right + GAP;
    style(button, { left: `${left}px`, top: `${rect.top + (rect.height - BUTTON) / 2}px` });
    if (menu) {
      const first = target[0]!.getBoundingClientRect();
      const below = window.innerHeight - rect.bottom - GAP;
      const top = below >= menu.height || below >= rect.top ? rect.bottom + GAP : Math.max(GAP, rect.top - GAP - menu.height);
      const x = Math.min(Math.max(GAP, Math.max(first.left, rect.right - MENU_WIDTH)), window.innerWidth - MENU_WIDTH - GAP);
      style(menu.frame, { left: `${x}px`, top: `${top}px`, height: `${menu.height}px` });
    }
  });
}

function show(target: Target): void {
  current = target;
  if (!host.isConnected) document.documentElement.append(host);
  place();
}

function hide(): void {
  closeMenu(false);
  current = null;
  host.remove();
}

function closeMenu(refocus: boolean): void {
  if (!menu) return;
  const { frame, target } = menu;
  menu = null;
  frame.remove();
  if (refocus) target[0]?.focus();
}

async function openMenu(): Promise<void> {
  if (!current || menu) return;
  const frame = document.createElement('iframe');
  frame.title = 'CometOTP';
  style(frame, {
    all: 'initial',
    position: 'absolute',
    width: `${MENU_WIDTH}px`,
    height: '0',
    border: '0',
    'border-radius': '8px',
    'box-shadow': '0 4px 16px rgba(0, 0, 0, 0.25)',
    'color-scheme': 'normal',
  });
  menu = { frame, name: null, target: current, height: 120 };
  const opened = menu;
  const answer = await chrome.runtime.sendMessage({ type: 'fill-open' } satisfies FillOpen).catch(() => null);
  if (menu !== opened || !isFillOpened(answer) || !answer.menu) {
    if (menu === opened) menu = null;
    return;
  }
  opened.name = answer.menu;
  frame.src = `${MENU_PAGE}#${answer.menu}`;
  root.append(frame);
  place();
}

/** Types the code into the field, one character per box if it has boxes, as a person would. */
function fill(target: Target, code: string): void {
  const parts = target.length === 1 ? [code] : [...code];
  target.forEach((input, index) => {
    const value = parts[index] ?? '';
    input.focus();
    input.value = value;
    input.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: value }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

// The button keeps the field focused, and opens the menu only for a person's click.
button.addEventListener('pointerdown', (event) => event.preventDefault());
button.addEventListener('click', (event) => {
  if (!event.isTrusted) return;
  if (menu) closeMenu(true);
  else void openMenu();
});

/** Shows the button for a focused code field, and hides it when focus moves elsewhere. */
function focused(element: EventTarget | undefined): void {
  if (!(element instanceof HTMLInputElement)) {
    if (!menu) hide();
    return;
  }
  const target = targetOf(element);
  if (!target) {
    if (!menu?.target.includes(element)) hide();
    return;
  }
  if (current?.[0] === target[0]) return;
  closeMenu(false);
  void mayShow().then((yes) => {
    if (yes && element.matches(':focus')) show(target);
  });
}

document.addEventListener(
  'focusin',
  (event) => {
    const path = event.composedPath();
    if (!path.includes(host)) focused(path[0]);
  },
  true,
);

document.addEventListener(
  'focusout',
  (event) => {
    // Focus leaving for nothing (a click on the page) hides the button, unless the menu is open.
    if (event.relatedTarget === null && !menu && current?.includes(event.composedPath()[0] as HTMLInputElement)) {
      setTimeout(() => {
        if (!menu && !(document.activeElement instanceof HTMLInputElement && current?.includes(document.activeElement))) hide();
      }, 0);
    }
  },
  true,
);

document.addEventListener(
  'pointerdown',
  (event) => {
    if (menu && !event.composedPath().includes(host)) closeMenu(false);
  },
  true,
);

document.addEventListener(
  'keydown',
  (event) => {
    if (menu && event.key === 'Escape') closeMenu(true);
  },
  true,
);

window.addEventListener('scroll', place, { capture: true, passive: true });
window.addEventListener('resize', place, { passive: true });

// The background passes on the menu's size and its closing, and sends its code. Only the extension
// can message a content script; each message must also name the open menu.
chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.id !== chrome.runtime.id) return;
  if (!menu?.name || (message as { menu?: unknown }).menu !== menu.name) return;
  if (isFillSize(message)) {
    menu.height = Math.min(Math.max(Math.ceil(message.height), 60), 420);
    place();
  } else if (isFillCode(message)) {
    const { target } = menu;
    closeMenu(false);
    fill(target, message.code);
  } else if (isFillClose(message)) {
    closeMenu(true);
  }
});

// A field focused before this script ran, as sign-in pages often focus the code field at once.
let active = document.activeElement;
while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
if (active instanceof HTMLInputElement) focused(active);
