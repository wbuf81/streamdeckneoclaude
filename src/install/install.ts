import {
  readFileSync, writeFileSync, copyFileSync, renameSync, unlinkSync,
  existsSync, chmodSync, mkdirSync, statSync, lstatSync, realpathSync, mkdtempSync, rmSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { paths, enforceDirModes, type Paths } from '../paths.js'

const run = promisify(execFile)

/** Marks a wrapped statusline, so install and uninstall recognise their work. */
export const WRAPPER_MARKER = '# deckd-wrapped'

/**
 * Finds the project root, the directory that holds `package.json`. Two reasons
 * this cannot use the module's own directory or `process.cwd()`:
 *
 *   1. `tsc` compiles `.ts` and does NOT copy `.sh`, so the wrapper script never
 *      appears next to the compiled `install.js`. It only exists in the source
 *      tree at `src/install/statusline-wrapper.sh`.
 *   2. This module sits at `src/install/` under `tsx` and at `dist/src/install/`
 *      after a build, so a fixed number of parent steps is wrong for one of them.
 */
export function projectRoot(): string | null {
  let dir = import.meta.dirname
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * M-12: the message both `install()` and `refreshWrapper()` throw when
 * `projectRoot()` returns `null`. The old wording on both -- "Run install
 * from the repository" / "Run this from the repository" -- blamed the
 * current working directory, which `projectRoot()` never even looks at
 * (deliberately, per lesson 3: `process.cwd()` is wrong under launchd).
 * The real cause is always that no `package.json` sits within six parent
 * directories of THIS MODULE's own location -- normally because the
 * compiled `dist/bin/deckd.js` this ships as ended up nested deeper below
 * the repository root than that walk expects.
 */
const PROJECT_ROOT_NOT_FOUND_MESSAGE =
  'cannot find the project root: no package.json was found within 6 parent directories of ' +
  "this module. This does not depend on the current working directory -- it looks for " +
  'package.json starting from where this file itself is on disk. This usually means the ' +
  'compiled entry point is nested deeper below the repository root than expected. Run from a ' +
  'normal checkout of the repository, or reinstall it.'

/** Escapes the five XML special characters. `nodePath`, `scriptPath`, and
 * `logPath` all come from filesystem paths, which can legally contain `&`,
 * `<`, `>`, `'`, or `"` (a username with an ampersand is not exotic). An
 * unescaped one would produce a malformed plist that launchd may refuse to
 * load, or that reads back with a corrupted path. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export function buildPlist(
  label: string,
  nodePath: string,
  scriptPath: string,
  logPath: string,
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodePath)}</string>
    <string>${escapeXml(scriptPath)}</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logPath)}</string>
</dict>
</plist>
`
}

interface WrapResult {
  statusLine: unknown
  inner: string
}

/**
 * Builds a statusline command that runs the wrapper first. The original command
 * travels inside the new one, after the marker, so uninstall needs no other
 * record. Losing the state directory therefore cannot strand a wrapped config.
 *
 * The command relies on three shell behaviours: a `VAR=value` assignment prefix,
 * `#` starting a comment so the trailing JSON is inert, and tilde expansion
 * inside the inner command. Claude Code does run the statusline through a shell,
 * and there is direct evidence rather than an assumption: this user's existing
 * value is `~/.claude/statusline.sh`, whose leading tilde only resolves under a
 * shell. A direct exec would fail with ENOENT.
 *
 * `stateDir` is embedded as a `DECKD_STATE_DIR=` assignment alongside
 * `DECKD_INNER`. Without it, the wrapper falls back to `$HOME/.local/state/deckd`
 * at render time, independent of whatever directory install actually used --
 * survivable when they happen to be the same path, but fragile in general, and
 * the exact gap a temporary probe state directory (see `install`) would fall
 * into if this were omitted. Embedding it here means the installed wrapper
 * always caches to the directory this install actually used, regardless of the
 * render-time environment under launchd.
 *
 * `verifyWrap` still proves the wrap end to end before `install` trusts it.
 *
 * M-2: encodes `{ original: current }`, NOT `{ original: current ?? null }`.
 * `JSON.stringify` drops a property whose value is `undefined` entirely, so
 * "statusLine was absent" now encodes as `{}` (no `original` key at all),
 * while "statusLine was explicitly `null`" encodes as `{"original":null}` --
 * two different, round-trippable shapes. The old `?? null` collapsed both
 * into the exact same encoded value, so a legitimately `null` statusLine
 * and an absent one became indistinguishable the moment they were wrapped,
 * and `uninstall` would delete the key `null` should have kept. The decode
 * side (`tryUnwrapStatusLine`/`tryUnwrapWrapped` below) checks for the
 * key's PRESENCE, not its value, to tell the two apart on the way back out.
 */
export function wrapStatusLine(current: unknown, wrapperPath: string, stateDir: string): WrapResult {
  const inner = extractCommand(current)
  const encoded = JSON.stringify({ original: current })
  const command =
    `DECKD_STATE_DIR=${shellQuote(stateDir)} DECKD_INNER=${shellQuote(inner)} ` +
    `${shellQuote(wrapperPath)} ${WRAPPER_MARKER} ${encoded}`

  // M-3: excludes an array. `{...current, command}` on an array produces an
  // object with numeric string keys (`{"0":"a","1":"b","command":"..."}"`),
  // not a shape Claude Code's settings schema recognises as a command
  // object -- an artifact of `typeof [] === 'object'` being true, not a
  // deliberate shape. Falling through to the plain command-string branch
  // below, exactly like every other non-object value, avoids writing that
  // artifact into settings.json at all.
  if (current && typeof current === 'object' && !Array.isArray(current)) {
    return { statusLine: { ...(current as object), command }, inner }
  }
  return { statusLine: command, inner }
}

interface UnwrapAttempt {
  /** False only when the marker is present but the trailing JSON blob will
   * not parse -- e.g. the command was hand-edited. True covers both "no
   * marker" and "marker, and the embedded original was legitimately empty",
   * which `unwrapStatusLine` cannot tell apart on its own, so callers that
   * need to distinguish "recovered nothing" from "recovery failed" use this
   * instead. */
  ok: boolean
  value: unknown
}

/**
 * M-2: decodes the embedded `{ original: ... }` blob, treating the
 * `original` key's PRESENCE, not its value, as what distinguishes "the
 * wrapped statusLine was absent" (no key at all, since `wrapStatusLine`
 * no longer encodes `undefined` as `null`) from "the wrapped statusLine
 * was explicitly `null`" (the key is present, with value `null`). The old
 * `parsed.original ?? undefined` treated both the same way, so a
 * legitimately `null` original came back as `undefined` and got DELETED
 * from settings.json on uninstall instead of restored as `null`.
 */
function decodeOriginal(parsed: { original?: unknown }): unknown {
  return 'original' in parsed ? parsed.original : undefined
}

function tryUnwrapStatusLine(current: unknown): UnwrapAttempt {
  const command = extractCommand(current)
  const at = command.indexOf(WRAPPER_MARKER)
  if (at === -1) return { ok: true, value: current }
  try {
    const blob = command.slice(at + WRAPPER_MARKER.length).trim()
    const parsed = JSON.parse(blob) as { original?: unknown }
    return { ok: true, value: decodeOriginal(parsed) }
  } catch {
    return { ok: false, value: undefined }
  }
}

/** Recovers the original statusline from a wrapped one. */
export function unwrapStatusLine(current: unknown): unknown {
  return tryUnwrapStatusLine(current).value
}

/**
 * The unwrap attempt `recoverStatusLine` actually uses -- unlike
 * `tryUnwrapStatusLine` above, this takes `wrapperPath` and treats an
 * absent marker as a FAILURE whenever the command still invokes the
 * wrapper, rather than as proof there was never a wrap.
 *
 * That distinction is C-1's fix. `tryUnwrapStatusLine`'s "no marker found"
 * branch was written for a caller that had already gated on the SAME
 * marker to decide "is this wrapped" in the first place -- so by the time
 * it ran, "no marker" and "not wrapped" were the same fact. Once
 * `isInstalled` stopped depending on the marker (see above), that
 * assumption broke: a command can now be known-wrapped (it invokes
 * `wrapperPath`) while ALSO lacking a marker (someone trimmed it). Handing
 * back `current` unchanged in that case would tell the caller "this is
 * already the original" -- while `current` still runs the wrapper. That is
 * the exact stranding C-1 found, just one level down. Losing the marker
 * must fail closed here, so the caller (`recoverStatusLine`) falls back to
 * the pre-install backup instead of trusting a command that still points
 * at the wrapper.
 */
function tryUnwrapWrapped(current: unknown, wrapperPath: string): UnwrapAttempt {
  const command = extractCommand(current)
  if (!command.includes(wrapperPath)) return { ok: true, value: current }
  const at = command.indexOf(WRAPPER_MARKER)
  if (at === -1) return { ok: false, value: undefined }
  try {
    const blob = command.slice(at + WRAPPER_MARKER.length).trim()
    const parsed = JSON.parse(blob) as { original?: unknown }
    return { ok: true, value: decodeOriginal(parsed) }
  } catch {
    return { ok: false, value: undefined }
  }
}

export interface RecoverResult {
  /** The value to assign to `statusLine`, or `undefined` to leave it absent. */
  statusLine: unknown
  source: 'embedded' | 'backup' | 'none'
  /** Set only when the embedded copy failed, so the caller can report it. */
  warning?: string
}

/**
 * Recovers the statusLine value that `uninstall` should restore.
 *
 * The embedded copy inside the wrapped command is the normal path: it is
 * self-contained, and almost every uninstall uses it with no other file
 * involved. It can fail only if the wrapped command was hand-edited so the
 * trailing JSON blob no longer parses. In that case the pre-install backup at
 * `backupPath` is a safe fallback, because `install` wrote it before it ever
 * touched `statusLine`.
 *
 * If even the backup is missing or unreadable, this function does NOT invent
 * a value and does NOT signal "just delete it" by returning `undefined`
 * quietly -- it returns `source: 'none'` with a warning, so the caller can
 * tell the user plainly that their original statusline could not be found,
 * rather than silently discarding it.
 *
 * `wrapperPath` is required so the embedded attempt below (`tryUnwrapWrapped`)
 * can tell "never wrapped" from "wrapped, but the marker was trimmed" (C-1)
 * -- the two cases `tryUnwrapStatusLine` alone cannot distinguish, and
 * conflating them is exactly how the marker-trimmed case used to strand a
 * live reference to a wrapper this function had already decided to hand
 * back as "the original".
 */
export function recoverStatusLine(current: unknown, backupPath: string, wrapperPath: string): RecoverResult {
  const attempt = tryUnwrapWrapped(current, wrapperPath)
  if (attempt.ok) return { statusLine: attempt.value, source: 'embedded' }

  try {
    const backup = JSON.parse(readFileSync(backupPath, 'utf8')) as Record<string, unknown>
    return {
      statusLine: backup.statusLine,
      source: 'backup',
      warning:
        'the embedded original statusLine command was unreadable, so deckd restored ' +
        `it from the backup at ${backupPath}.`,
    }
  } catch {
    return {
      statusLine: undefined,
      source: 'none',
      warning:
        'the embedded original statusLine command was unreadable, and no usable backup ' +
        `was found at ${backupPath}. statusLine is left absent. Claude Code will use its default.`,
    }
  }
}

/** The fixed basename every copy of the wrapper script shares, regardless of
 * which state directory it was installed into. Used only by `looksWrapped`
 * below to spot an AMBIGUOUS wrap -- one that does not match `wrapperPath`
 * exactly, e.g. because `DECKD_STATE_DIR` changed between installs -- never
 * as the install/uninstall decision itself. */
const WRAPPER_BASENAME = 'statusline-wrapper.sh'

/**
 * True when a command looks like it invokes SOME deckd wrapper -- by the
 * fixed basename every copy shares, or by the marker -- even if it does not
 * match a specific `wrapperPath` exactly. Used only by `detectWrap` below,
 * to tell "definitely not wrapped" from "wrapped by something, but we
 * cannot tell what" -- never on its own as an install/uninstall/delete
 * decision.
 */
function looksWrapped(commandStr: string): boolean {
  return commandStr.includes(WRAPPER_BASENAME) || commandStr.includes(WRAPPER_MARKER)
}

/** What `detectWrap` decided about a settings object, relative to one
 * specific `wrapperPath`. */
export type WrapKind =
  | 'none' // statusLine does not invoke any deckd wrapper at all.
  | 'this' // statusLine invokes exactly wrapperPath.
  | 'ambiguous' // statusLine invokes SOME deckd wrapper, but not wrapperPath.

export interface WrapDetection {
  kind: WrapKind
  /** The raw statusLine command string this decision was made from (`''`
   * when statusLine is absent or not a recognised shape). M-14: exists so
   * a caller refusing an `'ambiguous'` wrap can name what the CURRENTLY
   * installed wrap actually invokes, not just the path this invocation
   * expected -- turning a three-step diagnosis (read settings.json by
   * hand, find statusLine, find the wrapper path inside it) into a
   * one-step one. This is not a secret: it is a path deckd itself wrote. */
  command: string
}

/**
 * THE one function that answers "is this settings file wrapped, and by
 * which wrapper path" -- install, uninstall, and refreshWrapper all call
 * this and only this to decide.
 *
 * Round 3's C-1 defect happened because that question got answered
 * independently at separate call sites: `install` reasoned about an
 * ambiguous wrap with `looksWrapped` (below) at one line, while `uninstall`
 * reasoned about "is it installed" with only the exact-path check at
 * another line, and never asked the ambiguous question at all. A wrap
 * pointing at a DIFFERENT state directory -- e.g. because `DECKD_STATE_DIR`
 * changed between an install and a later uninstall -- satisfied neither
 * check `uninstall` had: not "installed" (wrong path), and never even
 * tested for "ambiguous". So `uninstall` fell to its "never wrapped at
 * all" branch and deleted the backup, on a settings file that was, in
 * fact, still wrapped -- just by a wrapper this invocation did not resolve.
 * Two call sites reasoning independently about the same fact diverge; one
 * function every caller shares cannot.
 *
 * `kind`:
 *   - `'none'`       -- statusLine does not invoke any deckd wrapper.
 *   - `'this'`       -- statusLine invokes exactly `wrapperPath`. Safe to
 *     act on: unwrap, re-verify, or refuse a double-install.
 *   - `'ambiguous'`  -- statusLine invokes SOME deckd wrapper (by the fixed
 *     basename every copy shares, or by the marker) but not `wrapperPath`.
 *     Every caller must refuse and explain here, changing nothing --
 *     guessing which wrap is "the" wrap is exactly the failure mode C-1
 *     produces, whichever direction it is guessed in.
 */
export function detectWrap(settings: unknown, wrapperPath: string): WrapDetection {
  if (!settings || typeof settings !== 'object') return { kind: 'none', command: '' }
  const sl = (settings as Record<string, unknown>).statusLine
  if (sl === undefined) return { kind: 'none', command: '' }
  const command = extractCommand(sl)
  if (command.includes(wrapperPath)) return { kind: 'this', command }
  if (looksWrapped(command)) return { kind: 'ambiguous', command }
  return { kind: 'none', command }
}

/**
 * Thin, exact-path convenience wrapper over `detectWrap`, kept because
 * `wrapperPath === true/false` reads more directly at most call sites (and
 * throughout the tests) than matching on `.kind`. Never reimplements the
 * decision itself -- `detectWrap` is the only place that logic lives.
 */
export function isInstalled(settings: unknown, wrapperPath: string): boolean {
  return detectWrap(settings, wrapperPath).kind === 'this'
}

/** M-14: pulls the wrapper path the AMBIGUOUS command actually invokes out
 * of it, so the refusal message can name it directly instead of sending
 * the user to go read settings.json by hand. The command embeds the path
 * single-quoted (`shellQuote`), so that is what this looks for; if the
 * shape does not match (a hand edit, an unexpected quoting), this falls
 * back to a short, bounded slice of the raw command rather than nothing at
 * all -- still enough to recognise, never enough to be a paragraph. */
function extractWrapperHint(command: string): string {
  const m = /'([^']*statusline-wrapper\.sh)'/.exec(command)
  if (m?.[1] !== undefined) return m[1]
  return command.length > 120 ? `${command.slice(0, 120)}…` : command
}

