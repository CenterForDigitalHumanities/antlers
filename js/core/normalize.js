/**
 * @module normalize Value normalization for DEER-shaped objects.
 * @author Patrick Cuba <cubap@slu.edu>
 * @author Bryan Haberberger <bryan.j.haberberger@slu.edu>
 *
 * Ported from the 0.11 UTILS.getValue / UTILS.getLabel with one behavioral fix:
 * a failed type cast now throws to the caller instead of being swallowed by a
 * `finally { return … }`.
 */

/**
 * Dig the usable value out of a property that may be a primitive, an object
 * carrying a value-ish key, or an array of either.
 * @param {any} property the property value to normalize.
 * @param {Array<String>|String} alsoPeek additional keys to check for a nested value.
 * @param {String} [asType] optional cast: STRING | NUMBER | INTEGER | BOOLEAN.
 * @returns {any} the normalized value.
 */
export function getValue(property, alsoPeek = [], asType) {
    let prop
    if (property === undefined || property === "") {
        console.error("Value of property to lookup is missing!")
        return undefined
    }
    if (Array.isArray(property)) {
        // It is an array of things; the caller decides how to join or map them.
        return property
    }
    if (typeof property === "object") {
        // TODO: JSON-LD insists on "@value", but this is simplified in a lot
        // of contexts. Reading that is ideal in the future.
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
    if (asType) {
        try {
            switch (asType.toUpperCase()) {
                case "STRING":
                    prop = prop.toString()
                    break
                case "NUMBER":
                    prop = parseFloat(prop)
                    break
                case "INTEGER":
                    prop = parseInt(prop)
                    break
                case "BOOLEAN":
                    prop = !Boolean(["false", "no", "0", "", "undefined", "null"].indexOf(String(prop).toLowerCase().trim()))
                    break
                default:
            }
        } catch (err) {
            throw new Error(`asType: '${asType}' is not possible.\n${err.message}`)
        }
    }
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
