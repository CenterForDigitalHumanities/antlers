import test from 'node:test'
import assert from 'node:assert/strict'
import config from '../../js/core/config.js'
import * as rerum from '../../js/core/rerum.js'
import { getEntity, Entity, Annotation, EntityMap, clearEntities, objectMatch } from '../../js/core/entity.js'
import { fixture, stubFetch, withConfig, ADA } from './helpers.js'

const entityDoc = await fixture('ada-entity')
const annotationDocs = await fixture('ada-annotations')

/** Serve the compound $or query with the entity doc and its annotations together. */
function compoundRouter() {
    return stubFetch((url, options) => {
        if (url.startsWith(config.URLS.QUERY) && options.method === "POST") {
            return [entityDoc, ...annotationDocs]
        }
    })
}

test('objectMatch compares deeply', () => {
    assert.equal(objectMatch({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 2 } }), true)
    assert.equal(objectMatch({ a: 1 }, { a: 2 }), false)
    assert.equal(objectMatch({ a: 1 }, { a: 1, b: 2 }), false)
    assert.equal(objectMatch(undefined, undefined), true)
})

test('two consumers of one id share one Entity and one fetch (deer#96)', async () => {
    clearEntities()
    const stub = compoundRouter()
    await withConfig({ fetch: stub }, async () => {
        const first = getEntity(ADA)
        const second = getEntity(ADA)
        assert.equal(first, second)
        await Promise.all([first.resolve(), second.resolve()])
        assert.equal(stub.calls.length, 1)
        assert.equal(first.Annotations.size, 10)
    })
})

test('resolution merges assertions with provenance intact', async () => {
    clearEntities()
    await withConfig({ fetch: compoundRouter() }, async () => {
        const ada = getEntity(ADA)
        await ada.resolve()
        const merged = ada.assertions
        assert.equal(merged.description.value, "Test entity created by the antlers 2.0 test bench.")
        assert.equal(merged.description.source.citationSource, "https://devstore.rerum.io/v1/id/6a8deb57e339d7e147aaaf5b")
        assert.equal(merged["@id"], ADA)
    })
})

test('Entity announces update, reload, and data no-ops are suppressed', async () => {
    clearEntities()
    await withConfig({ fetch: compoundRouter() }, async () => {
        const ada = getEntity(ADA)
        const seen = []
        for (const type of ["update", "reload", "complete", "error"]) {
            ada.addEventListener(type, e => seen.push(e.detail.action))
        }
        await ada.resolve()
        assert.ok(seen.includes("update"), `expected an update in ${seen}`)
        assert.ok(seen.includes("reload"), `expected a reload in ${seen}`)
        assert.ok(!seen.includes("error"), `unexpected error in ${seen}`)

        const count = seen.length
        ada.data = structuredClone(ada.data) // identical data — must not re-announce
        assert.equal(seen.length, count)
    })
})

test('constructing a duplicate Entity throws; getEntity() is the shared door', async () => {
    clearEntities()
    await withConfig({ fetch: compoundRouter() }, async () => {
        const ada = getEntity(ADA)
        await ada.resolve()
        assert.throws(() => new Entity({ id: ADA }), /already exists/)
        assert.equal(EntityMap.get(ADA), ada)
    })
})

test('a new Annotation self-wires onto the Entity it targets', async () => {
    clearEntities()
    await withConfig({ fetch: compoundRouter() }, async () => {
        const ada = getEntity(ADA)
        await ada.resolve()
        const anno = new Annotation({
            "@id": "https://example.org/anno/local",
            type: "Annotation",
            target: ADA,
            creator: "ANTLERS_2_0_TEST_AGENT",
            body: { nickname: { value: "Countess of Lovelace" } }
        })
        assert.equal(ada.Annotations.get("https://example.org/anno/local"), anno)
        assert.equal(ada.assertions.nickname.value, "Countess of Lovelace")
    })
})

test('an empty resolution announces error with a 404', async () => {
    clearEntities()
    const stub = stubFetch((url, options) => {
        if (url.startsWith(config.URLS.QUERY)) { return [] }
    })
    await withConfig({ fetch: stub }, async () => {
        const ghost = getEntity("https://devstore.rerum.io/v1/id/000000000000000000000000")
        const errors = []
        ghost.addEventListener("error", e => errors.push(e.detail.payload))
        await ghost.resolve()
        assert.equal(errors.length, 1)
        assert.equal(errors[0].status, 404)
    })
})

test('a lazy Entity resolves the URI without the compound query', async () => {
    clearEntities()
    const stub = stubFetch((url, options) => {
        if (url === ADA && !options.method) { return entityDoc }
        if (url.startsWith(config.URLS.QUERY)) { return annotationDocs }
    })
    await withConfig({ fetch: stub }, async () => {
        const ada = getEntity(ADA, { lazy: true })
        await ada.resolve()
        // lazy = plain GET of the URI, then the targeted-annotation query
        assert.equal(stub.calls[0].url, ADA)
        assert.equal(stub.calls[0].options.method, undefined)
        assert.equal(ada.Annotations.size, 10)
    })
})
