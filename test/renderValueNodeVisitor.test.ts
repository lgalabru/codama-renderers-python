import {
    arrayValueNode,
    booleanValueNode,
    bytesValueNode,
    constantValueNode,
    constantValueNodeFromString,
    enumValueNode,
    mapEntryValueNode,
    mapValueNode,
    noneValueNode,
    numberTypeNode,
    numberValueNode,
    publicKeyTypeNode,
    publicKeyValueNode,
    setValueNode,
    someValueNode,
    stringTypeNode,
    stringValueNode,
    structFieldValueNode,
    structValueNode,
    tupleValueNode,
} from '@codama/nodes';
import { describe, expect, test } from 'vitest';

import { renderValueNode } from '../src';
import { getImportFromFactory } from '../src/utils';

describe('renderValueNode', () => {
    test('renders scalar values', () => {
        expect(renderValueNode(numberValueNode(42)).render).toBe('42');
        expect(renderValueNode(booleanValueNode(true)).render).toBe('True');
        expect(renderValueNode(booleanValueNode(false)).render).toBe('False');
        expect(renderValueNode(noneValueNode()).render).toBe('None');
        expect(renderValueNode(stringValueNode('hi "there"')).render).toBe('"hi \\"there\\""');
    });

    test('renders bytes values for every encoding', () => {
        expect(renderValueNode(bytesValueNode('utf8', 'ab')).render).toBe('bytes([97, 98])');
        expect(renderValueNode(bytesValueNode('base16', '0102')).render).toBe('bytes([1, 2])');
        expect(renderValueNode(bytesValueNode('base58', '21')).render).toBe('bytes([58])');
        expect(renderValueNode(bytesValueNode('base64', 'AQI=')).render).toBe('bytes([1, 2])');
    });

    test('renders public keys with the Pubkey import', () => {
        const { imports, render } = renderValueNode(publicKeyValueNode('11111111111111111111111111111111'));
        expect(render).toBe('Pubkey.from_base58("11111111111111111111111111111111")');
        expect(imports.toString('instructions')).toContain('from ..shared.pubkey import Pubkey');
    });

    test('renders collection values', () => {
        expect(renderValueNode(arrayValueNode([numberValueNode(1), numberValueNode(2)])).render).toBe('[1, 2]');
        expect(renderValueNode(setValueNode([])).render).toBe('set()');
        expect(renderValueNode(setValueNode([numberValueNode(1)])).render).toBe('{1}');
        expect(
            renderValueNode(mapValueNode([mapEntryValueNode(stringValueNode('k'), numberValueNode(1))])).render,
        ).toBe('{"k": 1}');
        expect(renderValueNode(tupleValueNode([numberValueNode(1)])).render).toBe('(1,)');
        expect(renderValueNode(tupleValueNode([numberValueNode(1), numberValueNode(2)])).render).toBe('(1, 2)');
    });

    test('renders some() as its inner value', () => {
        expect(renderValueNode(someValueNode(numberValueNode(7))).render).toBe('7');
    });

    test('renders struct values as keyword arguments', () => {
        const value = structValueNode([
            structFieldValueNode('firstField', numberValueNode(1)),
            structFieldValueNode('class', numberValueNode(2)),
        ]);
        expect(renderValueNode(value).render).toBe('(first_field=1, class_=2)');
    });

    test('renders constant values', () => {
        expect(renderValueNode(constantValueNode(stringTypeNode('utf8'), bytesValueNode('base16', '01'))).render).toBe(
            'bytes([1])',
        );
        expect(renderValueNode(constantValueNodeFromString('utf8', 'hi')).render).toBe('bytes([104, 105])');
        const number = renderValueNode(constantValueNode(numberTypeNode('u16'), numberValueNode(5)));
        expect(number.render).toBe('_borsh.write_u16(5)');
        const short = renderValueNode(constantValueNode(numberTypeNode('shortU16'), numberValueNode(5)));
        expect(short.render).toBe('_borsh.write_shortu16(5)');
    });

    test('rejects unsupported constant values', () => {
        expect(() => renderValueNode(constantValueNode(numberTypeNode('u16', 'be'), numberValueNode(5)))).toThrow(
            'Unsupported constant number type',
        );
        expect(() =>
            renderValueNode(
                constantValueNode(publicKeyTypeNode(), publicKeyValueNode('11111111111111111111111111111111')),
            ),
        ).toThrow('Unsupported constant value type');
    });

    test('renders enum values', () => {
        const scalar = renderValueNode(enumValueNode('myState', 'active'));
        expect(scalar.render).toBe('MyState.ACTIVE');
        expect(scalar.imports.toString('instructions')).toContain('from ..types.my_state import MyState');

        const data = renderValueNode(
            enumValueNode('command', 'move', structValueNode([structFieldValueNode('x', numberValueNode(3))])),
        );
        expect(data.render).toBe('CommandMove(x=3)');
        expect(data.imports.toString('instructions')).toContain('from ..types.command import CommandMove');
    });

    test('honors link overrides for enum values', () => {
        const getImportFrom = getImportFromFactory({ definedTypes: { myState: 'customModule' } });
        const { imports, render } = renderValueNode(enumValueNode('myState', 'active'), getImportFrom);
        expect(render).toBe('MyState.ACTIVE');
        expect(imports.toString('instructions')).toContain('from customModule import MyState');
    });
});
