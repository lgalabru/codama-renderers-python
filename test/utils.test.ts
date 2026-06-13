import {
    accountLinkNode,
    bytesValueNode,
    constantDiscriminatorNode,
    constantValueNode,
    definedTypeLinkNode,
    fieldDiscriminatorNode,
    instructionArgumentNode,
    instructionLinkNode,
    numberTypeNode,
    numberValueNode,
    pdaLinkNode,
    programLinkNode,
    resolverValueNode,
    sizeDiscriminatorNode,
} from '@codama/nodes';
import { describe, expect, test } from 'vitest';

import { ImportMap, sortPythonNames } from '../src/ImportMap';
import {
    getBytesFromBytesValueNode,
    getDiscriminatorConstants,
    getImportFromFactory,
    indent,
    pyClassName,
    pyComment,
    pyName,
} from '../src/utils';
import { getTypeManifestVisitor } from '../src/getTypeManifestVisitor';

describe('naming', () => {
    test('escapes Python keywords', () => {
        expect(pyName('myAccount')).toBe('my_account');
        expect(pyName('import')).toBe('import_');
        expect(pyName('global')).toBe('global_');
        expect(pyClassName('myAccount')).toBe('MyAccount');
        expect(pyClassName('none')).toBe('None_');
        expect(pyClassName('true')).toBe('True_');
    });
});

describe('render helpers', () => {
    test('pyComment renders docs with optional indent', () => {
        expect(pyComment([])).toBe('');
        expect(pyComment(['a', 'b'])).toBe('# a\n# b');
        expect(pyComment(['a'], 4)).toBe('    # a');
    });

    test('indent indents non-empty lines', () => {
        expect(indent('a\n\nb', 2)).toBe('        a\n\n        b');
    });
});

describe('codecs', () => {
    test('decodes every supported bytes encoding', () => {
        expect(getBytesFromBytesValueNode(bytesValueNode('utf8', 'ab'))).toEqual(new Uint8Array([97, 98]));
        expect(getBytesFromBytesValueNode(bytesValueNode('base16', 'ff00'))).toEqual(new Uint8Array([255, 0]));
        expect(getBytesFromBytesValueNode(bytesValueNode('base58', '21'))).toEqual(new Uint8Array([58]));
        expect(getBytesFromBytesValueNode(bytesValueNode('base64', 'AQI='))).toEqual(new Uint8Array([1, 2]));
    });
});

describe('linkOverrides', () => {
    test('returns generated modules by default and overrides when provided', () => {
        const defaults = getImportFromFactory({});
        expect(defaults(accountLinkNode('foo'))).toBe('generatedAccounts');
        expect(defaults(definedTypeLinkNode('foo'))).toBe('generatedTypes');
        expect(defaults(instructionLinkNode('foo'))).toBe('generatedInstructions');
        expect(defaults(pdaLinkNode('foo'))).toBe('generatedAccounts');
        expect(defaults(programLinkNode('foo'))).toBe('generatedPrograms');
        expect(defaults(resolverValueNode('foo'))).toBe('hooked');

        const overridden = getImportFromFactory({
            accounts: { foo: 'accMod' },
            definedTypes: { foo: 'typeMod' },
            instructions: { foo: 'ixMod' },
            pdas: { foo: 'pdaMod' },
            programs: { foo: 'programMod' },
            resolvers: { foo: 'resolverMod' },
        });
        expect(overridden(accountLinkNode('foo'))).toBe('accMod');
        expect(overridden(definedTypeLinkNode('foo'))).toBe('typeMod');
        expect(overridden(instructionLinkNode('foo'))).toBe('ixMod');
        expect(overridden(pdaLinkNode('foo'))).toBe('pdaMod');
        expect(overridden(programLinkNode('foo'))).toBe('programMod');
        expect(overridden(resolverValueNode('foo'))).toBe('resolverMod');
    });

    test('rejects unexpected node kinds', () => {
        const getImportFrom = getImportFromFactory({});
        expect(() => getImportFrom(numberTypeNode('u8') as never)).toThrow();
    });
});

