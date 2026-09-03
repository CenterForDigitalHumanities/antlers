/**
 * @module DeerOffline Offline cache, write queue, and sync for DEER
 * @author Patrick Cuba <cubap@slu.edu>
 * @version 0.11
 *
 * Provides a transparent offline mode for DEER:
 *  - A timestamped entity cache (IndexedDB) so previously-seen entities render
 *    without a network round trip.
 *  - A write outbox (IndexedDB) that queues CREATE/UPDATE/OVERWRITE operations
 *    while offline and replays them in order when connectivity returns.
 *  - Online/offline detection that broadcasts status events and stamps
 *    `data-deer-*` attributes on the document so applications can render state.
 *
 * This module is intentionally transport-agnostic: it stores the exact request
 * (method, url, body) that DEER would have sent, so replaying a queued write is
 * identical to performing it online.
 */

import { default as DEER } from './deer-config.js'

const DB_NAME = "deer-offline"
const DB_VERSION = 1
const CACHE_STORE = "entities"
const OUTBOX_STORE = "outbox"

let dbPromise = null

/**
 * Open (or reuse) the IndexedDB connection. IndexedDB is unavailable in some
 * contexts (private browsing, file://); callers must handle the rejection.
 * @returns {Promise<IDBDatabase>}
 */
function openDB() {
    if (dbPromise) { return dbPromise }
    dbPromise = new Promise((resolve, reject) => {
        if (typeof indexedDB === "undefined") {
            reject(new Error("IndexedDB is not available in this context."))
            return
        }
        const req = indexedDB.open(DB_NAME, DB_VERSION)
        req.onupgradeneeded = (event) => {
            const db = event.target.result
            if (!db.objectStoreNames.contains(CACHE_STORE)) {
                db.createObjectStore(CACHE_STORE, { keyPath: "id" })
            }
            if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
                db.createObjectStore(OUTBOX_STORE, { keyPath: "queueId", autoIncrement: true })
            }
        }
        req.onsuccess = (event) => resolve(event.target.result)
        req.onerror = (event) => reject(event.target.error || new Error("Failed to open IndexedDB."))
    })
    return dbPromise
}

/**
 * Run a single IndexedDB request as a promise.
 * @param {IDBObjectStore} store
 * @param {Function} op (store) => IDBRequest
 * @returns {Promise<*>}
 */
function requestAsPromise(store, op) {
    return new Promise((resolve, reject) => {
        const req = op(store)
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
    })
}

/**
 * Run a transaction that touches one store and resolves with the request result.
 * @param {String} storeName
 * @param {String} mode
 * @param {Function} op (store) => IDBRequest
 * @returns {Promise<*>}
 */
async function withStore(storeName, mode, op) {
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode)
        const store = tx.objectStore(storeName)
        const req = op(store)
        tx.oncomplete = () => resolve(req.result)
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
    })
}