/** M-1: the exact phrase `readSettingsForInstall`'s own parse-error message
 * already uses. `install` and `refreshWrapper` both run `enforceDirModes`
 * (and install's stray-probe repair) BEFORE they ever reach a refusal
 * decided here, so "nothing was changed" is not quite true for them --
 * measured: a refused `refresh-wrapper` left a freshly created `art/` and
 * `sessions/` at 0700 behind. Sharing this one phrase means every caller
 * that needs it says the same honest thing, rather than each inventing its
 * own wording that could quietly drift out of sync with what actually ran. */
const STATE_DIR_SETUP_CAVEAT =
  " Deckd's own state directory setup, if any was needed, already ran and is safe to keep."

/** The message every caller uses to refuse an ambiguous wrap. One wording,
 * so install, uninstall, and refreshWrapper cannot drift apart on what
 * they tell the user about the exact same situation.
 *
 * `currentCommand` is the ambiguous statusLine's own command string
 * (`WrapDetection.command`), used only to name the wrapper it actually
 * invokes (M-14). `dirSetupMayHaveRun` is true only for a caller whose OWN
 * side effects (directory creation/mode enforcement) already ran before it
 * reached this decision (M-1) -- `uninstall` never runs any of that, so its
 * call site leaves this `false` and the base sentence stays literally true.
 */
function ambiguousWrapMessage(wrapperPath: string, currentCommand: string, dirSetupMayHaveRun = false): string {
  const hint = extractWrapperHint(currentCommand)
  return (
    'statusLine already looks like a deckd wrap, but not the one at ' +
    `${wrapperPath} (for example, DECKD_STATE_DIR may differ from the install that set this ` +
    `up, or the wrapper moved). The installed statusLine currently runs: ${hint}. Refusing to ` +
    'guess which wrap is the right one -- nothing in settings.json, the wrapper, or launchd was ' +
    `changed.${dirSetupMayHaveRun ? STATE_DIR_SETUP_CAVEAT : ''} Check DECKD_STATE_DIR, or fix ` +
    'statusLine in settings.json by hand, then retry.'
  )
}

