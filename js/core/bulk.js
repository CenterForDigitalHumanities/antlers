/**
 * @module bulk Bulk operations over the single-document verbs.
 * @author Patrick Cuba <cubap@slu.edu>
 *
 * Antlers#6: deleting an entity and all its annotations, discarding a list of
 * Things, or annotating a selection together are common research-data tasks,
 * and none fit the one-document verbs.
 *
 * The TinyNode proxy DEER writes through has no bulk routes (bulkCreate and
 * bulkUpdate exist only behind the direct-store auth DEER does not hold), so
 * these are client-side fan-out over the SAME transport the singles use —
 * bounded concurrency so a large batch does not open one socket per item,
 * per-item results so a partial failure never hides what succeeded.
 *
 * Every operation reports BOTH ways:
 *  - the returned record carries per-item outcomes for tooling;
 *  - a rejected promise says the batch itself was malformed (empty, or items
 *    that failed BEFORE any network left, e.g. an id outside the write
 *    boundary).  The network's own failures are results, not rejections —
 *    a 400-item delete with one 404 is 399 deletions and 1 result, not a
 *    broken promise.
 */

import * as rerum from './rerum.js'
import { queryAll, targetingClauses } from './expand.js'
import * as logger from './log.js'

/**
 * The per-item outcome shape shared by every bulk operation.
 *
 * @typedef {Object} BulkItemResult
 * @property {URI} id the item's URI.
 * @property {Boolean} ok whether the operation succeeded.
 * @property {RerumDocument} [value] the written/deleted/read document on success.
 * @property {Error} [error] the failure on a failed item, carrying `status`
 * when the server refused.
 */

/**
 * The batch outcome shape shared by every bulk operation.
 *
 * @typedef {Object} BulkReport
 * @property {BulkItemResult[]} results per-item outcomes, in input order.
 * @property {Number} succeeded how many items succeeded.
 * @property {Number} failed how many items failed.
 * @property {Boolean} ok true only when every item succeeded — the one-bit
 * answer a caller that does not care about the receipt wants.
 */

/**
 * Run an async operation over items with bounded concurrency.
 *
 * Order of RESULTS follows the input, not completion — a receipt must line up
 * with what was asked for.  Concurrency is the flush of the wave, not a
 * promise: a failure does not stop siblings (unlike the offline queue, these
 * items are independent documents).
 *
 * @param {Array} items anything, in input order.
 * @param {Function} op async (item, index) => value; may throw.
 * @param {Number} [limit] max in-flight operations; default 6, tuned for a
 * browser's per-host connection pool rather than a benchmark.
 * @returns {Promise<BulkItemResult[]>} one result per item, input order.
 */
async function fanOut(items, op, limit = 6) {
    const results = new Array(items.length)
    let cursor = 0
    const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
        while (cursor < items.length) {
            const index = cursor++
            const item = items[index]
            try {
                results[index] = { id: idOfItem(item), ok: true, value: await op(item, index) }
            } catch (err) {
                results[index] = { id: idOfItem(item) ?? `(item ${index})`, ok: false, error: err }
            }
        }
    })
    await Promise.all(workers)
    return results
}

/** An item's URI whether it came in as a string, a document, or an options bag. */
const idOfItem = (item) => {
    try { return rerum.canonicalId(rerum.idOf(item?.id ?? item)) }
    catch { return undefined }
}

/** Fold outcomes into the shared report shape. */
const report = (results) => {
    const failed = results.filter(r => !r.ok)
    return {
        results,
        succeeded: results.length - failed.length,
        failed: failed.length,
        ok: failed.length === 0
    }
}

/**
 * Delete a list of documents.  Independent documents: one item's failure does
 * not stop the rest.
 *
 * @param {Array<String|Object>} ids document URIs, or documents carrying one.
 * @returns {Promise<BulkReport>} the receipt.
 * @throws {Error} when `ids` is empty — a delete of nothing is a caller bug.
 */
export async function deleteAll(ids) {
    const items = (Array.isArray(ids) ? ids : [ids]).flat()
    if (items.length === 0) { throw new Error("deleteAll() takes at least one id.") }
    const results = await fanOut(items, id => rerum.delete(id))
    return report(results)
}