describe('discriminatorConstants', () => {
    const getImportFrom = getImportFromFactory({});
    const typeManifestVisitor = getTypeManifestVisitor({ getImportFrom });

    test('renders constant discriminators with index suffixes', () => {
        const first = constantDiscriminatorNode(constantValueNode(numberTypeNode('u8'), numberValueNode(1)));
        const second = constantDiscriminatorNode(constantValueNode(numberTypeNode('u8'), numberValueNode(2)), 1);
        const { exports, render } = getDiscriminatorConstants({
            discriminatorNodes: [first, second],
            fields: [],
            getImportFrom,
            prefix: 'myInstruction',
            typeManifestVisitor,
        });
        expect(exports).toEqual(['MY_INSTRUCTION_DISCRIMINATOR', 'MY_INSTRUCTION_DISCRIMINATOR_2']);
        expect(render).toContain('MY_INSTRUCTION_DISCRIMINATOR = _borsh.write_u8(1)');
        expect(render).toContain('MY_INSTRUCTION_DISCRIMINATOR_2 = _borsh.write_u8(2)');
    });

    test('renders field discriminators from the matching default value', () => {
        const field = instructionArgumentNode({
            defaultValue: numberValueNode(7),
            defaultValueStrategy: 'omitted',
            name: 'discriminator',
            type: numberTypeNode('u32'),
        });
        const { exports, render } = getDiscriminatorConstants({
            discriminatorNodes: [fieldDiscriminatorNode('discriminator')],
            fields: [field],
            getImportFrom,
            prefix: 'transferSol',
            typeManifestVisitor,
        });
        expect(exports).toEqual(['TRANSFER_SOL_DISCRIMINATOR']);
        expect(render).toBe('TRANSFER_SOL_DISCRIMINATOR = _borsh.write_u32(7)');
    });

    test('skips field discriminators without a default value and unsupported kinds', () => {
        const fieldWithoutDefault = instructionArgumentNode({ name: 'other', type: numberTypeNode('u32') });
        const { exports, render } = getDiscriminatorConstants({
            discriminatorNodes: [
                fieldDiscriminatorNode('missing'),
                fieldDiscriminatorNode('other'),
                sizeDiscriminatorNode(8),
            ],
            fields: [fieldWithoutDefault],
            getImportFrom,
            prefix: 'noop',
            typeManifestVisitor,
        });
        expect(exports).toEqual([]);
        expect(render).toBe('');
    });
});

describe('ImportMap', () => {
    test('renders sections in isort order', () => {
        const imports = new ImportMap()
            .addBare('typing')
            .addBare(['enum'])
            .add('dataclasses', 'dataclass')
            .add('~shared.borsh', new Set(['Reader']))
            .add('~shared', 'borsh as _borsh')
            .add('thirdparty.lib', ['helper', 'CONST', 'MyClass']);
        const rendered = imports.toString('types');
        expect(rendered).toBe(
            [
                'import enum',
                'import typing',
                'from dataclasses import dataclass',
                '',
                'from thirdparty.lib import CONST, MyClass, helper',
                '',
                'from ..shared import borsh as _borsh',
                'from ..shared.borsh import Reader',
            ].join('\n'),
        );
    });

    test('resolves generated modules relative to the current package', () => {
        const imports = new ImportMap().add('~types.foo', 'Foo');
        expect(imports.toString('')).toContain('from .types.foo import Foo');
        expect(imports.toString('types')).toContain('from .foo import Foo');
        expect(imports.toString('instructions')).toContain('from ..types.foo import Foo');
    });

    test('omits self imports and empty name lists', () => {
        const imports = new ImportMap().add('~types.foo', 'Foo').add('~types.bar', []);
        expect(imports.toString('types', new Set(['~types.foo']))).toBe('');
    });

    test('applies the dependency map to custom modules', () => {
        const imports = new ImportMap().add('hooked', 'resolve');
        expect(imports.toString('instructions', new Set(), { hooked: 'my_pkg.hooked' })).toBe(
            'from my_pkg.hooked import resolve',
        );
    });

    test('merges other maps and manifests', () => {
        const base = new ImportMap().add('typing', 'Optional');
        base.mergeWith(new ImportMap().addBare('enum'), new ImportMap().add('typing', 'List'));
        expect(base.isEmpty()).toBe(false);
        expect(new ImportMap().isEmpty()).toBe(true);
        const manifest = {
            decode: '',
            encode: '',
            exports: [],
            imports: new ImportMap().add('~shared.pubkey', 'Pubkey'),
            nestedDefs: [],
            type: '',
        };
        expect(new ImportMap().mergeWithManifest(manifest).toString('types')).toContain(
            'from ..shared.pubkey import Pubkey',
        );
    });

    test('sorts python names by isort groups', () => {
        expect(sortPythonNames(['my_fn', 'MY_CONST', 'MyClass', 'a_fn', 'A_CONST', 'aB', 'Ab'])).toEqual([
            'A_CONST',
            'MY_CONST',
            'Ab',
            'MyClass',
            'a_fn',
            'aB',
            'my_fn',
        ]);
        // Case-sensitive tie-break within a group.
        expect(sortPythonNames(['aa', 'aA'])).toEqual(['aA', 'aa']);
    });
});