function extractCommand(v: unknown): string {
  if (typeof v === 'string') return v
  if (v && typeof v === 'object') {
    const c = (v as Record<string, unknown>).command
    if (typeof c === 'string') return c
  }
  return ''
}

/** Quotes a value for `sh`. A path with a space must survive. */
function shellQuote(s: string): string {
  if (s === '') return "''"
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * Writes a file through a temporary name, so a crash cannot truncate it.
 *
 * By default, the target's own mode, when it already exists, is resolved
 * BEFORE anything is written, and the temp file is created at that mode from
 * the very start -- not written loose and tightened afterwards. Two defects
 * shaped this:
 *
 *   - The temp file used to be created at the caller's `mode` default
 *     (0o644) and only `chmodSync`'d to the target's tighter mode AFTER
 *     `renameSync`. A 0600 target's content then sat at 0644 for the whole
 *     write window -- and permanently, if the process died between the
 *     rename and the chmod. Resolving the final mode first, and applying it
 *     to the temp file before the rename, closes that window entirely:
 *     `file` is never visible at a looser mode than it is supposed to end
 *     up with, not even for an instant.
 *   - `${file}.${pid}.tmp` is stable per pid, so a crashed EARLIER run of
 *     the same pid could leave a stale temp file behind at a loose mode --
 *     and `writeFileSync`'s `mode` option applies only when it CREATES the
 *     file (Lesson 1), so it would be silently ignored on that leftover. A
 *     random suffix makes a collision practically impossible; the
 *     unconditional `chmodSync` below removes the remaining theoretical
 *     case rather than relying on the random suffix alone -- the same
 *     belt-and-braces the mode itself needed.
 *
 * `opts.preserveExistingMode` (default `true`) is what gives that
 * "preserve the current mode" behaviour. Pass `false` when the caller
 * needs to FORCE `mode` regardless of whatever mode the file currently has
 * -- `restoreFile` is the one caller that does, because during a rollback
 * the file's CURRENT mode is the mutated one, not the mode being restored
 * to, and probing it would silently reopen the exact window this function
 * exists to close.
 *
 * `content` accepts a `Buffer` as well as a `string`, so a caller restoring
 * an arbitrary snapshot never has to round-trip through `toString('utf8')`,
 * which is lossy for any byte sequence that is not valid UTF-8.
 *
 * Exported so a test can drive it directly against a temporary file,
 * without going through `install()`/`uninstall()`, which default to the
 * real paths under `~` and must never do so in a test.
 *
 * M-3: if `renameSync` fails (a full disk, a permissions error, `file`'s
 * parent replaced by something odd mid-run), the `tmp` file is unlinked
 * before the error propagates. Without this, a failed rename left a full
 * duplicate of `file`'s new content behind at `${file}.<pid>.<hex>.tmp`
 * forever -- no code anywhere prunes that shape, unlike the wrapper's own
 * `mktemp` leftovers, which the shell script prunes by age. The random
 * suffix already makes `tmp` practically unique per call, so cleaning it up
 * on this one failure path cannot delete anything another call created.
 *
 * I-4: if `file` is itself a SYMLINK, the temp file is renamed onto the
 * link's REAL target instead, so the link itself is never touched. `rename(2)`
 * replaces whatever inode currently sits at its destination path -- for an
 * ordinary file that is the file itself, but for a symlink it is the LINK,
 * not whatever the link points to. Verified: symlinking `~/.claude/settings.json`
 * into a dotfiles repository (`stow`, `chezmoi`, a bare `ln -s`) is ordinary
 * practice, and the old, unconditional `renameSync(tmp, file)` silently
 * replaced that link with a plain file holding the wrapped content -- the
 * dotfiles repo's own copy never saw the change, and the next `stow` or
 * `git checkout` in it would restore the ORIGINAL, unwrapped command and
 * silently go stale with no error anywhere. `resolveWriteTarget` below
 * finds the real path to write to instead, so the link stays exactly where
 * it was, still pointing at the (now correctly updated) file it always
 * pointed at.
 */
export function writeAtomic(
  file: string,
  content: string | Buffer,
  mode = 0o644,
  opts: { preserveExistingMode?: boolean } = {},
): void {
  const target = resolveWriteTarget(file)
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  let targetMode = mode
  if (opts.preserveExistingMode !== false) {
    try {
      targetMode = statSync(target).mode & 0o777
    } catch {
      // The target does not exist yet. Use the requested mode.
    }
  }
  try {
    writeFileSync(tmp, content, { mode: targetMode })
    // `mode` on `writeFileSync` applies only at creation (Lesson 1). The
    // random suffix above means `tmp` is always newly created in practice,
    // but this does not depend on that being true.
    chmodSync(tmp, targetMode)
    renameSync(tmp, target)
  } catch (e) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {
      // Best-effort cleanup. The original error below is the one that
      // matters to the caller.
    }
    throw e
  }
}

/**
 * I-4: resolves the path `writeAtomic` should actually rename its temp file
 * onto -- `file` itself, unless `file` is a symlink, in which case this
 * follows the link to whatever it really points at.
 *
 * `lstatSync` (not `statSync`) is required for the symlink check itself:
 * `statSync` follows a link automatically and would report the TARGET's
 * type, never telling this apart from an ordinary file at all.
 *
 * `realpathSync` follows the WHOLE chain in one call -- a symlink to a
 * symlink to a file resolves correctly, not just one hop. A symlink whose
 * target does not exist at all (`realpathSync` throwing `ENOENT`) cannot be
 * resolved to anywhere safe to write: refuse outright rather than guess --
 * silently creating whatever the dangling link happened to name, or
 * silently ignoring the link and writing over it as if it were an ordinary
 * file, are both surprises this function must not produce on its own.
 */
function resolveWriteTarget(file: string): string {
  let st
  try {
    st = lstatSync(file)
  } catch {
    return file // Does not exist yet, so it cannot be a symlink either.
  }
  if (!st.isSymbolicLink()) return file
  try {
    return realpathSync(file)
  } catch {
    throw new Error(
      `${file} is a symlink that does not resolve to a real file (it may be dangling, or part ` +
        'of a broken chain). Refusing to write through it. Fix or remove the link by hand, then retry.',
    )
  }
}

export interface FileSnapshot {
  path: string
  content: Buffer | null
  mode: number
}

/** Captures one file before install mutates it. Null content means absent. */
export function snapshotFile(file: string): FileSnapshot {
  try {
    return { path: file, content: readFileSync(file), mode: statSync(file).mode & 0o777 }
  } catch (e) {
    if (e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT') {
      return { path: file, content: null, mode: 0o644 }
    }
    throw e
  }
}

/**
 * Restores a snapshot atomically, or removes a file that was absent before.
 *
 * Forces `preserveExistingMode: false` on the `writeAtomic` call. Without
 * that, `writeAtomic` would resolve the mode by stat-ing the file as it
 * currently sits -- during a rollback, that is the MUTATED file, not the
 * snapshot -- so the temp file would be created and renamed at the wrong
 * mode, and only the trailing `chmodSync` would fix it, reopening exactly
 * the "loose for an instant" window `writeAtomic`'s own docblock says is
 * closed. Passing the snapshot's mode straight through, unconditionally,
 * means the restored file is never visible at any mode but the one it is
 * being restored to.
 */
export function restoreFile(snapshot: FileSnapshot): void {
  if (snapshot.content === null) {
    if (existsSync(snapshot.path)) unlinkSync(snapshot.path)
    return
  }
  writeAtomic(snapshot.path, snapshot.content, snapshot.mode, { preserveExistingMode: false })
}

/** Controls the previous launch agent's load state during rollback. Real
 * launchctl calls in production; a test double records calls instead of
 * ever invoking the real binary. */
export interface LaunchAgentController {
  /** True only if `label` is actually loaded right now -- NOT merely
   * whether a plist file for it exists on disk (finding 4). */
  isLoaded(label: string): Promise<boolean>
  /** Stops `label` if loaded. Resolves without error if it was not. */
  bootout(label: string): Promise<void>
  /** Loads the plist at `plistPath` under `label`. */
  bootstrap(label: string, plistPath: string): Promise<void>
}

function uid(): number {
  return process.getuid?.() ?? 501
}

/** The real controller. Never used by a test -- the hard rule for this
 * project is that nothing under test may invoke `launchctl` at all. */
export const systemLaunchAgentController: LaunchAgentController = {
  async isLoaded(label) {
    try {
      await run('/bin/launchctl', ['list', label])
      return true
    } catch {
      return false
    }
  },
  async bootout(label) {
    await run('/bin/launchctl', ['bootout', `gui/${uid()}/${label}`]).catch(() => {
      // Not loaded. Nothing to stop.
    })
  },
  async bootstrap(label, plistPath) {
    await run('/bin/launchctl', ['bootstrap', `gui/${uid()}`, plistPath])
      .catch(() => run('/bin/launchctl', ['load', '-w', plistPath]))
  },
}

