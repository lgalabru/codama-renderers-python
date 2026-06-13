import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    accountNode,
    arrayTypeNode,
    booleanTypeNode,
    constantPdaSeedNode,
    definedTypeLinkNode,
    definedTypeNode,
    enumEmptyVariantTypeNode,
    enumStructVariantTypeNode,
    enumTupleVariantTypeNode,
    enumTypeNode,
    fixedCountNode,
    instructionAccountNode,
    instructionArgumentNode,
    instructionNode,
    mapTypeNode,
    numberTypeNode,
    optionTypeNode,
    pdaLinkNode,
    pdaNode,
    prefixedCountNode,
    programNode,
    publicKeyTypeNode,
    rootNode,
    setTypeNode,
    sizePrefixTypeNode,
    stringTypeNode,
    stringValueNode,
    structFieldTypeNode,
    structTypeNode,
    tupleTypeNode,
    variablePdaSeedNode,
} from '@codama/nodes';
import { writeRenderMapVisitor } from '@codama/renderers-core';
import { visit } from '@codama/visitors-core';
import { describe, expect, test } from 'vitest';

import { getRenderMapVisitor } from '../src';

const PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

function buildSyntheticRoot() {
    const command = definedTypeNode({
        name: 'command',
        type: enumTypeNode([
            enumEmptyVariantTypeNode('noop'),
            enumStructVariantTypeNode(
                'move',
                structTypeNode([
                    structFieldTypeNode({ name: 'x', type: numberTypeNode('i32') }),
                    structFieldTypeNode({ name: 'y', type: numberTypeNode('i32') }),
                    structFieldTypeNode({
                        name: 'label',
                        type: optionTypeNode(sizePrefixTypeNode(stringTypeNode('utf8'), numberTypeNode('u32'))),
                    }),
                ]),
            ),
            enumTupleVariantTypeNode('pair', tupleTypeNode([numberTypeNode('u8'), numberTypeNode('u64')])),
        ]),
    });

    const config = definedTypeNode({
        name: 'config',
        type: structTypeNode([
            structFieldTypeNode({
                name: 'flags',
                type: mapTypeNode(
                    numberTypeNode('u8'),
                    numberTypeNode('u64'),
                    prefixedCountNode(numberTypeNode('u32')),
                ),
            }),
            structFieldTypeNode({
                name: 'tags',
                type: setTypeNode(numberTypeNode('u16'), prefixedCountNode(numberTypeNode('u32'))),
            }),
            structFieldTypeNode({
                name: 'pair',
                type: tupleTypeNode([booleanTypeNode(), publicKeyTypeNode()]),
            }),
            structFieldTypeNode({
                name: 'triple',
                type: arrayTypeNode(numberTypeNode('u16'), fixedCountNode(3)),
            }),
            structFieldTypeNode({ name: 'big', type: optionTypeNode(numberTypeNode('u128')) }),
        ]),
    });

    const settingsPda = pdaNode({
        name: 'settings',
        seeds: [constantPdaSeedNode(stringTypeNode('utf8'), stringValueNode('global'))],
    });
    const counterPda = pdaNode({
        name: 'counter',
        seeds: [
            constantPdaSeedNode(stringTypeNode('utf8'), stringValueNode('counter')),
            variablePdaSeedNode('owner', publicKeyTypeNode()),
            variablePdaSeedNode('index', numberTypeNode('u64')),
        ],
    });

    const settings = accountNode({
        data: structTypeNode([structFieldTypeNode({ name: 'value', type: numberTypeNode('u64') })]),
        name: 'settings',
        pda: pdaLinkNode('settings'),
    });
    const counter = accountNode({
        data: structTypeNode([
            structFieldTypeNode({ name: 'owner', type: publicKeyTypeNode() }),
            structFieldTypeNode({ name: 'count', type: numberTypeNode('u64') }),
        ]),
        name: 'counter',
        pda: pdaLinkNode('counter'),
    });

    const doThing = instructionNode({
        accounts: [
            instructionAccountNode({ isSigner: true, isWritable: false, name: 'authority' }),
            instructionAccountNode({ isSigner: false, isWritable: true, name: 'counter' }),
        ],
        arguments: [
            instructionArgumentNode({ name: 'command', type: definedTypeLinkNode('command') }),
            instructionArgumentNode({ name: 'maybe', type: optionTypeNode(numberTypeNode('u32')) }),
        ],
        name: 'doThing',
    });

    return rootNode(
        programNode({
            accounts: [settings, counter],
            definedTypes: [command, config],
            errors: [],
            instructions: [doThing],
            name: 'test',
            pdas: [settingsPda, counterPda],
            publicKey: PROGRAM_ID,
            version: '1.0.0',
        }),
    );
}

