// The content script, which runs only on the sites the person allowed for filling codes. Content
// scripts cannot be modules, so this loads the one that does the work (src/fill/field.ts).
import(chrome.runtime.getURL('fill/field.js'));