export interface InstallOptions {
  /** Defaults to the real paths under `~`. A test injects an isolated set
   * built with `buildPaths`, so nothing it does can touch the real home
   * directory. */
  paths?: Paths
  /** Defaults to `systemLaunchAgentController`. A test injects a double, so
   * nothing it does ever calls the real `launchctl`. */
  controller?: LaunchAgentController
  /** Overrides the compiled entry point used for the build preflight and as
   * the plist's launchd target. Only a test sets this, so the preflight
   * check can run against a small synthetic script instead of depending on
   * the repository's real `dist` build being present and current. */
  script?: string
}

/** The two probe files an earlier version of `verifyWrap` left behind in the
 * LIVE sessions directory (finding I2), because it ran the probe with no
 * `DECKD_STATE_DIR` override at all. Named here once, so both the repair
 * step below and its test refer to the same literal names. */
const STRAY_PROBE_FILES = ['deckd-install-probe.json', 'baseline-probe.json']

export async function install(opts: InstallOptions = {}): Promise<void> {
  const p = opts.paths ?? paths
  const controller = opts.controller ?? systemLaunchAgentController
  enforceDirModes([p.stateDir, p.sessionsDir, p.artDir])

  // I2 repair: earlier versions of the probe below wrote fabricated usage
  // data straight into the live sessions directory, because `verifyWrap` ran
  // with no `DECKD_STATE_DIR` override and fell back to the real one. This
  // removes exactly those two known files, and only those -- never anything
  // else under `~` -- so a user who already installed once is repaired
  // rather than left with permanently fabricated usage on the deck.
  for (const name of STRAY_PROBE_FILES) {
    const stray = join(p.sessionsDir, name)
    try {
      if (existsSync(stray)) unlinkSync(stray)
    } catch {
      // Best-effort repair. A leftover probe file is not worth blocking
      // install over.
    }
  }

  const changed: string[] = []
  const wrapperDst = join(p.stateDir, 'statusline-wrapper.sh')

  // Refuse to run twice, and refuse an ambiguous wrap, both decided by the
  // ONE shared `detectWrap` (half one). Checked first, before any file is
  // touched, so a repeat run -- or a wrap pointing at a different state
  // directory -- leaves the wrapper copy, the backup, and settings.json
  // alone.
  //
  // `initialRaw` is kept alongside the parsed object so the write, much
  // later, can confirm the file has not changed underneath this install
  // before overwriting it (I-1, below).
  const { settings, raw: initialRaw } = readSettingsForInstall(p)
  const detection = detectWrap(settings, wrapperDst)
  if (detection.kind === 'this') {
    console.log('deckd is already installed. Run `deckd uninstall` first to redo it.')
    return
  }
  if (detection.kind === 'ambiguous') {
    // C-1, the other direction: wrapping this would nest a wrap inside
    // another wrap. `verifyWrap` would still pass, because a double wrap
    // reproduces the original output byte for byte, so it would go live
    // unverified, and a later `uninstall` would restore the OLD wrap as
    // "the original" and strand it.
    //
    // M-1: `dirSetupMayHaveRun: true` -- `enforceDirModes` and the I-2
    // stray-probe repair above have already run by this point, so the
    // message must not claim this refusal changed nothing at all.
    throw new Error(ambiguousWrapMessage(wrapperDst, detection.command, true))
  }

  // 1. Copy the wrapper into the state directory, so an uninstalled repo
  //    cannot break the statusline.
  const root = projectRoot()
  if (!root) throw new Error(PROJECT_ROOT_NOT_FOUND_MESSAGE)
  const wrapperSrc = join(root, 'src', 'install', 'statusline-wrapper.sh')
  if (!existsSync(wrapperSrc)) {
    throw new Error(`wrapper script missing: ${wrapperSrc}`)
  }
  const backup = `${p.claudeSettings}.deckd-backup`
  const script = opts.script ?? join(root, 'dist', 'bin', 'deckd.js')
  await preflightBuild(script)

  // This is the wrap install actually uses: it points at `wrapperDst`, and
  // it embeds `p.stateDir` -- the real directory this install is targeting
  // -- so the render-time wrapper never has to guess it from an ambient
  // environment variable launchd will not set (finding 11).
  const finalWrap = wrapStatusLine(settings.statusLine, wrapperDst, p.stateDir)

  // Prove the wrap before trusting it. This is the user's live terminal
  // statusline: if the wrapped command produces different output from the
  // original, the wrap is broken and must not be left in place. Feed both a
  // synthetic payload and compare. Throw on any difference, before anything
  // is written.
  //
  // The probe runs against a throwaway temporary directory, never the real
  // state directory (finding I2): the probe's own wrap embeds
  // `probeStateDir` instead of `p.stateDir`, so the fabricated usage and
  // per-session probe files this necessarily writes land somewhere disposed
  // of in the `finally` below, and never anywhere the daemon or the deck
  // will ever read from.
  const probeStateDir = mkdtempSync(join(tmpdir(), 'deckd-install-probe-'))
  let probe: WrapProbe
  try {
    const probeWrap = wrapStatusLine(settings.statusLine, wrapperSrc, probeStateDir)
    probe = await verifyWrap(extractCommand(probeWrap.statusLine), probeWrap.inner)
  } finally {
    rmSync(probeStateDir, { recursive: true, force: true })
  }
  if (!probe.ok) {
    // M-10: `probe.before`/`probe.after` are the user's own statusline
    // output, printed with NO bound at all here previously, while the same
    // command's stderr (`ProbeExitError`) was already capped -- two
    // channels of the same kind of text on two different policies.
    // `truncateForDisplay` is the ONE shared policy now (see there: this is
    // volume control, not a secret boundary, for either channel).
    throw new Error(
      'the wrapped statusline did not reproduce the original output, so nothing ' +
        `was changed.\nreason: ${probe.reason}\n` +
        `original output: ${JSON.stringify(truncateForDisplay(probe.before))}\n` +
        `wrapped output:  ${JSON.stringify(truncateForDisplay(probe.after))}`,
    )
  }

  // I-1: only the two snapshots that NOTHING outside deckd can change during
  // the preflight/probe window above are taken here, up front. `settings.json`
  // and the plist are each taken just-in-time, immediately before the write
  // that would clobber them, inside the `try` block below -- see there for
  // why. Rollback below still expects exactly four entries, in this same
  // order (wrapperDst, backup, claudeSettings, launchAgent), reversed.
  const snapshots: FileSnapshot[] = [
    snapshotFile(wrapperDst),
    snapshotFile(backup),
  ]

  // Record whether the daemon is actually loaded right now, BEFORE this
  // attempt changes anything (finding 4). A plist file existing on disk is
  // not the same fact -- `docs/DEPLOYMENT.md` has the user run
  // `launchctl bootout` before a hardware check, leaving the plist in place
  // but the agent stopped on purpose. Rollback must restore exactly the
  // state recorded here, not infer one from file presence.
  const wasLoaded = await controller.isLoaded(p.launchAgentLabel)
  // True only once this attempt has actually issued a launchd call. A
  // failure before that point has nothing to roll back on the launchd side,
  // and must not stop -- or start -- anything there.
  let touchedLaunchd = false

  try {
    // 1. Copy the wrapper into the state directory, so removing the repository
    //    later cannot break the statusline.
    copyFileSync(wrapperSrc, wrapperDst)
    chmodSync(wrapperDst, 0o755)
    changed.push(`wrote ${wrapperDst}`)

    // I-1: re-read `settings.json` and compare it, as raw TEXT, against
    // `initialRaw` -- read back at the very top of this function, before the
    // preflight build and the two `verifyWrap` probes, each allowed up to
    // ten seconds. `settings.json` is a file Claude Code itself rewrites
    // while a session runs (approving a `permissions.allow` entry persists
    // there), so a read-modify-write spanning that whole window would
    // silently discard whatever Claude Code wrote in between. Comparing
    // TEXT, not the parsed object, catches every kind of concurrent edit,
    // including one to a key this code never parses into anything at all.
    // Doing this check, and taking the snapshot below, immediately before
    // the write -- rather than back at the top of this function -- shrinks
    // the window as far as it will go: everything slow has already
    // happened by this point, and nothing between here and the write below
    // touches `settings.json` at all.
    const currentRaw = existsSync(p.claudeSettings) ? readFileSync(p.claudeSettings, 'utf8') : ''
    if (currentRaw !== initialRaw) {
      throw new Error(
        `${p.claudeSettings} changed while install was verifying the wrap (most likely Claude ` +
          'Code itself writing to it). Refusing to overwrite a newer version of the file with a ' +
          'decision made from a stale read. Nothing else was changed here; run `deckd install` ' +
          'again.',
      )
    }
    // The snapshot rollback would need to restore is taken from the SAME
    // read the race check above just confirmed is current -- never from a
    // stale read taken before the window, which could not restore what is
    // about to be overwritten.
    snapshots.push(snapshotFile(p.claudeSettings))

    // 2. Wrap the statusline, after a backup.
    //
    // M-6: the backup used to be the one non-atomic write in this whole
    // file -- `copyFileSync` truncates the destination and streams into it
    // in place, so a `SIGKILL` mid-copy could leave a truncated backup.
    // (Bounded harm in practice, since `statusLine` is not wrapped until
    // the write right after this one -- but there is no reason for this
    // write to be the exception.) `writeAtomic` with
    // `preserveExistingMode: false` both closes that window AND replaces
    // the separate `chmodSync` finding 6 needed: `copyFileSync` keeps an
    // EXISTING destination's mode, so a stale backup left loose by an
    // earlier version, an unzip, or a restore would otherwise receive a
    // fresh copy of a possibly 0600, secrets-bearing settings file and
    // stay loose. Forcing the mode is now `writeAtomic`'s job, not a
    // second call after the fact. `currentRaw` is the exact content just
    // confirmed above, not a fresh read -- the backup is a copy of THAT
    // moment, never an independent, potentially different, read.
    if (existsSync(p.claudeSettings)) {
      writeAtomic(backup, currentRaw, statSync(p.claudeSettings).mode & 0o777, { preserveExistingMode: false })
      changed.push(`backed up ${p.claudeSettings} to ${backup}`)
    }
    settings.statusLine = finalWrap.statusLine
    // M-5: 0600, not the default 0644 -- `writeAtomic`'s `preserveExistingMode`
    // finds nothing to stat on a settings.json install itself creates, so it
    // falls through to `mode`. Only `statusLine` is in the file at this
    // instant, but Claude Code can add an `env` block with a key to it
    // later, and this file should never have been world-readable in the
    // first place.
    writeAtomic(p.claudeSettings, JSON.stringify(settings, null, 2), 0o600)
    changed.push(`wrapped statusLine in ${p.claudeSettings}`)

    // 3. Write and load the launchd agent. Snapshotted here, just before the
    // write, for the same reason as claudeSettings above -- nothing else
    // touches the plist, so this could equally have been taken up front,
    // but keeping every just-before-its-own-write snapshot in one place
    // makes the pattern easier to audit than splitting it across two
    // styles.
    snapshots.push(snapshotFile(p.launchAgent))
    mkdirSync(dirname(p.launchAgent), { recursive: true })
    writeAtomic(
      p.launchAgent,
      buildPlist(p.launchAgentLabel, process.execPath, script, join(p.stateDir, 'launchd.log')),
    )
    changed.push(`wrote ${p.launchAgent}`)

    touchedLaunchd = true
    await controller.bootout(p.launchAgentLabel)
    await controller.bootstrap(p.launchAgentLabel, p.launchAgent)
    changed.push('loaded the launchd agent')
  } catch (e) {
    const rollbackErrors: string[] = []
    if (touchedLaunchd) {
      await controller.bootout(p.launchAgentLabel).catch((stopError: unknown) => {
        rollbackErrors.push(`stop the partially-installed agent: ${String(stopError)}`)
      })
    }
    // I-1: a failed restore is FATAL to rollback, full stop. The old code
    // pushed a failed `restoreFile` onto `rollbackErrors` and kept going --
    // so a failed settings.json restore (disk full, permissions) did not
    // stop the loop from reaching the wrapper's own snapshot next and
    // unlinking it, because that snapshot's content was `null` (the
    // wrapper did not exist before this attempt). Result: settings.json
    // left pointing at a wrapper that rollback had just deleted -- the
    // same "live reference to a deleted file" harm C-1 exists to prevent,
    // reached through rollback instead of uninstall. The instant one
    // restore fails, stop: leave every remaining snapshot's file exactly
    // as this failed attempt left it (nothing further deleted, nothing
    // further overwritten), skip the launchd reload below too, and throw
    // with the exact manual recovery steps -- there is no safe automatic
    // next move once a restore has already failed once.
    let fatalRestore: string | null = null
    for (const snapshot of [...snapshots].reverse()) {
      if (fatalRestore) break
      try {
        restoreFile(snapshot)
      } catch (restoreError) {
        rollbackErrors.push(`${snapshot.path}: ${String(restoreError)}`)
        fatalRestore =
          `rollback could not restore ${snapshot.path} (${String(restoreError)}), so it stopped ` +
          'immediately -- nothing else was touched, deleted, or restored after this point. To ' +
          'recover by hand: 1) fix whatever is blocking that path (free disk space, fix ' +
          'permissions, or restore ownership); 2) compare it against the backup file next to ' +
          'it if one exists, and copy the correct content back yourself if needed; 3) only once ' +
          `${p.claudeSettings} is confirmed correct and no longer mentions the deckd wrapper, ` +
          'remove any leftover wrapper script or backup file by hand. Do not delete anything ' +
          'under the state directory before that is confirmed.'
      }
    }
    if (fatalRestore) {
      throw new Error(`${String(e)} ${fatalRestore}`)
    }
    // Restore exactly the load state recorded before this attempt touched
    // anything (finding 4): only if launchd was actually touched, and only
    // if the agent was actually loaded beforehand. A deliberate
    // `launchctl bootout` run in another terminal before a hardware check
    // must not be undone by a failed install here.
    if (touchedLaunchd && wasLoaded) {
      await controller.bootstrap(p.launchAgentLabel, p.launchAgent).catch((restoreError: unknown) => {
        rollbackErrors.push(`reload prior launch agent: ${String(restoreError)}`)
      })
    }
    const detail = rollbackErrors.length
      ? ` Rollback also had errors: ${rollbackErrors.join('; ')}`
      : ' All file changes were rolled back.'
    throw new Error(`${String(e)}${detail}`)
  }

  console.log('deckd installed.\n')
  for (const line of changed) console.log(`  . ${line}`)
  console.log('\nThe deck starts now, and at every login.')
  console.log('macOS may ask to allow automation. Approve it, so window focus works.')
}