const PY_ASSERTIONS = `
import dataclasses
import importlib.util
import os
import sys

base = sys.argv[1]
spec = importlib.util.spec_from_file_location(
    "gen", os.path.join(base, "__init__.py"), submodule_search_locations=[base]
)
gen = importlib.util.module_from_spec(spec)
sys.modules["gen"] = gen
spec.loader.exec_module(gen)

# Data enum round-trips (empty, struct and tuple variants).
noop = gen.CommandNoop()
assert noop.serialize() == b"\\x00"
assert gen.Command.deserialize(noop.serialize()) == noop

move = gen.CommandMove(x=-3, y=4, label="hi")
data = move.serialize()
assert data[0] == 1
assert gen.Command.deserialize(data) == move
move_none = gen.CommandMove(x=1, y=2, label=None)
assert gen.Command.deserialize(move_none.serialize()) == move_none

pair = gen.CommandPair(fields=(7, 2**63))
data = pair.serialize()
assert data == b"\\x02" + bytes([7]) + (2**63).to_bytes(8, "little")
assert gen.Command.deserialize(data) == pair

try:
    gen.Command.deserialize(b"\\x09")
    raise SystemExit("expected unknown variant failure")
except gen.SerializationError as exc:
    assert isinstance(exc, gen.CodamaError) and isinstance(exc, ValueError)

# Generated dataclasses are frozen value objects.
try:
    move.x = 99
    raise SystemExit("expected frozen dataclass failure")
except dataclasses.FrozenInstanceError:
    pass

# Struct with maps, sets, tuples, fixed arrays and a u128 option.
cfg = gen.Config(
    flags={1: 2, 3: 2**64 - 1},
    tags={5, 6},
    pair=(True, gen.Pubkey.default()),
    triple=[1, 2, 3],
    big=None,
)
assert gen.Config.deserialize(cfg.serialize()) == cfg
cfg2 = gen.Config(
    flags={},
    tags=set(),
    pair=(False, gen.Pubkey.from_base58("${PROGRAM_ID}")),
    triple=[7, 8, 9],
    big=2**100 + 17,
)
assert gen.Config.deserialize(cfg2.serialize()) == cfg2
assert gen.deserialize_config(gen.Reader(cfg2.serialize())) == cfg2

# Maps and sets are serialized deterministically (ascending key order),
# regardless of insertion order.
cfg3 = gen.Config(
    flags={3: 4, 1: 2},
    tags={6, 5},
    pair=(True, gen.Pubkey.default()),
    triple=[1, 2, 3],
    big=None,
)
cfg4 = gen.Config(
    flags={1: 2, 3: 4},
    tags={5, 6},
    pair=(True, gen.Pubkey.default()),
    triple=[1, 2, 3],
    big=None,
)
assert cfg3.serialize() == cfg4.serialize()
assert cfg3.serialize()[:12] == bytes([2, 0, 0, 0, 1, 2, 0, 0, 0, 0, 0, 0])

# PDA helpers: constant-only seeds match a vector generated with @solana/web3.js.
addr, bump = gen.find_settings_address()
assert str(addr) == "4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf", addr
assert bump == 255, bump

# Variable seeds are encoded consistently with the shared runtime.
owner = gen.Pubkey.from_base58("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr")
addr2, bump2 = gen.find_counter_address(owner=owner, index=7)
expected = gen.find_program_address(
    [b"counter", owner.to_bytes(), (7).to_bytes(8, "little")], gen.TEST_PROGRAM_ID
)
assert (addr2, bump2) == expected

# Instruction builder with a defined-type-link argument and an option argument.
ix = gen.do_thing(authority=owner, counter=addr2, command=gen.CommandNoop(), maybe=None)
assert ix.data == b"\\x00\\x00"
assert ix.accounts[0].is_signer is True and ix.accounts[1].is_writable is True
ix2 = gen.do_thing(authority=owner, counter=addr2, command=pair, maybe=9)
assert ix2.data == pair.serialize() + b"\\x01" + (9).to_bytes(4, "little")
assert ix2.program_id == gen.TEST_PROGRAM_ID

print("PYTHON-OK")
`;

describe('getRenderMapVisitor', () => {
    test('renders a Python client that round-trips advanced types', () => {
        const root = buildSyntheticRoot();
        const dir = mkdtempSync(join(tmpdir(), 'codama-renderers-python-'));
        const generatedDir = join(dir, 'generated');

        visit(root, writeRenderMapVisitor(getRenderMapVisitor(), generatedDir));

        // Every generated file must pass a syntax check.
        const compile = spawnSync('python3', ['-m', 'compileall', '-q', generatedDir]);
        expect(compile.error).toBeUndefined();
        expect(compile.status, compile.stderr?.toString()).toBe(0);

        // The generated client must behave correctly at runtime.
        const script = join(dir, 'assertions.py');
        writeFileSync(script, PY_ASSERTIONS);
        const run = spawnSync('python3', [script, generatedDir]);
        expect(run.error).toBeUndefined();
        expect(run.status, run.stderr?.toString()).toBe(0);
        expect(run.stdout.toString()).toContain('PYTHON-OK');
    });
});
