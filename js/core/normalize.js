/**
 * @module normalize Value normalization for DEER-shaped objects.
 * @author Patrick Cuba <cubap@slu.edu>
 * @author Bryan Haberberger <bryan.j.haberberger@slu.edu>
 *
 * Ported from the 0.11 UTILS.getValue / UTILS.getLabel with four behavioral
 * fixes: a failed type cast now throws to the caller instead of being swallowed
 * by a `finally { return … }` — including the NaN that parseFloat/parseInt
 * return in place of throwing — null input is treated as missing instead of
 * crashing the peek loop, the BOOLEAN cast is no longer inverted, and `asType`
 * is applied to every member of an array instead of being skipped entirely.
 */

import config from './config.js'

/**
 * Apply a requested cast to a single value.
 * @param {any} prop the value to cast.
 * @param {String} asType STRING | NUMBER | INTEGER | BOOLEAN.  Anything else is a no-op.
 * @returns {any} the cast value.
 * @throws {Error} when the cast is not possible for this value.
 */
function castValue(prop, asType) {
    // Guarded above the try, not inside it: asType.toUpperCase() on a non-string
    // throws, the catch rewrites it as "asType: '1' is not possible", and the
    // real problem — the caller passed something that is not a cast name — ends
    // up on a second line underneath a message that hides it.
    if (typeof asType !== "string") {
        throw new TypeError(`asType must be a string (STRING | NUMBER | INTEGER | BOOLEAN), got ${typeof asType}.`)
    }
    let cast
    try {
        switch (asType.toUpperCase()) {
            case "STRING":
                return prop.toString()
            case "NUMBER":
                cast = parseFloat(prop)
                break
            case "INTEGER":
                cast = parseInt(prop)
                break
            case "BOOLEAN":
                return !["false", "no", "0", "", "undefined", "null"].includes(String(prop).toLowerCase().trim())
            default:
                return prop
        }
    } catch (err) {
        throw new Error(`asType: '${asType}' is not possible.\n${err.message}`)
    }
    // parseFloat/parseInt report failure by RETURNING NaN rather than throwing,
    // so the catch above never sees it and a NaN would flow out to whatever
    // renders it.  A requested cast that cannot be performed is an error like
    // any other.  Checked out here, not inside the try, so the message is the
    // plain one rather than the catch's wrapped rewrite of it.
    if (Number.isNaN(cast)) {
        throw new Error(`asType: '${asType}' is not possible for ${JSON.stringify(prop)}.`)
    }
    return cast
}

/**
 * Dig the usable value out of a property that may be a primitive, an object
 * carrying a value-ish key, or an array of either.
 * @param {any} property the property value to normalize.
 * @param {Array<String>|String} alsoPeek additional keys to check for a nested value.
 * @param {String} [asType] optional cast: STRING | NUMBER | INTEGER | BOOLEAN.
 * @returns {any} the normalized value.  An array in yields an array out, with
 * the cast applied member by member.
 */
export function getValue(property, alsoPeek = [], asType) {
    let prop
    if (property === undefined || property === null || property === "") {
        if (config.DEBUG) { console.warn("Value of property to lookup is missing!") }
        return undefined
    }
    if (Array.isArray(property)) {
        // It is an array of things; the caller decides how to join or map them.
        // A requested cast applies to each member — 0.11 returned here before
        // reaching the cast at all, so getValue(["3","4"], [], "NUMBER") came
        // back as strings and silently defeated the caller's request.
        return asType ? property.map(p => castValue(p, asType)) : property
    }
    if (typeof property === "object") {
        // JSON-LD insists on "@value", but the wild data this consumes
        // simplifies it many different ways — hence the peek list.
        if (!Array.isArray(alsoPeek)) { alsoPeek = [alsoPeek] }
        alsoPeek = alsoPeek.concat(["@value", "value", "$value", "val"])
        for (const k of alsoPeek) {
            if (Object.hasOwn(property, k)) {
                prop = property[k]
                break
            }
            prop = property
        }
    } else {
        prop = property
    }
    if (asType) { prop = castValue(prop, asType) }
    return (prop?.length === 1) ? prop[0] : prop
}

/**
 * Attempt to discover a readable label from the object.
 * @param {any} obj the object to label.
 * @param {String} noLabel fallback when no label is discoverable.
 * @param {Object} options `options.label` names a preferred label property.
 * @returns {any} the discovered label or the fallback.
 */
export function getLabel(obj, noLabel = "[ unlabeled ]", options = {}) {
    if (obj === undefined || obj === null) { return noLabel }
    if (typeof obj === "string") { return obj }
    let label = obj[options.label] || obj.name || obj.label || obj.title
    if (Array.isArray(label)) {
        label = [...new Set(label.map(l => getValue(l)))]
    }
    if (typeof label === "object") {
        label = getValue(label)
    }
    return label || noLabel
}