export interface RefreshWrapperResult {
  path: string
}

/**
 * Re-copies the wrapper script from the repository into the state directory
 * and re-verifies it, without touching settings.json or launchd (finding
 * 13). `install()` returns early once `isInstalled` is true, so it never
 * re-copies the wrapper once one exists, and the only documented recovery
 * for a drifted wrapper was a full `uninstall` followed by `install` --
 * which is exactly the path C1 lived on. This gives an already-installed
 * user a narrow, safe repair for a wrapper that has drifted from the
 * repository (a hand edit, a partial copy, a bad restore).
 */
export async function refreshWrapper(opts: InstallOptions = {}): Promise<RefreshWrapperResult> {
  const p = opts.paths ?? paths
  const root = projectRoot()
  if (!root) throw new Error(PROJECT_ROOT_NOT_FOUND_MESSAGE)
  const wrapperSrc = join(root, 'src', 'install', 'statusline-wrapper.sh')
  if (!existsSync(wrapperSrc)) throw new Error(`wrapper script missing: ${wrapperSrc}`)
  const wrapperDst = join(p.stateDir, 'statusline-wrapper.sh')

  // M-2: `writeAtomic` below needs somewhere to put its temp file. `install`
  // always runs this before it ever touches settings.json, but
  // `refreshWrapper` can be reached on an already-installed machine whose
  // state directory was later removed by hand (a user "cleaning up", a
  // restore that missed it) -- measured: a bare ENOENT with no explanation,
  // because there was nowhere for the temp file to go. `settings.json`
  // still points at the missing wrapper in that case, so this is exactly
  // the "the wrapper is gone" repair `docs/DEPLOYMENT.md` points a user at
  // `refresh-wrapper` for; it must not itself fail with a raw filesystem
  // error.
  enforceDirModes([p.stateDir, p.sessionsDir, p.artDir])

  // Half one: the same shared `detectWrap` install and uninstall use. An
  // ambiguous wrap (some other deckd wrapper, not this one) must refuse
  // here too, exactly like install and uninstall -- refreshing INTO an
  // ambiguous state would re-verify against the wrong original.
  const { settings } = readSettingsForInstall(p)
  const detection = detectWrap(settings, wrapperDst)
  if (detection.kind === 'none') {
    throw new Error('deckd is not installed. Run `deckd install` first.')
  }
  if (detection.kind === 'ambiguous') {
    // M-1: `dirSetupMayHaveRun: true` -- `enforceDirModes` above has already
    // run by this point, so the message must not claim this refusal
    // changed nothing at all.
    throw new Error(ambiguousWrapMessage(wrapperDst, detection.command, true))
  }

  // I-2: `settings.statusLine` here is the ALREADY-INSTALLED, already-wrapped
  // command -- unlike `install()`, where it is still the pristine original.
  // The old code passed it straight to `wrapStatusLine` as if it were the
  // original, so `inner` became the entire installed command, DECKD_STATE_DIR
  // and all: running that command directly as the probe's "before", and
  // again nested inside the probe's "after", both executed the wrapper a
  // SECOND time with no override -- reading `DECKD_STATE_DIR='<the live
  // dir>'` baked into that inner command -- and wrote fabricated usage and a
  // probe session file straight into the live state directory, twice, with
  // no cleanup. Recovering the true pre-wrap original first means the probe
  // below never invokes `wrapperDst` or the live state directory at all: it
  // only ever runs the ORIGINAL command and a freshly-built wrap of it, both
  // confined to `probeStateDir`.
  const backupPath = `${p.claudeSettings}.deckd-backup`
  const recovered = tryUnwrapWrapped(settings.statusLine, wrapperDst)
  if (!recovered.ok) {
    // M-1: does not claim "nothing was changed" -- `enforceDirModes` above
    // already ran by this point.
    throw new Error(
      'could not recover the original statusLine command from the installed wrap (the ' +
        'embedded marker is missing or unreadable), so the wrapper cannot be safely ' +
        're-verified. Nothing in settings.json, the wrapper, or launchd was changed by this ' +
        `attempt.${STATE_DIR_SETUP_CAVEAT} A pre-install backup may exist at ${backupPath} -- ` +
        "check it by hand, or run 'deckd uninstall' then 'deckd install' again.",
    )
  }

  const probeStateDir = mkdtempSync(join(tmpdir(), 'deckd-refresh-probe-'))
  try {
    const probeWrap = wrapStatusLine(recovered.value, wrapperSrc, probeStateDir)
    const probe = await verifyWrap(extractCommand(probeWrap.statusLine), probeWrap.inner)
    if (!probe.ok) {
      throw new Error(
        `the wrapper at ${wrapperSrc} did not reproduce the original output, so nothing ` +
          `was changed.\nreason: ${probe.reason}`,
      )
    }
  } finally {
    rmSync(probeStateDir, { recursive: true, force: true })
  }

  // I-3: replace the LIVE, possibly-executing script atomically. The old
  // `copyFileSync` truncates the destination and streams into it in place;
  // a render that `exec`s the file mid-copy would run a truncated script.
  // `writeAtomic` writes a temp file in the same directory and renames it,
  // so any reader sees either the whole old file or the whole new one,
  // never a partial one. `preserveExistingMode: false` forces 0755
  // regardless of whatever mode the file currently has, matching the old
  // unconditional `chmodSync`.
  writeAtomic(wrapperDst, readFileSync(wrapperSrc), 0o755, { preserveExistingMode: false })
  return { path: wrapperDst }
}

