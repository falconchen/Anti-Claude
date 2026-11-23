/** Enumerate registered fonts from the macOS current-user font directory. */
import { execFile } from 'node:child_process';

// CoreText reads descriptors from each file, including collections. AppKit resolves
// their registered family names; filenames are not reliable CSS family names.
const FONT_SCRIPT = `
ObjC.import('AppKit');
ObjC.import('CoreText');
ObjC.bindFunction('CTFontManagerCreateFontDescriptorsFromURL', ['id', ['id']]);
const root = ObjC.unwrap($.NSHomeDirectory()) + '/Library/Fonts';
const files = ObjC.deepUnwrap($.NSFileManager.defaultManager.subpathsAtPath(root)) || [];
const families = new Set();
for (const file of files) {
  if (!/\\.(ttf|otf|ttc|otc|dfont)$/i.test(file)) continue;
  try {
    const descriptors = $.CTFontManagerCreateFontDescriptorsFromURL($.NSURL.fileURLWithPath(root + '/' + file));
    for (let i = 0; i < descriptors.count; i++) {
      const font = $.NSFont.fontWithDescriptorSize(descriptors.objectAtIndex(i), 14);
      const family = ObjC.unwrap(font.familyName);
      if (family) families.add(family);
    }
  } catch (_) { /* Ignore unreadable or unsupported individual font files. */ }
}
JSON.stringify([...families].sort((a, b) => a.localeCompare(b)));
`;

export function validUserFontName(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 &&
    value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}

let cached = null;
let pending = null;
export async function listUserFonts({ refresh = false } = {}) {
  if (process.platform !== 'darwin') return { ok: false, error: 'macos_only', families: [] };
  if (!refresh && cached && Date.now() - cached.at < 30000) return cached.result;
  if (pending) return pending;
  pending = new Promise(resolve => {
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', FONT_SCRIPT],
      { timeout: 15000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
        if (error) return resolve({ ok: false, error: 'font_scan_failed', families: [] });
        try {
          const raw = JSON.parse(stdout.trim());
          if (!Array.isArray(raw)) throw new Error('invalid font list');
          const families = [...new Set(raw.filter(validUserFontName))];
          const result = { ok: true, families };
          cached = { at: Date.now(), result };
          resolve(result);
        } catch {
          resolve({ ok: false, error: 'font_scan_failed', families: [] });
        }
      });
  });
  try { return await pending; } finally { pending = null; }
}