const OFFLINE = {
    /**
     * True when the browser reports an active network connection.
     * @returns {Boolean}
     */
    isOnline: () => (typeof navigator !== "undefined") ? navigator.onLine : true,

    /**
     * Cache an entity (or annotation) locally, stamped with the time it was seen.
     * The cache key is the entity's `@id` or `id`. Entities without an id are ignored.
     * @param {Object} obj entity or annotation to cache.
     * @returns {Promise<Boolean>} true if cached, false if skipped or failed.
     */
    async cacheEntity(obj) {
        if (!obj) { return false }
        const id = obj["@id"] || obj.id
        if (!id) { return false }
        try {
            await withStore(CACHE_STORE, "readwrite", (store) => store.put({ id, entity: obj, cachedAt: Date.now() }))
            return true
        } catch (err) {
            console.warn("DEER could not cache entity " + id + " offline.", err)
            return false
        }
    },

    /**
     * Retrieve a cached entity and its staleness metadata.
     * @param {String} id URI of the entity.
     * @returns {Promise<{entity: Object, cachedAt: Number}|null>}
     */
    async getCachedEntity(id) {
        if (!id) { return null }
        try {
            const row = await withStore(CACHE_STORE, "readonly", (store) => store.get(id))
            if (!row) { return null }
            return { entity: row.entity, cachedAt: row.cachedAt }
        } catch (err) {
            console.warn("DEER could not read cached entity " + id + ".", err)
            return null
        }
    },

    /**
     * Queue a write operation for later sync. The op is stored exactly as it would
     * be sent online so replay is faithful.
     * @param {Object} op { method, url, body, targetId }
     * @returns {Promise<Number>} the queue entry id.
     */
    async queueWrite(op) {
        try {
            const queueId = await withStore(OUTBOX_STORE, "readwrite", (store) => store.add({
                method: op.method,
                url: op.url,
                body: op.body,
                targetId: op.targetId || null,
                status: "pending",
                enqueuedAt: Date.now()
            }))
            OFFLINE.broadcastQueued()
            return queueId
        } catch (err) {
            console.error("DEER could not queue an offline write.", err)
            return null
        }
    },

    /**
     * Attempt to perform a write online. Returns the parsed response on success,
     * or throws on network/HTTP failure so callers can decide to queue it.
     * @param {Object} op { method, url, body }
     * @returns {Promise<Object>} parsed response JSON.
     */
    async performWrite(op) {
        const response = await fetch(op.url, {
            method: op.method,
            headers: { "Content-Type": "application/json; charset=utf-8" },
            body: JSON.stringify(op.body)
        })
        if (!response.ok) {
            throw new Error("HTTP " + response.status + " " + response.statusText)
        }
        return response.json()
    },

    /**
     * Attempt a write, falling back to the offline queue when offline or when the
     * request fails. On success the resulting `new_obj_state` (if present) is
     * cached and returned.
     * @param {Object} op { method, url, body, targetId }
     * @returns {Promise<Object|null>} the `new_obj_state` from the write, or null if queued.
     */
    async writeOrQueue(op) {
        if (OFFLINE.isOnline()) {
            try {
                const result = await OFFLINE.performWrite(op)
                const state = result.new_obj_state || result
                if (state) { await OFFLINE.cacheEntity(state) }
                return state
            } catch (err) {
                // Network or HTTP failure while "online" — queue it and let sync retry.
                console.warn("DEER write failed; queueing for offline sync.", err)
            }
        }
        await OFFLINE.queueWrite(op)
        return null
    },

    /**
     * Replay all pending writes in enqueue order. Stops at the first failure so
     * ordering is preserved; failed entries are marked "error" and surfaced.
     * @returns {Promise<{synced: Number, failed: Number}>}
     */
    async sync() {
        if (!OFFLINE.isOnline()) { return { synced: 0, failed: 0 } }
        let pending
        try {
            const db = await openDB()
            pending = await new Promise((resolve, reject) => {
                const tx = db.transaction(OUTBOX_STORE, "readonly")
                const req = tx.objectStore(OUTBOX_STORE).getAll()
                req.onsuccess = () => resolve(req.result)
                req.onerror = () => reject(req.error)
            })
        } catch (err) {
            console.warn("DEER could not read the outbox to sync.", err)
            return { synced: 0, failed: 0 }
        }
        pending = (pending || []).filter(op => op.status === "pending").sort((a, b) => a.queueId - b.queueId)
        let synced = 0
        let failed = 0
        for (const op of pending) {
            try {
                const result = await OFFLINE.performWrite({ method: op.method, url: op.url, body: op.body })
                const state = result.new_obj_state || result
                if (state) { await OFFLINE.cacheEntity(state) }
                await OFFLINE.markSynced(op.queueId)
                synced++
            } catch (err) {
                failed++
                await OFFLINE.markError(op.queueId, err.message)
                console.error("DEER failed to sync queued write " + op.queueId + "; stopping to preserve order.", err)
                break
            }
        }
        if (synced > 0) { OFFLINE.broadcastSynced(synced) }
        return { synced, failed }
    },

    /**
     * Mark a queued write as synced.
     * @param {Number} queueId
     */
    async markSynced(queueId) {
        try {
            await withStore(OUTBOX_STORE, "readwrite", (store) => {
                const getReq = store.get(queueId)
                getReq.onsuccess = () => {
                    const op = getReq.result
                    if (op) { op.status = "synced"; op.syncedAt = Date.now(); store.put(op) }
                }
                return getReq
            })
        } catch (err) {
            console.warn("DEER could not mark write " + queueId + " as synced.", err)
        }
    },

    /**
     * Mark a queued write as errored, recording the failure reason.
     * @param {Number} queueId
     * @param {String} reason
     */
    async markError(queueId, reason) {
        try {
            await withStore(OUTBOX_STORE, "readwrite", (store) => {
                const getReq = store.get(queueId)
                getReq.onsuccess = () => {
                    const op = getReq.result
                    if (op) { op.status = "error"; op.error = reason; store.put(op) }
                }
                return getReq
            })
        } catch (err) {
            console.warn("DEER could not mark write " + queueId + " as errored.", err)
        }
    },

    /**
     * Count pending writes so the UI can show how much is queued.
     * @returns {Promise<Number>}
     */
    async pendingCount() {
        try {
            const db = await openDB()
            return await new Promise((resolve, reject) => {
                const tx = db.transaction(OUTBOX_STORE, "readonly")
                const req = tx.objectStore(OUTBOX_STORE).getAll()
                req.onsuccess = () => resolve((req.result || []).filter(op => op.status === "pending").length)
                req.onerror = () => reject(req.error)
            })
        } catch (err) {
            return 0
        }
    },

    /**
     * Stamp the document with the current connectivity state and broadcast an event.
     * @param {Boolean} online
     */
    broadcastStatus(online) {
        if (typeof document !== "undefined") {
            document.documentElement.setAttribute("data-deer-online", online ? "true" : "false")
        }
        OFFLINE._dispatch(online ? DEER.EVENTS.ONLINE : DEER.EVENTS.OFFLINE, { online })
    },

    /**
     * Broadcast that a write was queued while offline.
     */
    broadcastQueued() {
        const pending = OFFLINE.pendingCount()
        pending.then(count => OFFLINE._dispatch(DEER.EVENTS.QUEUED, { pending }))
    },

    /**
     * Broadcast that queued writes were synced.
     * @param {Number} synced number of writes synced.
     */
    broadcastSynced(synced) {
        OFFLINE._dispatch(DEER.EVENTS.SYNCED, { synced })
    },

    /**
     * Stamp an element as stale (rendered from cache while offline) and broadcast.
     * @param {Element} elem
     * @param {Number} cachedAt epoch ms the cached entity was last seen.
     */
    markStale(elem, cachedAt) {
        if (!elem) { return }
        elem.setAttribute("data-deer-stale", "true")
        if (cachedAt) { elem.setAttribute("data-deer-cached-at", String(cachedAt)) }
        OFFLINE._dispatch(DEER.EVENTS.STALE, { cachedAt, target: elem })
    },

    /**
     * Internal: dispatch a CustomEvent on the document root.
     * @param {String} type
     * @param {Object} detail
     */
    _dispatch(type, detail) {
        if (typeof document === "undefined") { return }
        document.dispatchEvent(new CustomEvent(type, { detail, bubbles: true }))
    },

    /**
     * Wire up online/offline listeners and trigger an initial sync. Call once at
     * startup. Safe to call more than once (listeners are idempotent via a flag).
     */
    init() {
        if (typeof window === "undefined" || OFFLINE._initialized) { return }
        OFFLINE._initialized = true
        OFFLINE.broadcastStatus(OFFLINE.isOnline())
        window.addEventListener("online", () => {
            OFFLINE.broadcastStatus(true)
            OFFLINE.sync()
        })
        window.addEventListener("offline", () => {
            OFFLINE.broadcastStatus(false)
        })
        // Attempt an initial sync in case writes were queued in a prior session.
        OFFLINE.sync()
    }
}

OFFLINE._initialized = false

export default OFFLINE
