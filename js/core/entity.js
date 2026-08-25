/**
 * @module entity Reactive Entity/Annotation objects and render coordination.
 * @author Patrick Cuba <cubap@slu.edu>
 * @author Bryan Haberberger <bryan.j.haberberger@slu.edu>
 *
 * Ported from releases/rc-1.0/js/entities.js with the fixes that killed rc-1.0:
 * objectMatch is defined here (rc-1.0 exported an undefined binding), the
 * worker branches are gone (server-side expansion removed the worker's reason
 * to exist), and Entity extends EventTarget so announcements dispatch on the
 * instance instead of a document shim.  All network traffic delegates to
 * ./rerum.js.
 *
 * EntityMap is render coordination, not a data cache: an identity map keyed by
 * the canonical (https) id form plus one in-flight resolution promise per id,
 * so two consumers of the same deer-id share one object and one fetch (the
 * core-level deer#96 fix) — whichever protocol form each arrived with.  The
 * browser HTTP cache is the only data cache.
 */

import config from './config.js'
import * as rerum from './rerum.js'
import { applyAssertions, isAnnotationType } from './assertions.js'

const EntityMap = new Map()
const inFlight = new Map()

/**
 * Deep-compare two plain values for structural equality.
 * Lifted from rc-1.0's UTILS.objectMatch — the implementation its entities.js
 * exported without ever defining.
 * @param {Object} o1 first value.
 * @param {Object} o2 second value.
 * @returns {Boolean} whether the two match key-for-key.
 */
function objectMatch(o1 = {}, o2 = {}) {
    const keys1 = Object.keys(o1)
    const keys2 = Object.keys(o2)
    if (keys1.length !== keys2.length) { return false }
    for (const k of keys1) {
        const val1 = o1[k]
        const val2 = o2[k]
        const recurseNeeded = isObject(val1) && isObject(val2)
        if ((recurseNeeded && !objectMatch(val1, val2))
            || (!recurseNeeded && val1 !== val2)) {
            return false
        }
    }
    return true
    function isObject(object) {
        return object != null && typeof object === 'object'
    }
}

/**
 * Protocol-insensitive id comparison — RERUM records ids with whichever
 * protocol the writing proxy sent.
 */
function sameId(a, b) {
    if (typeof a !== "string" || typeof b !== "string") { return false }
    return rerum.canonicalId(a) === rerum.canonicalId(b)
}

/**
 * The shared way to obtain an Entity: returns the one already coordinating a
 * given id, or constructs (and begins resolving) a new one.
 * @param {String|Object} id the entity URI or an object carrying one.
 * @param {Object} options `lazy: true` resolves the URI without the compound annotation query.
 * @returns {Entity}
 */
function getEntity(id, { lazy = false } = {}) {
    const key = rerum.canonicalId((typeof id === "string") ? id : id?.["@id"] ?? id?.id)
    if (EntityMap.has(key)) { return EntityMap.get(key) }
    return new Entity((typeof id === "string") ? { id } : id, lazy)
}

/**
 * Drop all coordination state.  For teardown and tests only — live subscribers
 * keep their Entity references but new consumers will re-resolve.
 */
function clearEntities() {
    EntityMap.clear()
    inFlight.clear()
}

/**
 * An object described by the documents related to the URI recorded in the
 * `deer-id` attribute.  Constructing one begins resolving it; subscribers
 * listen on the instance for `update`, `reload`, `complete`, and `error`.
 * @class
 */
class Entity extends EventTarget {
    #isLazy

    /**
     * @param {Object|String} entity object to be described (usually from a JSON-LD
     * document), a JSON string of one, or a bare URI string.
     * @param {Boolean} isLazy true if the compound annotation query should not be made.
     */
    constructor(entity = {}, isLazy) {
        super()
        // accommodate Entity(String) and Entity(Object) or Entity(JSONString)
        if (typeof entity === "string") {
            try {
                entity = JSON.parse(entity)
            } catch (e) {
                entity = { id: entity }
            }
        }
        const id = entity.id ?? entity["@id"] // id is primary key
        if (typeof id !== "string" || id.length === 0) { throw new Error("Entity must have an id") }
        if (EntityMap.has(rerum.canonicalId(id))) { throw new Error(`Entity ${id} already exists. Use getEntity() to share it.`) }
        this.Annotations = new Map()
        this.#isLazy = Boolean(isLazy)
        this.data = entity
    }

    get assertions() {
        return applyAssertions(this.data, [...this.Annotations.values()].map(a => a.data))
    }

    get data() {
        return this._data
    }