/** A representative statusline payload, used only to prove the wrap works. */
const PROBE_PAYLOAD = JSON.stringify({
  session_id: 'deckd-install-probe',
  model: { display_name: 'Opus 5' },
  context_window: { used_percentage: 10, total_input_tokens: 1, context_window_size: 2 },
  cost: { total_cost_usd: 0 },
  effort: { level: 'medium' },
  rate_limits: {
    five_hour: { used_percentage: 1, resets_at: 0 },
    seven_day: { used_percentage: 1, resets_at: 0 },
  },
  workspace: { project_dir: '/tmp' },
})

export interface WrapProbe {
  ok: boolean
  reason: string
  before: string
  after: string
}

const DEFAULT_PROBE_TIMEOUT_MS = 10_000

/** Distinguishes "the command never exited" from every other failure, so
 * `verifyWrap` can apply a different policy to it (see below). */
class ProbeTimeoutError extends Error {}

/** How much of any probe-derived text (a probed command's stderr, or its
 * stdout in a failed-verify report) install ever prints or throws with.
 *
 * M-9/M-10: this is VOLUME control, not a secret boundary -- a bearer token
 * sitting in the first `PROBE_TEXT_LIMIT` bytes of a user's own statusline
 * output or stderr still reaches the console in full, truncation or not.
 * Do not rely on this to hide anything sensitive; it exists only so a
 * runaway or binary-garbage command cannot flood the terminal. Both
 * channels -- the probed command's stderr (`ProbeExitError` below) and its
 * stdout (`install`'s failed-verify message) -- share this ONE limit and
 * ONE truncation function, so they cannot drift onto two different
 * policies for what is, functionally, the same kind of text. */
const PROBE_TEXT_LIMIT = 200

/**
 * Truncates `s` for display, counting real UTF-8 BYTES rather than UTF-16
 * code units (M-9). The old stderr-only version sliced with `.length` and
 * labelled the result "bytes", which was wrong for any non-ASCII text, and
 * could split a surrogate PAIR in two, leaving a lone surrogate in the
 * truncated string. Slicing the encoded byte buffer instead means a
 * multi-byte sequence cut in half decodes to a single replacement
 * character, never a raw lone surrogate, and the reported count is the
 * real byte count.
 */
function truncateForDisplay(s: string, limit = PROBE_TEXT_LIMIT): string {
  const buf = Buffer.from(s, 'utf8')
  if (buf.length <= limit) return s
  return `${buf.subarray(0, limit).toString('utf8')}… (${String(buf.length)} bytes total, truncated)`
}

/** Distinguishes a clean, fast, nonzero exit from every other kind of
 * failure (a timeout, a spawn error), so `verifyWrap` can tell "the original
 * and the wrapped command failed the same way" from "the wrapper introduced
 * a different failure" (finding 3).
 *
 * M-4: `stderr` is the USER'S OWN statusline command's error output, and
 * `install` folds this whole message into what it prints and throws on a
 * failed probe. Truncated to a small, fixed volume budget (see
 * `truncateForDisplay` -- NOT a secret-hygiene measure, just a bound on how
 * much of the user's own output reaches the console at once). */
class ProbeExitError extends Error {
  constructor(public readonly code: number | null, stderr: string) {
    super(`exit ${String(code)}: ${truncateForDisplay(stderr)}`)
    this.name = 'ProbeExitError'
  }
}

/**
 * Runs one shell command, feeding it `input` on stdin and collecting stdout.
 *
 * This does NOT use `promisify(execFile)` with an `input` option. That option
 * only exists on the synchronous `execFileSync`/`spawnSync`; the async
 * `execFile` silently ignores it. A probe command that reads stdin to
 * completion, such as `cat >/dev/null; ...`, would then block forever on a
 * pipe nothing ever closes. `spawn` writes the payload and ends stdin itself,
 * so the child always sees an EOF.
 *
 * That alone bounds a command that reads its input and then exits. It does
 * NOT bound a command that never exits at all -- an infinite loop, or a
 * network call that never returns -- so this also enforces `timeoutMs`,
 * killing the child and rejecting with `ProbeTimeoutError` if it fires.
 */
function runWithStdin(cmd: string, input: string, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!cmd) {
      resolve('')
      return
    }
    const child = spawn('/bin/sh', ['-c', cmd])
    let out = ''
    let err = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new ProbeTimeoutError(`timed out after ${timeoutMs}ms running: ${cmd}`))
    }, timeoutMs)

    child.stdout.on('data', (d: Buffer) => { out += d })
    child.stderr.on('data', (d: Buffer) => { err += d })
    // A child that exits before it reads stdin -- e.g. `exit 3` with a
    // payload still queued -- makes this write emit EPIPE. The 'close'
    // handler below still reports the real outcome, so this only needs to
    // stop the unhandled error from crashing the process.
    child.stdin.on('error', () => {})
    child.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code !== 0) reject(new ProbeExitError(code, err))
      else resolve(out)
    })
    child.stdin.write(input)
    child.stdin.end()
  })
}

/**
 * Runs the original statusline command and the wrapped one with the same
 * payload, then compares their output. The wrapper must be transparent, so any
 * difference means the wrap is broken and install must not proceed.
 *
 * Both run through `sh -c`, which is how Claude Code runs a statusline command.
 *
 * `timeoutMs` defaults to 10 seconds -- generous, since a statusline runs on
 * every render and anything slower is already broken -- but is a parameter so
 * a test can inject a short one instead of actually waiting.
 *
 * Timeout policy is deliberately NOT the same as the "original already
 * fails" rule below, and that asymmetry is the point, not an oversight: a
 * command that HANGS cannot be compared at all -- there is no output to diff
 * against, and the wrapped form would hang for the identical reason, since it
 * runs the same inner command at the end -- so a timeout on EITHER side means
 * `ok: false` immediately, without bothering to run the other side too.
 *
 * A command that FAILS FAST, by contrast, is not skipped on either side
 * (finding 3, fixed here): the ORIGINAL failing fast used to make this return
 * `ok: true` without ever running the WRAPPED command, on the theory that
 * "wrapping a failing command changes nothing" -- true for the comparison,
 * false for the wrapper's own failure modes, which that branch never
 * exercised. Now both sides always run when the failure is not a timeout,
 * and the two outcomes are compared:
 *
 *   - Both fail, with the SAME exit code: the wrapper faithfully reproduced
 *     the original's own failure. That is the user's business, not the
 *     wrapper's, so this is `ok: true`.
 *   - Both fail, but DIFFERENTLY (or only the wrapped side fails): the
 *     wrapper itself may be broken -- non-executable, a syntax error, wrong
 *     permissions -- and none of that is safe to install unverified. `ok:
 *     false`.
 *   - The original fails but the wrapped side runs to completion anyway:
 *     the wrapper mechanism works. `ok: true`.
 */
