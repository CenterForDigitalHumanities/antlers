/**
 * @module log Structured logging for DEER — one record shape, one gate, one sink.
 * @author Patrick Cuba <cubap@slu.edu>
 *
 * Standardization goals (antlers#8):
 *
 * 1. ONE record shape. Every message is `{ level, code, message, detail, at }`,
 *    so a host can filter, route, or render logs without parsing prose.
 * 2. ONE gate. `config.DEBUG` controls verbosity, same as the rest of DEER;
 *    `debug` records print only under DEBUG, `info`/`warn`/`error` always do —
 *    which is exactly what the call sites being replaced printed.
 * 3. ONE sink. `config.log` may be replaced the way `config.fetch` is — the
 *    instrumentation point a host points at Sentry, a debug panel, or a noop.
 *    The default sink formats for the browser console.
 *
 * Codes are stable identifiers (`module.topic`, kebab-case), so an app can
 * key on them across releases: `rerum.shipped-generator`,
 * `expand.merge-counts`, `offline.write-queued`.  BREAKING a code is a breaking
 * change; ADDING detail keys is not.
 *
 * `silent` exists so a deployed exhibit can turn DEER's console chatter off
 * without unplugging its own logging.
 */

import config from './config.js'

/**
 * @typedef {"debug"|"info"|"warn"|"error"|"silent"} LogLevel
 */

/** Record weight by level; a record is emitted when its weight clears the gate. */
const WEIGHTS = { debug: 10, info: 20, warn: 30, error: 40, silent: Infinity }

/**
 * The resolved verbosity gate.  An unset LOG_LEVEL follows DEBUG, preserving
 * the behavior of the call sites this module replaced: DEBUG meant the
 * advisory chatter, off meant only warn and above.
 *
 * @returns {Number} the weight a record must clear to be emitted.
 */
function gate() {
    const level = config.LOG_LEVEL ?? (config.DEBUG ? "debug" : "info")
    return WEIGHTS[level] ?? WEIGHTS.info
}

/**
 * The console method a level renders through.  `table` and `trace` exist but
 * are deliberately unused: the format stays predictable for a host reading
 * over a shoulder.
 *
 * @param {LogLevel} level
 * @returns {String} the console method name.
 */
const methodFor = (level) => (level === "debug") ? "debug"
    : (level === "info") ? "info" : (level === "error") ? "error" : "warn"

/**
 * Build a record.  `at` is captured here, once, so a sink is handed a complete
 * envelope and never needs a clock.
 *
 * @param {LogLevel} level
 * @param {String} code the stable identifier (`module.topic`).
 * @param {String} message human-readable; may interpolate, never parses.
 * @param {Object} [detail] structured data for filters and tooling.
 * @returns {{level: LogLevel, code: String, message: String, detail: Object, at: Number}}
 */
function record(level, code, message, detail) {
    return { level, code, message, detail: detail ?? {}, at: Date.now() }
}

/**
 * Emit one record through the sink.  The single emission point: a custom sink
 * replaces the console entirely (it decides what to do), which keeps "where
 * did this go" a one-answer question.
 *
 * @param {{level: LogLevel, code: String, message: String, detail: Object, at: Number}} rec
 */
function emit(rec) {
    const sink = config.log
    if (typeof sink === "function") {
        try {
            sink(rec)
            return
        } catch (err) {
            // A broken sink must not take the library down with it.  Fall back
            // to the console and say so through the console.
            console.error("DEER log: the configured config.log sink threw; falling back to the console.", err)
        }
    }
    const method = methodFor(rec.level)
    const prefix = `DEER ${rec.code}:`
    const hasDetail = Object.keys(rec.detail).length > 0
    if (hasDetail) { console[method](prefix, rec.message, rec.detail) }
    else { console[method](prefix, rec.message) }
}

/**
 * Emit at a level, gated.
 *
 * @param {LogLevel} level
 * @param {String} code
 * @param {String} message
 * @param {Object} [detail]
 * @returns {Boolean} whether the record was emitted — for callers that pair a
 * log with slower work (string building, object cloning) they can skip.
 */
function log(level, code, message, detail) {
    if (WEIGHTS[level] < gate()) { return false }
    emit(record(level, code, message, detail))
    return true
}

/** Advisory chatter for development; gated by config.DEBUG (default). */
export const debug = (code, message, detail) => log("debug", code, message, detail)

/** Notable events a running app may want to see; never a failure. */
export const info = (code, message, detail) => log("info", code, message, detail)

/** Something a developer should fix or know about; the shipped console.warn. */
export const warn = (code, message, detail) => log("warn", code, message, detail)

/** A failure DEER worked around or gave up on; the shipped console.error. */
export const error = (code, message, detail) => log("error", code, message, detail)

export { log }