    get id() {
        return this.data.id
    }

    set data(entity) {
        // Adopt a shallow copy so the caller's object is never mutated.
        const candidate = { ...entity, id: entity.id ?? entity["@id"] } // id is primary key
        if (objectMatch(this._data, candidate)) {
            // no-op suppression: identical data must not re-announce (render loop guard)
            return
        }
        const oldId = this._data?.id
        this._data = candidate
        EntityMap.set(rerum.canonicalId(this.id), this)
        this.#announce("update", this.assertions)
        if (!sameId(oldId, this.id)) {
            this.resolve().then(() => this.#announce("reload", this))
        }
    }

    attachAnnotation(annotation) {
        if (annotation.id === undefined || annotation.id === null) { return }
        this.Annotations.set(annotation.id, annotation)
    }

    /**
     * Resolve this entity's URI (and, unless lazy, its targeting annotations).
     * Concurrent calls for the same id share one in-flight promise — two
     * consumers of the same deer-id cost one fetch.
     * @param {Object} options `fresh: true` busts the HTTP cache (read-after-write).
     * @returns {Promise<void>} settles when resolution has been applied.
     */
    resolve({ fresh = false } = {}) {
        const key = rerum.canonicalId(this.id)
        const pending = inFlight.get(key)
        // A pending non-fresh resolution cannot satisfy a fresh request —
        // read-after-write must never be served a stale in-flight promise.
        if (pending && (pending.fresh || !fresh)) { return pending.promise }
        const promise = this.#resolveURI(!this.#isLazy, fresh)
            .finally(() => { if (inFlight.get(key)?.promise === promise) { inFlight.delete(key) } })
        inFlight.set(key, { promise, fresh })
        return promise
    }

    #findAssertions = async (assertions) => {
        try {
            const finds = Array.isArray(assertions) ? assertions : await rerum.findByTargetId(this.id)
            const annotations = finds
                .filter(a => isAnnotationType(a.type ?? a['@type']))
                .map(anno => new Annotation(anno))
            if (annotations.length) { this.#announce("update", this.assertions) }
            this.#announce("complete")
        } catch (err) {
            this.#announce("error", err)
        }
    }

    #resolveURI = async (withAssertions, fresh) => {
        try {
            if (withAssertions) {
                // One round trip: the entity document and its targeting annotations
                // come back together from a single $or query.
                const uris = rerum.httpsIdArray(this.id)
                const obj = {
                    "$or": [{ "@id": uris }, { "target": uris }, { "target.@id": uris }, { "target.id": uris }],
                    "__rerum.history.next": { "$exists": true, "$size": 0 }
                }
                const finds = await rerum.query(obj, { fresh })
                const list = Array.isArray(finds) ? finds : []
                if (list.length >= config.LIMIT) {
                    console.warn(`Compound query for ${this.id} returned ${list.length} documents (limit ${config.LIMIT}) — annotations beyond the limit are not merged.`)
                }
                // The leaf filter excludes an entity that has since been updated,
                // and a full page can crowd the entity document out entirely —
                // recover it with a direct GET (which 404s if it truly is absent).
                this.data = list.find(e => sameId(e["@id"], this.id))
                    ?? await rerum.resolve(this.id, { fresh })
                await this.#findAssertions(list.filter(e => !sameId(e["@id"], this.id)))
            } else {
                this.data = await rerum.resolve(this.id, { fresh })
                await this.#findAssertions()
            }
        } catch (err) {
            this.#announce("error", err)
        }
    }

    #announce = (action, payload) => {
        this.dispatchEvent(new CustomEvent(action, {
            detail: {
                action,
                id: this.id,
                payload
            }
        }))
    }
}

/**
 * An object describing a document related to the URI it targets.  Constructing
 * one attaches it to every Entity it targets (self-wiring).
 * @class
 */
class Annotation {
    /**
     * @param {Object} annotation document asserting a value or relationship.
     */
    constructor(annotation) {
        this.data = annotation
        this.#registerTargets()
    }

    get id() {
        return this.data["@id"] ?? this.data.id // id is primary key
    }

    #registerTargets = () => {
        let targets = this.data.target
        if (!Array.isArray(targets)) { targets = [targets] }
        for (let target of targets) {
            if (!target) { continue }
            target = target.id ?? target["@id"] ?? ((typeof target === "string") ? target : undefined)
            if (!target) { continue }
            getEntity(target, { lazy: true }).attachAnnotation(this)
        }
    }
}

export { EntityMap, Entity, Annotation, objectMatch, getEntity, clearEntities }