/**
 * Delete an entity AND every annotation targeting it — #6's named chore: a
 * record and its description die together, or the annotations outlive their
 * target as garbage.  The annotations are gathered leaf-first across every
 * generator (deleting a leaf is what removes the assertion; a superseded
 * version becomes live again on delete, which is RERUM's healing, not ours to
 * fight here).
 *
 * The entity is deleted LAST: reversed order would let a concurrent writer
 * re-annotate a dead record between the two steps.
 *
 * "Deleted" is RERUM's tombstone sense: a deleted document still answers GET
 * with `__deleted` and no assertion content.  A superseded version of a
 * deleted annotation becomes live again — RERUM heals the chain — so a
 * cascade deletes the LEAF, and a version the leaf superseded must be
 * cascaded separately if the whole assertion history should die.
 *
 * @param {String|Object} id the entity URI, or a document carrying one.
 * @param {Object} [options]
 * @param {Boolean} [options.includeAliases=false] also gather annotations
 * targeting the entity's other URIs (its RERUM Slug), which requires reading
 * the entity before deleting it.
 * @returns {Promise<BulkReport>} the receipt.  The entity is `results[0]`.
 * @throws {TypeError} when the id is not RERUM-hosted — annotations are only
 * queryable for RERUM entities, so a foreign id has nothing to cascade.
 */export async function deleteWithAnnotations(id, { includeAliases = false } = {}) {
    const uri = rerum.idOf(id)
    if (!rerum.isRerumId(uri)) {
        throw new TypeError(`${uri} is not hosted by RERUM, so its annotations cannot be gathered for a cascade delete. Use rerum.delete() directly for a foreign document.`)
    }
    let uris = [uri]
    if (includeAliases) {
        const entity = await rerum.resolve(uri).catch(() => null)
        const slug = rerum.slugUriOf(entity ?? {})
        if (typeof slug === "string") { uris = [uri, slug] }
    }
    // Leaf annotations from EVERY generator: a cascade is housekeeping, not
    // display, so read scopes do not apply.
    const targeting = { "$and": [
        { "$or": uris.flatMap(u => targetingClauses(u)) },
        { "__rerum.history.next": [] }
    ] }
    const annos = await queryAll(targeting, `${uri} cascade`)
    const annoIds = annos.map(a => a["@id"] ?? a.id).filter(Boolean)
    const annoResults = annoIds.length
        ? await fanOut(annoIds, annoId => rerum.delete(annoId))
        : []
    const entityResult = await (async () => {
        try {
            await rerum.delete(uri)
            return { id: rerum.canonicalId(uri), ok: true, value: undefined }
        } catch (err) {
            return { id: rerum.canonicalId(uri), ok: false, error: err }
        }
    })()
    const results = [entityResult, ...annoResults]
    logger.info("bulk.cascade-delete",
        `Deleted ${results.filter(r => r.ok).length - (entityResult.ok ? 1 : 0)} of ${annoIds.length} annotations and ${entityResult.ok ? "the entity" : "FAILED the entity"}.`,
        { uri, annotations: annoIds.length, reports: results })
    return report(results)
}

/**
 * Create one annotation for EACH of a list of entities — #6's "tagging or
 * selecting a bunch of things together": one body, many targets, the same
 * one-document writes DEER always makes (n Annotations, not one n-target
 * Annotation, because RERUM's expansion and DEER's merge both treat the
 * single-target Annotation as the unit of update).
 *
 * @param {Array<String|Object>} targets entity URIs, or documents carrying one.
 * @param {Object} annotation the annotation template: `body` (or
 * `bodyValue`), and optionally `creator`, `motivation`, `evidence` — each
 * merged into every created annotation.  `target` is supplied per item and
 * anything supplied here is overwritten.
 * @returns {Promise<BulkReport>} the receipt; each `value` is the created
 * annotation.
 * @throws {Error} when `targets` is empty or `annotation` carries no body.
 */
export async function annotateAll(targets, annotation = {}) {
    const items = (Array.isArray(targets) ? targets : [targets]).flat()
    if (items.length === 0) { throw new Error("annotateAll() takes at least one target.") }
    const template = { ...annotation }
    if (template.body === undefined && template.bodyValue === undefined) {
        throw new Error("annotateAll() takes an annotation carrying a `body` or `bodyValue`.")
    }
    delete template.target
    const results = await fanOut(items, async target => {
        const uri = rerum.idOf(target)
        return rerum.create({ type: "Annotation", ...template, target: uri })
    })
    return report(results)
}

/**
 * Update one at a time with the same concurrent flush as the other bulk
 * operations.  Each item must know its own `@id` — the natural input is a
 * list of already-updated documents.
 *
 * @param {Array<Object>} documents documents carrying the `@id` to update.
 * @returns {Promise<BulkReport>} the receipt; each `value` is the new version.
 */
export async function updateAll(documents) {
    const items = (Array.isArray(documents) ? documents : [documents]).flat()
    if (items.length === 0) { throw new Error("updateAll() takes at least one document.") }
    const results = await fanOut(items, doc => rerum.update(doc))
    return report(results)
}

/**
 * Overwrite one at a time with the same concurrent flush as the other bulk
 * operations.  As with the single overwrite: the document is replaced in
 * place, no new version.
 *
 * @param {Array<Object>} documents documents carrying the `@id` to overwrite.
 * @returns {Promise<BulkReport>} the receipt; each `value` is the new state.
 */
export async function overwriteAll(documents) {
    const items = (Array.isArray(documents) ? documents : [documents]).flat()
    if (items.length === 0) { throw new Error("overwriteAll() takes at least one document.") }
    const results = await fanOut(items, doc => rerum.overwrite(doc))
    return report(results)
}