export async function verifyWrap(
  wrapped: string,
  inner: string,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<WrapProbe> {
  const runProbe = (cmd: string): Promise<string> => runWithStdin(cmd, PROBE_PAYLOAD, timeoutMs)

  let before = ''
  let after = ''
  let innerError: unknown

  try {
    before = await runProbe(inner)
  } catch (e) {
    if (e instanceof ProbeTimeoutError) {
      return {
        ok: false,
        reason:
          `the original command did not finish within ${timeoutMs}ms, so the wrap could ` +
          `not be verified: ${e.message}`,
        before,
        after,
      }
    }
    // The original command failed, quickly. Do not return yet: the wrapped
    // form still has to run, on its own, before install can trust it.
    innerError = e
  }

  try {
    after = await runProbe(wrapped)
  } catch (e) {
    if (e instanceof ProbeTimeoutError) {
      return { ok: false, reason: `wrapped command timed out: ${e.message}`, before, after }
    }
    if (innerError instanceof ProbeExitError && e instanceof ProbeExitError && innerError.code === e.code) {
      return {
        ok: true,
        reason: `original command failed (exit ${String(e.code)}); the wrapper reproduced the same failure`,
        before,
        after,
      }
    }
    if (innerError !== undefined) {
      return {
        ok: false,
        reason:
          `the original command failed (${String(innerError)}) and the wrapped command failed ` +
          `differently (${String(e)}); the wrapper itself may be broken`,
        before,
        after,
      }
    }
    return { ok: false, reason: `wrapped command failed: ${String(e)}`, before, after }
  }

  if (innerError !== undefined) {
    // The original failed, but the wrapper ran to completion anyway. The
    // wrapper mechanism works; wrapping it changes nothing about the
    // original's own failure.
    return { ok: true, reason: `original command failed: ${String(innerError)}`, before, after }
  }

  if (before !== after) {
    return { ok: false, reason: 'output differs', before, after }
  }
  return { ok: true, reason: 'identical output', before, after }
}

/**
 * Proves the compiled entry point actually loads, not merely that the file
 * exists (finding 12). `existsSync` alone passes for a `dist` that throws at
 * import time; launchd's `KeepAlive` then restarts the crashing process
 * forever while the deck stays dark, and rollback never triggers, because
 * `bootstrap` itself returned 0.
 *
 * Running `node <script>` with no subcommand is safe to do here: `bin/deckd.ts`'s
 * own dispatch prints a usage line and exits 2 for that case, WITHOUT opening
 * the Stream Deck or touching launchd -- both only happen after a real
 * `start` argument reaches it. Any other outcome -- a different exit code, a
 * hang, an uncaught import-time exception (which Node reports as exit 1) --
 * means the build itself is broken, and install must not proceed.
 */
export async function preflightBuild(script: string, timeoutMs = 10_000): Promise<void> {
  if (!existsSync(script)) {
    throw new Error(`build first: ${script} does not exist. Run npm run build.`)
  }
  let exitedZero = false
  try {
    await run(process.execPath, [script], { timeout: timeoutMs })
    exitedZero = true
  } catch (e) {
    const code = (e as { code?: unknown }).code
    if (code === 2) return
    throw new Error(
      `build preflight failed: running ${script} with no arguments should print usage and ` +
        `exit 2, but it did not: ${String(e)}. The build may be broken.`,
    )
  }
  if (exitedZero) {
    throw new Error(
      `build preflight failed: running ${script} with no arguments exited 0; expected the ` +
        'usage message and exit code 2. The build may be broken.',
    )
  }
}

/**
 * Describes what `uninstall` actually did with the recovered statusLine
 * value, for the printed summary. A separate, exported function so a test
 * can check the wording directly against a synthetic `RecoverResult`,
 * without running the whole of `uninstall()`, which defaults to the real
 * `paths.claudeSettings`.
 *
 * `recoverStatusLine` can report `source: 'backup'` or `'embedded'` while
 * still giving back `statusLine: undefined` -- both sources can recover a
 * legitimately empty original, e.g. because install ran when statusLine was
 * already absent. That case is a deletion, not a restoration, and the
 * summary must say so plainly rather than claiming a restore that did not
 * happen.
 */
export function describeStatusLineOutcome(recovered: RecoverResult, settingsPath: string): string {
  if (recovered.source === 'none') {
    return `left statusLine absent in ${settingsPath} (original unrecoverable, see warning above)`
  }
  if (recovered.statusLine === undefined) {
    return `deleted statusLine in ${settingsPath} (the recovered original was empty)`
  }
  return recovered.source === 'backup'
    ? `restored statusLine in ${settingsPath} from the backup`
    : `restored statusLine in ${settingsPath}`
}

export interface UninstallOptions {
  /** Defaults to the real paths under `~`. A test injects an isolated set
   * built with `buildPaths`, so nothing it does can touch the real home
   * directory. */
  paths?: Paths
  /** Defaults to `systemLaunchAgentController`. A test injects a double, so
   * nothing it does ever calls the real `launchctl`. */
  controller?: LaunchAgentController
}

/**
 * I-5: states plainly what an uninstall attempt has already done to the
 * live system by the time a LATER step fails, and whether settings.json
 * itself was touched. Unlike a failed `install`, a failed `uninstall` never
 * rolls back: the launch agent it already stopped stays stopped, and a
 * plist it already deleted stays deleted. A bare filesystem error naming a
 * temp file the user has never heard of leaves them unable to tell which
 * half of the uninstall actually happened, or what is safe to do next.
 */
function describeUninstallState(
  p: Paths,
  plistRemoved: boolean,
  opts: { settingsWritten?: boolean } = {},
): string {
  const daemon = plistRemoved
    ? ` The launch agent ${p.launchAgentLabel} has already been stopped, and its plist at ` +
      `${p.launchAgent} has already been removed.`
    : ` The launch agent ${p.launchAgentLabel} has already been stopped; there was no plist ` +
      'file to remove.'
  const settingsNote = opts.settingsWritten
    ? ` ${p.claudeSettings} WAS updated by this attempt.`
    : ` ${p.claudeSettings} was NOT modified by this attempt.`
  return `${daemon}${settingsNote}`
}

export async function uninstall(opts: UninstallOptions = {}): Promise<void> {
  const p = opts.paths ?? paths
  const controller = opts.controller ?? systemLaunchAgentController
  const removed: string[] = []
  const wrapper = join(p.stateDir, 'statusline-wrapper.sh')
  const backupPath = `${p.claudeSettings}.deckd-backup`

  // C1: refuse outright when settings.json will not parse, BEFORE touching
  // launchd, the plist, or anything else. The old lenient reader returned
  // {} on any parse error, which skipped the unwrap below but let execution
  // reach the wrapper delete anyway -- stranding a live reference to a file
  // about to be removed, with no deckd command left able to fix it. Doing
  // this read first, as a pure read with no side effect, means a settings
  // file this cannot parse leaves every file and every launchd state
  // completely untouched.
  //
  // I-1: `initialRaw` is kept alongside the parsed object, exactly like
  // `readSettingsForInstall` gives `install`, so the write far below can
  // re-read the file as raw TEXT immediately before it would overwrite it,
  // and abort on any mismatch. `await controller.bootout` below is a real
  // `launchctl` subprocess call, and settings.json is a file Claude Code
  // itself rewrites while a session runs (persisting an approved
  // `permissions.allow` entry, for one) -- so a read-modify-write spanning
  // that whole window would otherwise silently discard whatever landed in
  // it. `install` was given exactly this discipline in an earlier round;
  // this applies it to the verb that did not get it (lesson 21).
  const { settings, raw: initialRaw } = readSettingsForUninstall(p)

  // C-1, THE critical finding, round 3: decided by the SAME shared
  // `detectWrap` `install` and `refreshWrapper` use -- not by `isInstalled`
  // alone. `isInstalled` only ever answers "wrapped by exactly this path";
  // it has no way to say "wrapped, but by something else", so a wrap
  // pointing at a DIFFERENT state directory (DECKD_STATE_DIR changed
  // between the install and this uninstall, or the wrapper moved) made the
  // old code fall straight to "never wrapped at all" and delete the
  // backup, remove the plist, and print success -- while the live wrap
  // kept invoking a wrapper this invocation never touched. Checked here,
  // as a pure decision with no side effect yet, BEFORE launchd or the
  // plist are touched: refusing changes nothing at all, exactly like
  // `install`'s mirror-image check. `dirSetupMayHaveRun` stays `false` --
  // unlike `install`/`refreshWrapper`, nothing above this line has touched
  // anything, so the base message is already literally true (M-1).
  const detection = detectWrap(settings, wrapper)
  if (detection.kind === 'ambiguous') {
    throw new Error(
      `${ambiguousWrapMessage(wrapper, detection.command)} (this invocation resolved the state ` +
        `directory to ${p.stateDir} -- if that is not where the wrap was installed, set ` +
        'DECKD_STATE_DIR to the correct one and retry.)',
    )
  }

  await controller.bootout(p.launchAgentLabel)
  let plistRemoved = false
  if (existsSync(p.launchAgent)) {
    unlinkSync(p.launchAgent)
    removed.push(`removed ${p.launchAgent}`)
    plistRemoved = true
  }

  // `detection.kind === 'this'` is the only branch that unwraps anything.
  // `'none'` (settings.json never mentioned any deckd wrapper) falls
  // straight through to the stray-file cleanup below, exactly as before.
  let recovered: RecoverResult | undefined
  if (detection.kind === 'this') {
    recovered = recoverStatusLine(settings.statusLine, backupPath, wrapper)
    if (recovered.warning) console.warn(recovered.warning)
    if (recovered.statusLine === undefined) delete settings.statusLine
    else settings.statusLine = recovered.statusLine

    // I-1: re-read settings.json as raw TEXT and compare it against
    // `initialRaw`, immediately before the write below -- everything slow
    // (the `bootout` await above) has already happened by this point, and
    // nothing between here and the write touches settings.json at all, so
    // this shrinks the window as far as it will go, exactly like `install`.
    // Comparing TEXT, not the parsed object, catches every kind of
    // concurrent edit, including one to a key this code never parses into
    // anything at all.
    const currentRaw = existsSync(p.claudeSettings) ? readFileSync(p.claudeSettings, 'utf8') : ''
    if (currentRaw !== initialRaw) {
      throw new Error(
        `${p.claudeSettings} changed while uninstall was running (most likely Claude Code ` +
          'itself writing to it). Refusing to overwrite a newer version of the file with a ' +
          `decision made from a stale read.${describeUninstallState(p, plistRemoved)} Confirm ` +
          'settings.json is what you expect, then run `deckd uninstall` again; it is safe to retry.',
      )
    }

    // I-5: a write failure here (a full disk, a permissions error) must not
    // surface as a bare filesystem error -- the launch agent above may
    // already be stopped and its plist already gone, and this message is
    // the only place that says so.
    try {
      writeAtomic(p.claudeSettings, JSON.stringify(settings, null, 2))
    } catch (e) {
      throw new Error(
        `${String(e)}${describeUninstallState(p, plistRemoved)} Fix whatever is blocking the ` +
          'write (free disk space, fix file permissions), then run `deckd uninstall` again.',
      )
    }
    removed.push(describeStatusLineOutcome(recovered, p.claudeSettings))

    // Half one's positive guarantee: read the file back and confirm it no
    // longer references ANY deckd wrapper -- not merely the exact path this
    // invocation computed. Using `detectWrap` here (instead of the old
    // `isInstalled`-only check) also catches the case where the RECOVERED
    // original itself still looks like some other deckd wrap (e.g. a prior
    // marker-absent double-wrap already nested one wrap inside another):
    // that is `'ambiguous'`, not `'this'`, but it is just as unsafe to
    // proceed past -- deleting the wrapper below would still strand a live
    // reference, just to a DIFFERENT wrapper than the one being deleted.
    // Never delete on the strength of an assumption that the write above
    // worked; only on having just read the proof back off disk.
    if (detectWrap(readSettingsForUninstall(p).settings, wrapper).kind !== 'none') {
      throw new Error(
        `${p.claudeSettings} still references a deckd wrapper after writing the unwrap. ` +
          'Refusing to delete the wrapper script, so nothing is stranded.' +
          `${describeUninstallState(p, plistRemoved, { settingsWritten: true })} Check the file ` +
          'by hand, then run `deckd uninstall` again.',
      )
    }
  }

  if (existsSync(wrapper)) {
    unlinkSync(wrapper)
    removed.push(`removed ${wrapper}`)
  }

  // Half one's negative guarantee, absolute: uninstall NEVER deletes the
  // backup, under any code path, full stop. This is the single change that
  // ends the harm class three straight review rounds have found a fresh
  // trigger for -- a lenient parse (round 1), a marker-based check (round
  // 2), an ambiguous wrap `isInstalled` alone could not see (round 3, C-1
  // above). Each fix closed the trigger IT found; nothing closed the
  // shared final step every one of them reached: deleting the one
  // remaining copy of the user's original statusLine. A backup that is
  // never deleted cannot be the last copy lost, no matter what a FUTURE
  // detection bug gets wrong. The cost is one small leftover file --
  // `docs/DEPLOYMENT.md` says so, so it reads as expected, not as a leak.
  if (existsSync(backupPath)) {
    removed.push(`left the pre-install backup at ${backupPath} in place (uninstall never deletes it -- see below)`)
  }

  console.log('deckd uninstalled.\n')
  for (const line of removed) console.log(`  . ${line}`)
  console.log(`\nThe state directory remains: ${p.stateDir}`)
  console.log('It holds your Spotify token. Delete it by hand if you want it gone.')
  if (existsSync(backupPath)) {
    console.log(
      `\n${backupPath} also remains. deckd never deletes it, on any uninstall path, so it is ` +
        'always there to recover from by hand. Delete it yourself once you have confirmed ' +
        'settings.json is correct.',
    )
  }
}

/**
 * Install must not replace an unreadable settings file with an empty object.
 *
 * M-6: `install()` always runs `enforceDirModes` and the I2 stray-file
 * repair BEFORE this read, because those are wanted regardless of whether
 * settings.json turns out to be readable. So the generic
 * "no install changes were made" wording from `parseSettingsObject` is not
 * quite true here -- the state directory setup already happened, and it is
 * safe to keep. This appends a clarification rather than claiming zero
 * side effects; the original phrase stays a substring, so callers matching
 * on it still match.
 *
 * Returns the parsed object AND the exact raw text it was parsed from
 * (`''` when the file is absent). `install` keeps `raw` alongside the
 * parsed `settings` so the write, much later, can re-read the file and
 * compare it by TEXT against this exact moment -- the I-1 fix. A parsed
 * object could not serve that purpose: re-serialising it (`JSON.stringify`)
 * can normalise away whitespace or key order a byte-for-byte compare would
 * still catch, and would silently miss a key `settings` never parses into
 * anything meaningful in the first place.
 */
function readSettingsForInstall(p: Paths): { settings: Record<string, unknown>; raw: string } {
  if (!existsSync(p.claudeSettings)) return { settings: {}, raw: '' }
  const raw = readFileSync(p.claudeSettings, 'utf8')
  try {
    return { settings: parseSettingsObject(raw, p.claudeSettings, 'install'), raw }
  } catch (e) {
    throw new Error(
      `${String(e)} (deckd's own state directory setup, if any was needed, already ran and is safe to keep.)`,
    )
  }
}

/**
 * Uninstall must not delete the wrapper it cannot prove nothing still
 * references (C1). Where `readSettingsForInstall` can just let its generic
 * parse error propagate -- an install that never started needs no special
 * recovery advice -- an uninstall failing here can leave a user with a
 * broken statusline and no other deckd command able to help, so the thrown
 * message says exactly what is wrong and exactly what to do about it.
 *
 * I-1: returns the parsed object AND the exact raw text it was parsed from,
 * for the same reason `readSettingsForInstall` does -- the write far below
 * in `uninstall` re-reads the file and compares it, as raw TEXT, against
 * this exact moment, immediately before it would otherwise overwrite
 * whatever is there. `uninstall` awaits a real `launchctl bootout`
 * subprocess between this read and that write, and `settings.json` is a
 * file Claude Code itself rewrites while a session runs (persisting an
 * approved `permissions.allow` entry, for one) -- so without the compare,
 * that window silently discards whatever landed in it. `install` was given
 * this exact discipline in an earlier round; this applies it to the verb
 * that did not get it (lesson 21).
 */
function readSettingsForUninstall(p: Paths): { settings: Record<string, unknown>; raw: string } {
  if (!existsSync(p.claudeSettings)) return { settings: {}, raw: '' }
  const raw = readFileSync(p.claudeSettings, 'utf8')
  try {
    return { settings: parseSettingsObject(raw, p.claudeSettings, 'uninstall'), raw }
  } catch (e) {
    const backupPath = `${p.claudeSettings}.deckd-backup`
    const repair = existsSync(backupPath)
      ? `A pre-install backup exists at ${backupPath}. Fix the syntax error in ` +
        `${p.claudeSettings} by hand (or restore it from that backup), then run ` +
        "'deckd uninstall' again."
      : `Fix the syntax error in ${p.claudeSettings} by hand, then run 'deckd uninstall' ` +
        'again. No pre-install backup was found to fall back to.'
    throw new Error(`${String(e)} ${repair}`)
  }
}

/** Parses settings without allowing install or uninstall to erase malformed
 * content. `action` only changes the wording of the thrown message. */
export function parseSettingsObject(
  text: string,
  file: string,
  action: 'install' | 'uninstall' = 'install',
): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    // M-5: `String(e)` from `JSON.parse` can embed the first bytes of the
    // file itself -- Node 22 prints `Unexpected token 's', ""sk-ant-api"...
    // is not valid JSON` for input that is not JSON at all. settings.json
    // can hold anything by the time this runs (a hand edit, a botched
    // restore), so this never echoes any of it. A "position N" detail is
    // safe -- it names an offset, not content -- and is kept when present;
    // otherwise a fixed, contentless phrase is used.
    const message = e instanceof Error ? e.message : String(e)
    const positionMatch = /at position \d+(?: \(line \d+ column \d+\))?/.exec(message)
    const safeDetail = positionMatch ? positionMatch[0] : 'it does not start with valid JSON'
    throw new Error(`cannot parse ${file}; no ${action} changes were made (${safeDetail}).`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${file} must contain a JSON object; no ${action} changes were made.`)
  }
  return parsed as Record<string, unknown>
}
