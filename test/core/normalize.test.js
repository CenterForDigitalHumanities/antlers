import test from 'node:test'
import assert from 'node:assert/strict'
import { getValue, getLabel } from '../../js/core/normalize.js'

test('getValue returns primitives as-is', () => {
    assert.equal(getValue("Ada"), "Ada")
    assert.equal(getValue(42), 42)
})

test('getValue peeks value-ish keys on objects', () => {
    assert.equal(getValue({ value: "Ada" }), "Ada")
    assert.equal(getValue({ "@value": "Ada" }), "Ada")
    assert.equal(getValue({ other: 1, val: "x" }), "x")
})

test('getValue prefers a caller-supplied peek key', () => {
    assert.equal(getValue({ items: "i", value: "v" }, ["items"]), "i")
    assert.equal(getValue({ items: "i", value: "v" }, "items"), "i")
})

test('getValue returns the object untouched when no peek key hits', () => {
    const container = { "@type": "Set", items: ["a", "b"] }
    assert.deepEqual(getValue(container), container)
})

test('getValue returns arrays untouched', () => {
    assert.deepEqual(getValue(["a", "b"]), ["a", "b"])
})

test('getValue collapses a single-element peeked array', () => {
    assert.equal(getValue({ value: ["only"] }), "only")
})

test('getValue casts when asked', () => {
    assert.equal(getValue({ value: "3.5" }, [], "NUMBER"), 3.5)
    assert.equal(getValue({ value: "3.5" }, [], "INTEGER"), 3)
    assert.equal(getValue(42, [], "STRING"), "42")
})

test('getValue propagates cast errors (finally-return fix regression)', () => {
    // 0.11 swallowed this in a `finally { return … }`; the core layer must not.
    assert.throws(() => getValue({ value: null }, [], "STRING"), /asType: 'STRING' is not possible/)
})

test('getValue warns and returns undefined for missing input', () => {
    assert.equal(getValue(undefined), undefined)
    assert.equal(getValue(""), undefined)
})

test('getLabel finds a readable label', () => {
    assert.equal(getLabel("just a string"), "just a string")
    assert.equal(getLabel({ name: "Ada" }), "Ada")
    assert.equal(getLabel({ label: "Countess" }), "Countess")
    assert.equal(getLabel({ title: "Notes" }), "Notes")
    assert.equal(getLabel({ nick: "A" }, "[ unlabeled ]", { label: "nick" }), "A")
    assert.equal(getLabel({ name: { value: "Ada" } }), "Ada")
})

test('getLabel falls back when nothing is discoverable', () => {
    assert.equal(getLabel({}), "[ unlabeled ]")
    assert.equal(getLabel({ irrelevant: 1 }, "n/a"), "n/a")
})
