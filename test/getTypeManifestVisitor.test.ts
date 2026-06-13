import {
    amountTypeNode,
    arrayTypeNode,
    booleanTypeNode,
    bytesTypeNode,
    definedTypeLinkNode,
    definedTypeNode,
    enumTypeNode,
    fixedCountNode,
    fixedSizeTypeNode,
    mapTypeNode,
    numberTypeNode,
    optionTypeNode,
    prefixedCountNode,
    remainderCountNode,
    remainderOptionTypeNode,
    setTypeNode,
    sizePrefixTypeNode,
    stringTypeNode,
    structFieldTypeNode,
    structTypeNode,
    tupleTypeNode,
    zeroableOptionTypeNode,
} from '@codama/nodes';
import { visit } from '@codama/visitors-core';
import { describe, expect, test } from 'vitest';

import { applyDecode, applyEncode, getTypeManifestVisitor, TypeManifest } from '../src';
import { getImportFromFactory } from '../src/utils';

function manifest(node: Parameters<typeof visit>[0], parentName: string | null = 'parent'): TypeManifest {
    const visitor = getTypeManifestVisitor({ getImportFrom: getImportFromFactory({}), parentName });
    return visit(node as never, visitor) as TypeManifest;
}

describe('getTypeManifestVisitor', () => {
    test('applies encode and decode templates', () => {
        const m = manifest(numberTypeNode('u64'));
        expect(applyEncode(m, 'self.value')).toBe('_borsh.write_u64(self.value)');
        expect(applyDecode(m, 'r')).toBe('r.read_u64()');
    });

    test('maps shortU16 to the dedicated codec', () => {
        const m = manifest(numberTypeNode('shortU16'));
        expect(m.encode).toBe('_borsh.write_shortu16(__VALUE__)');
        expect(m.decode).toBe('__R__.read_shortu16()');
    });

    test('rejects unsupported number types', () => {
        expect(() => manifest(numberTypeNode('u64', 'be'))).toThrow('Number endianness not supported');
        const fake = { ...numberTypeNode('u8'), format: 'u24' as 'u8' };
        expect(() => manifest(fake)).toThrow('Number format not supported: u24');
    });

    test('supports u8 booleans only', () => {
        expect(manifest(booleanTypeNode()).encode).toBe('_borsh.write_bool(__VALUE__)');
        expect(() => manifest(booleanTypeNode(numberTypeNode('u16')))).toThrow('Bool size not supported');
    });

    test('renders strings for every size strategy', () => {
        expect(manifest(fixedSizeTypeNode(stringTypeNode('utf8'), 8)).encode).toBe(
            '_borsh.write_fixed_string(__VALUE__, 8)',
        );
        expect(manifest(sizePrefixTypeNode(stringTypeNode('utf8'), numberTypeNode('u32'))).decode).toBe(
            '__R__.read_prefixed_string(4)',
        );
        expect(manifest(sizePrefixTypeNode(stringTypeNode('utf8'), numberTypeNode('shortU16'))).decode).toBe(
            '__R__.read_prefixed_string("shortu16")',
        );
        const remainder = manifest(stringTypeNode('utf8'));
        expect(remainder.encode).toBe('__VALUE__.encode("utf-8")');
        expect(remainder.decode).toBe('__R__.read_remainder().decode("utf-8")');
    });

    test('renders bytes for every size strategy', () => {
        expect(manifest(fixedSizeTypeNode(bytesTypeNode(), 8)).encode).toBe('_borsh.write_fixed_bytes(__VALUE__, 8)');
        expect(manifest(sizePrefixTypeNode(bytesTypeNode(), numberTypeNode('u16'))).encode).toBe(
            '_borsh.write_prefixed_bytes(__VALUE__, 2)',
        );
        const remainder = manifest(bytesTypeNode());
        expect(remainder.encode).toBe('bytes(__VALUE__)');
        expect(remainder.decode).toBe('__R__.read_remainder()');
    });

    test('rejects unsupported size prefixes', () => {
        expect(() => manifest(sizePrefixTypeNode(bytesTypeNode(), numberTypeNode('i32')))).toThrow(
            'Size prefix not supported',
        );
        expect(() => manifest(sizePrefixTypeNode(bytesTypeNode(), numberTypeNode('u32', 'be')))).toThrow(
            'Size prefix not supported',
        );
    });

    test('renders arrays for every count strategy', () => {
        const u8 = numberTypeNode('u8');
        expect(manifest(arrayTypeNode(u8, fixedCountNode(3))).encode).toBe(
            '_borsh.write_fixed_array(__VALUE__, 3, lambda _item: _borsh.write_u8(_item))',
        );
        expect(manifest(arrayTypeNode(u8, prefixedCountNode(numberTypeNode('shortU16')))).encode).toBe(
            '_borsh.write_vec(__VALUE__, lambda _item: _borsh.write_u8(_item), "shortu16")',
        );
        expect(manifest(arrayTypeNode(u8, remainderCountNode())).decode).toBe(
            '_borsh.read_remainder_array(__R__, lambda r: r.read_u8())',
        );
    });

    test('renders maps for every count strategy', () => {
        const map = (count: Parameters<typeof mapTypeNode>[2]) =>
            mapTypeNode(numberTypeNode('u8'), numberTypeNode('u64'), count);
        expect(manifest(map(fixedCountNode(2))).encode).toBe(
            '_borsh.write_fixed_map(__VALUE__, 2, lambda _key: _borsh.write_u8(_key), lambda _value: _borsh.write_u64(_value))',
        );
        expect(manifest(map(remainderCountNode())).decode).toBe(
            '_borsh.read_remainder_map(__R__, lambda r: r.read_u8(), lambda r: r.read_u64())',
        );
        expect(manifest(map(prefixedCountNode(numberTypeNode('u32')))).type).toBe('typing.Dict[int, int]');
    });

    test('renders sets for every count strategy', () => {
        const set = (count: Parameters<typeof setTypeNode>[1]) => setTypeNode(numberTypeNode('u8'), count);
        expect(manifest(set(fixedCountNode(2))).encode).toBe(
            '_borsh.write_fixed_set(__VALUE__, 2, lambda _item: _borsh.write_u8(_item))',
        );
        expect(manifest(set(remainderCountNode())).encode).toBe(
            '_borsh.write_remainder_set(__VALUE__, lambda _item: _borsh.write_u8(_item))',
        );
        expect(manifest(set(prefixedCountNode(numberTypeNode('u32')))).type).toBe('typing.Set[int]');
    });

    test('renders options and tuples', () => {
        expect(manifest(optionTypeNode(numberTypeNode('u32'))).type).toBe('typing.Optional[int]');
        expect(manifest(tupleTypeNode([])).encode).toBe('b""');
        const single = manifest(tupleTypeNode([numberTypeNode('u8')]));
        expect(single.decode).toBe('(__R__.read_u8(),)');
        const pair = manifest(tupleTypeNode([numberTypeNode('u8'), booleanTypeNode()]));
        expect(pair.encode).toBe('(_borsh.write_u8(__VALUE__[0])) + (_borsh.write_bool(__VALUE__[1]))');
    });

    test('passes through single-child wrappers', () => {
        expect(manifest(amountTypeNode(numberTypeNode('u64'), 9, 'SOL')).encode).toBe('_borsh.write_u64(__VALUE__)');
    });

    test('rejects unsupported option type nodes', () => {
        expect(() => manifest(zeroableOptionTypeNode(numberTypeNode('u32')))).toThrow();
        expect(() => manifest(remainderOptionTypeNode(numberTypeNode('u32')))).toThrow();
    });

    test('requires a parent name for structs and enums', () => {
        expect(() => manifest(structTypeNode([]), null)).toThrow('Struct type must have a parent name');
        expect(() => manifest(enumTypeNode([]), null)).toThrow('Enum type must have a parent name');
    });

    test('rejects unsupported enum sizes', () => {
        expect(() => manifest(enumTypeNode([], { size: numberTypeNode('f32') }))).toThrow('Enum size not supported');
    });

    test('renders type aliases with serialize/deserialize helpers', () => {
        const alias = manifest(definedTypeNode({ name: 'myAlias', type: numberTypeNode('u16') }));
        expect(alias.type).toContain('MyAlias = int');
        expect(alias.type).toContain('def serialize_my_alias(value: MyAlias) -> bytes:');
        expect(alias.type).toContain('return _borsh.write_u16(value)');
        expect(alias.exports).toContain('deserialize_my_alias');
    });

    test('renders defined type links through their module', () => {
        const link = manifest(definedTypeLinkNode('other'));
        expect(link.encode).toBe('serialize_other(__VALUE__)');
        expect(link.decode).toBe('deserialize_other(__R__)');
        expect(link.imports.toString('instructions')).toContain(
            'from ..types.other import Other, deserialize_other, serialize_other',
        );
    });

    test('renders scalar enums with a strict decoder', () => {
        const scalar = manifest(
            definedTypeNode({ name: 'state', type: enumTypeNode([], { size: numberTypeNode('u32') }) }),
        );
        expect(scalar.type).toContain('class State(IntEnum):');
        expect(scalar.type).toContain('except ValueError as exc:');
        expect(scalar.type).toContain('raise SerializationError("unknown variant index for State: %d" % _value)');
    });

    test('renders struct fields with omitted defaults', () => {
        const struct = manifest(
            definedTypeNode({
                name: 'thing',
                type: structTypeNode([
                    structFieldTypeNode({
                        defaultValue: { kind: 'numberValueNode', number: 7 },
                        defaultValueStrategy: 'omitted',
                        name: 'tag',
                        type: numberTypeNode('u8'),
                    }),
                    structFieldTypeNode({
                        defaultValue: { kind: 'numberValueNode', number: 3 },
                        name: 'flags',
                        type: numberTypeNode('u8'),
                    }),
                    structFieldTypeNode({ name: 'value', type: numberTypeNode('u64') }),
                ]),
            }),
        );
        expect(struct.type).toContain('_data += _borsh.write_u8(7)');
        expect(struct.type).toContain('_ = r.read_u8()  # skip omitted field: tag');
        expect(struct.type).toContain('flags: int');
    });
});
