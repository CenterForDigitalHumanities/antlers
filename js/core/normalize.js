/**
 * @module normalize Value normalization for DEER-shaped objects.
 * @author Patrick Cuba <cubap@slu.edu>
 * @author Bryan Haberberger <bryan.j.haberberger@slu.edu>
 *
 * Ported from the 0.11 UTILS.getValue / UTILS.getLabel.
 */

import config from './config.js'

/**
 * Apply a requested cast to a single value.
 *
 * @param {any} prop the value to cast.
 * @param {String} asType STRING | NUMBER | INTEGER | BOOLEAN.  Anything else is a no-op.
 * @returns {any} the cast value.
 * @throws {Error} when the cast is not possible for this value.
 */
function castValue(prop, asType) {
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
                cast = parseInt(prop, 10)
                break
            case "BOOLEAN":
                return !["false", "no", "0", "", "undefined", "null"].includes(String(prop).toLowerCase().trim())
            default:
                return prop
        }
    } catch (err) {
        throw new Error(`asType: '${asType}' is not possible.\n${err.message}`)
    }
    if (Number.isNaN(cast)) {
        throw new Error(`asType: '${asType}' is not possible for ${JSON.stringify(prop)}.`)
    }
    return cast
}

/**
 * Dig the usable value out of a property that may be a primitive, an object
 * carrying a value-ish key, or an array of either.
 *
 * @param {any} property the property value to normalize.
 * @param {Array<String>|String} alsoPeek additional keys to check for a nested value.
 * @param {String} [asType] optional cast: STRING | NUMBER | INTEGER | BOOLEAN.
 * @returns {any} the normalized value.  Arrayness is PRESERVED: an array in
 * yields an array out, each member normalized (peeked, and cast when asked)
 * by this same function, and a peeked one-member array stays a one-member
 * array.  The member rule does not depend on whether a cast was requested —
 * a return SHAPE that changed with `asType` was an accident waiting for
 * template bindings.
 *
 * An empty string is a VALUE, not a missing one — a field a user deliberately
 * cleared reads back as "".  0.11 returned undefined for it here while
 * buildValueObject preserved it, so a cleared field survived shaping and then
 * vanished the moment a template binding normalized it.  Only null and
 * undefined are missing.
 */
export function getValue(property, alsoPeek = [], asType) {
    let prop
    if (property === undefined || property === null) {
        if (config.DEBUG) { console.warn("Value of property to lookup is missing!") }
        return undefined
    }
    if (Array.isArray(property)) {
        return property.map(p => getValue(p, alsoPeek, asType))
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
    return prop
}

/**
 * Attempt to discover a readable label from the object.
 *
 * Nullish coalescing throughout, not `||`: a label of 0 or "" is a label
 * someone chose.  `||` reported both as unlabeled, which is the same falsy-vs-
 * missing confusion getValue carried for the empty string.
 *
 * @param {any} obj the object to label.
 * @param {String} noLabel fallback when no label is discoverable.
 * @param {Object} options `options.label` names a preferred label property.
 * @returns {any} the discovered label or the fallback.
 */
export function getLabel(obj, noLabel = "[ unlabeled ]", options = {}) {
    if (obj === undefined || obj === null) { return noLabel }
    if (typeof obj === "string") { return obj }
    let label = obj[options.label] ?? obj.name ?? obj.label ?? obj.title
    if (Array.isArray(label)) {
        label = [...new Set(label.map(l => getValue(l)))]
        return label.length ? label : noLabel
    }
    if (label !== null && typeof label === "object") {
        label = getValue(label)
    }
    return label ?? noLabel
}
