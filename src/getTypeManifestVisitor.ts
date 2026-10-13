import { CODAMA_ERROR__RENDERERS__UNSUPPORTED_NODE, CodamaError } from '@codama/errors';
import {
    isNode,
    isScalarEnum,
    NumberTypeNode,
    parseDocs,
    pascalCase,
    REGISTERED_TYPE_NODE_KINDS,
    resolveNestedTypeNode,
    snakeCase,
    StructTypeNode,
    VALUE_NODES,
} from '@codama/nodes';
import { extendVisitor, mergeVisitor, pipe, visit, Visitor } from '@codama/visitors-core';

import { ImportMap } from './ImportMap';
import { renderValueNode } from './renderValueNodeVisitor';
import { GetImportFromFunction, pyClassName, pyComment, pyName } from './utils';

export type TypeManifest = {
    /** Expression template that reads the value from a `Reader` named `__R__`. */
    decode: string;
    /** Expression template that converts a value named `__VALUE__` to `bytes`. */
    encode: string;
    /** Public names defined by `type` and `nestedDefs` (classes, helpers). */
    exports: string[];
    imports: ImportMap;
    /** Extra class definitions that must be emitted before `type`. */
    nestedDefs: string[];
    /** A Python annotation, or a full definition for top-level structs/enums. */
    type: string;
};

export type StructField = {
    annotation: string;
    decode: string;
    defaultRendered: string | null;
    docs: string[];
    encodeDefault: string | null;
    encodeSelf: string;
    name: string;
    omitted: boolean;
};

// Map Codama number formats to Python codec info.
const NUMBER_INFO: Record<string, { fn: string; py: string; width: number }> = {
    f32: { fn: 'f32', py: 'float', width: 4 },
    f64: { fn: 'f64', py: 'float', width: 8 },
    i128: { fn: 'i128', py: 'int', width: 16 },
    i16: { fn: 'i16', py: 'int', width: 2 },
    i32: { fn: 'i32', py: 'int', width: 4 },
    i64: { fn: 'i64', py: 'int', width: 8 },
    i8: { fn: 'i8', py: 'int', width: 1 },
    shortU16: { fn: 'shortu16', py: 'int', width: 2 },
    u128: { fn: 'u128', py: 'int', width: 16 },
    u16: { fn: 'u16', py: 'int', width: 2 },
    u32: { fn: 'u32', py: 'int', width: 4 },
    u64: { fn: 'u64', py: 'int', width: 8 },
    u8: { fn: 'u8', py: 'int', width: 1 },
};

/**
 * Maps prefix number formats to the `prefix_width` argument of the runtime's
 * Borsh helpers: a fixed byte width, or `"shortu16"` for the variable-length
 * shortU16 encoding.
 */
const UNSIGNED_PREFIX_WIDTHS: Record<string, number | string> = {
    shortU16: '"shortu16"',
    u16: 2,
    u32: 4,
    u64: 8,
    u8: 1,
};

export function applyEncode(manifest: Pick<TypeManifest, 'encode'>, valueExpr: string): string {
    return manifest.encode.split('__VALUE__').join(valueExpr);
}

export function applyDecode(manifest: Pick<TypeManifest, 'decode'>, readerExpr: string): string {
    return manifest.decode.split('__R__').join(readerExpr);
}

function prefixWidth(prefix: NumberTypeNode): number | string {
    const width = UNSIGNED_PREFIX_WIDTHS[prefix.format];
    if (width === undefined || prefix.endian !== 'le') {
        throw new Error(`Size prefix not supported: ${prefix.format} (${prefix.endian})`);
    }
    return width;
}

export function getTypeManifestVisitor(options: {
    getImportFrom: GetImportFromFunction;
    nestedStruct?: boolean;
    parentName?: string | null;
}) {
    const { getImportFrom } = options;
    let parentName: string | null = options.parentName ?? null;
    let nestedStruct: boolean = options.nestedStruct ?? false;
    let parentSize: NumberTypeNode | number | null = null;

    function emptyManifest(): TypeManifest {
        return { decode: '', encode: '', exports: [], imports: new ImportMap(), nestedDefs: [], type: '' };
    }

    function classManifestImports(): ImportMap {
        // Note: `_borsh` is not imported here; field manifests bring their
        // own imports, so structs without codec calls stay import-clean.
        return new ImportMap().add('dataclasses', 'dataclass').add('~shared.borsh', 'Reader');
    }

    function collectFields(
        structType: StructTypeNode,
        owner: string,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        self: Visitor<TypeManifest, any>,
    ): { exports: string[]; fields: StructField[]; imports: ImportMap; nestedDefs: string[] } {
        const imports = new ImportMap();
        const nestedDefs: string[] = [];
        const exports: string[] = [];
        const fields = structType.fields.map((field): StructField => {
            const saveParent = parentName;
            const saveNested = nestedStruct;
            parentName = owner + pascalCase(field.name);
            nestedStruct = true;
            const manifest = visit(field.type, self);
            parentName = saveParent;
            nestedStruct = saveNested;

            imports.mergeWith(manifest.imports);
            nestedDefs.push(...manifest.nestedDefs);
            exports.push(...manifest.exports);

            const name = pyName(field.name);
            const hasDefault = !!field.defaultValue && isNode(field.defaultValue, VALUE_NODES);
            let defaultRendered: string | null = null;
            if (hasDefault) {
                const value = renderValueNode(field.defaultValue!, getImportFrom);
                imports.mergeWith(value.imports);
                defaultRendered = value.render;
            }
            return {
                annotation: manifest.type,
                decode: applyDecode(manifest, 'r'),
                defaultRendered,
                docs: parseDocs(field.docs),
                encodeDefault: defaultRendered === null ? null : applyEncode(manifest, defaultRendered),
                encodeSelf: applyEncode(manifest, `self.${name}`),
                name,
                omitted: hasDefault && field.defaultValueStrategy === 'omitted',
            };
        });
        return { exports, fields, imports, nestedDefs };
    }

    return pipe(
        mergeVisitor(
            emptyManifest,
            (_, values): TypeManifest => {
                // Single-child wrappers (amounts, date times, offsets, …) pass through.
                if (values.length === 1) return values[0];
                return {
                    decode: '',
                    encode: '',
                    exports: values.flatMap(v => v.exports),
                    imports: new ImportMap().mergeWith(...values.map(v => v.imports)),
                    nestedDefs: values.flatMap(v => v.nestedDefs),
                    type: values.map(v => v.type).join('\n'),
                };
            },
            { keys: [...REGISTERED_TYPE_NODE_KINDS, 'definedTypeLinkNode', 'definedTypeNode', 'accountNode'] },
        ),
        v =>
            extendVisitor(v, {
                visitAccount(account, { self }) {
                    parentName = pyClassName(account.name);
                    const manifest = visit(account.data, self);
                    parentName = null;
                    return manifest;
                },

                visitArrayType(arrayType, { self }) {
                    const child = visit(arrayType.item, self);
                    const imports = new ImportMap()
                        .mergeWith(child.imports)
                        .addBare('typing')
                        .add('~shared', 'borsh as _borsh');
                    const itemEncode = applyEncode(child, '_item');
                    const itemDecode = applyDecode(child, 'r');
                    const base = {
                        exports: child.exports,
                        imports,
                        nestedDefs: child.nestedDefs,
                        type: `typing.List[${child.type}]`,
                    };
                    if (isNode(arrayType.count, 'fixedCountNode')) {
                        const size = arrayType.count.value;
                        return {
                            ...base,
                            decode: `_borsh.read_fixed_array(__R__, ${size}, lambda r: ${itemDecode})`,
                            encode: `_borsh.write_fixed_array(__VALUE__, ${size}, lambda _item: ${itemEncode})`,
                        };
                    }
                    if (isNode(arrayType.count, 'prefixedCountNode')) {
                        const width = prefixWidth(resolveNestedTypeNode(arrayType.count.prefix));
                        return {
                            ...base,
                            decode: `_borsh.read_vec(__R__, lambda r: ${itemDecode}, ${width})`,
                            encode: `_borsh.write_vec(__VALUE__, lambda _item: ${itemEncode}, ${width})`,
                        };
                    }
                    return {
                        ...base,
                        decode: `_borsh.read_remainder_array(__R__, lambda r: ${itemDecode})`,
                        encode: `_borsh.write_remainder_array(__VALUE__, lambda _item: ${itemEncode})`,
                    };
                },

                visitBooleanType(booleanType) {
                    const resolvedSize = resolveNestedTypeNode(booleanType.size);
                    if (resolvedSize.format === 'u8' && resolvedSize.endian === 'le') {
                        return {
                            decode: '__R__.read_bool()',
                            encode: '_borsh.write_bool(__VALUE__)',
                            exports: [],
                            imports: new ImportMap().add('~shared', 'borsh as _borsh'),
                            nestedDefs: [],
                            type: 'bool',
                        };
                    }
                    throw new Error('Bool size not supported by Borsh');
                },

                visitBytesType() {
                    const imports = new ImportMap().add('~shared', 'borsh as _borsh');
                    if (typeof parentSize === 'number') {
                        return {
                            decode: `__R__.read(${parentSize})`,
                            encode: `_borsh.write_fixed_bytes(__VALUE__, ${parentSize})`,
                            exports: [],
                            imports,
                            nestedDefs: [],
                            type: 'bytes',
                        };
                    }
                    if (parentSize && typeof parentSize === 'object') {
                        const width = prefixWidth(parentSize);
                        return {
                            decode: `__R__.read_prefixed_bytes(${width})`,
                            encode: `_borsh.write_prefixed_bytes(__VALUE__, ${width})`,
                            exports: [],
                            imports,
                            nestedDefs: [],
                            type: 'bytes',
                        };
                    }
                    return {
                        decode: '__R__.read_remainder()',
                        encode: 'bytes(__VALUE__)',
                        exports: [],
                        imports: new ImportMap(),
                        nestedDefs: [],
                        type: 'bytes',
                    };
                },

                visitDefinedType(definedType, { self }) {
                    parentName = pyClassName(definedType.name);
                    const manifest = visit(definedType.type, self);
                    parentName = null;

                    const pascal = pyClassName(definedType.name);
                    const snake = snakeCase(definedType.name);
                    const imports = manifest.imports.add('~shared.borsh', 'Reader');
                    const isClassDef = isNode(definedType.type, ['enumTypeNode', 'structTypeNode']);

                    let body: string;
                    if (isClassDef) {
                        body = [
                            manifest.type,
                            `def serialize_${snake}(value: ${pascal}) -> bytes:\n    return value.serialize()`,
                            `def deserialize_${snake}(r: Reader) -> ${pascal}:\n    return ${pascal}.deserialize_reader(r)`,
                        ].join('\n\n\n');
                    } else {
                        body = [
                            `${pascal} = ${manifest.type}`,
                            `def serialize_${snake}(value: ${pascal}) -> bytes:\n    return ${applyEncode(manifest, 'value')}`,
                            `def deserialize_${snake}(r: Reader) -> ${pascal}:\n    return ${applyDecode(manifest, 'r')}`,
                        ].join('\n\n\n');
                    }

                    return {
                        decode: `${pascal}.deserialize_reader(__R__)`,
                        encode: '__VALUE__.serialize()',
                        exports: [...new Set([...manifest.exports, pascal, `serialize_${snake}`, `deserialize_${snake}`])],
                        imports,
                        nestedDefs: manifest.nestedDefs,
                        type: body,
                    };
                },

                visitDefinedTypeLink(node) {
                    const pascal = pyClassName(node.name);
                    const snake = snakeCase(node.name);
                    const importFrom = getImportFrom(node);
                    const module = importFrom === 'generatedTypes' ? `~types.${pyName(node.name)}` : importFrom;
                    return {
                        decode: `deserialize_${snake}(__R__)`,
                        encode: `serialize_${snake}(__VALUE__)`,
                        exports: [],
                        imports: new ImportMap().add(module, [pascal, `serialize_${snake}`, `deserialize_${snake}`]),
                        nestedDefs: [],
                        type: pascal,
                    };
                },

                visitEnumType(enumType, { self }) {
                    if (!parentName) {
                        throw new Error('Enum type must have a parent name.');
                    }
                    const typeName = pascalCase(parentName);
                    const sizeNode = resolveNestedTypeNode(enumType.size);
                    const sizeInfo = NUMBER_INFO[sizeNode.format];
                    if (!sizeInfo || sizeInfo.py !== 'int' || sizeNode.endian !== 'le') {
                        throw new Error(`Enum size not supported: ${sizeNode.format}`);
                    }
                    // Codama preserves explicit tags; omitted tags use their array
                    // index, not the preceding variant's discriminator plus one.
                    const discriminators = enumType.variants.map((variant, index) => variant.discriminator ?? index);
                    const signed = sizeNode.format.startsWith('i');
                    const bits = BigInt(sizeInfo.width * 8);
                    const minimum = signed ? -(1n << (bits - 1n)) : 0n;
                    const maximum = (1n << (bits - (signed ? 1n : 0n))) - 1n;
                    const seen = new Set<number>();
                    for (const discriminator of discriminators) {
                        if (
                            !Number.isSafeInteger(discriminator) ||
                            BigInt(discriminator) < minimum ||
                            BigInt(discriminator) > maximum
                        ) {
                            throw new Error(`Enum discriminator out of range for ${sizeNode.format}: ${discriminator}`);
                        }
                        if (seen.has(discriminator)) {
                            throw new Error(`Duplicate enum discriminator: ${discriminator}`);
                        }
                        seen.add(discriminator);
                    }
                    const imports = new ImportMap().add('~shared', 'borsh as _borsh').add('~shared.borsh', 'Reader');
                    const exports: string[] = [typeName];
                    const base = {
                        decode: `${typeName}.deserialize_reader(__R__)`,
                        encode: '__VALUE__.serialize()',
                    };

                    // Scalar enum: all variants are empty → IntEnum.
                    if (isScalarEnum(enumType)) {
                        imports.add('enum', 'IntEnum').add('~shared.errors', 'SerializationError');
                        const lines: string[] = [`class ${typeName}(IntEnum):`];
                        enumType.variants.forEach((variant, index) => {
                            lines.push(`    ${snakeCase(variant.name).toUpperCase()} = ${discriminators[index]}`);
                        });
                        lines.push('');
                        lines.push('    def serialize(self) -> bytes:');
                        lines.push(`        return _borsh.write_${sizeInfo.fn}(int(self))`);
                        lines.push('');
                        lines.push('    @classmethod');
                        lines.push(`    def deserialize(cls, data: bytes) -> "${typeName}":`);
                        lines.push('        return cls.deserialize_reader(Reader(data))');
                        lines.push('');
                        lines.push('    @classmethod');
                        lines.push(`    def deserialize_reader(cls, r: Reader) -> "${typeName}":`);
                        lines.push(`        _value = r.read_${sizeInfo.fn}()`);
                        lines.push('        try:');
                        lines.push('            return cls(_value)');
                        lines.push('        except ValueError as exc:');
                        lines.push(
                            `            raise SerializationError("unknown variant index for ${typeName}: %d" % _value) from exc`,
                        );
                        return { ...base, exports, imports, nestedDefs: [], type: lines.join('\n') };
                    }

                    // Data enum: a base class plus one dataclass per variant.
                    imports.add('dataclasses', 'dataclass').add('~shared.errors', 'SerializationError');
                    const nestedDefs: string[] = [];
                    const variantBlocks: string[] = [];
                    const dispatchLines: string[] = [];

                    enumType.variants.forEach((variant, index) => {
                        const variantClass = typeName + pascalCase(variant.name);
                        exports.push(variantClass);
                        dispatchLines.push(`        if _index == ${discriminators[index]}:`);
                        dispatchLines.push(`            return ${variantClass}._deserialize_fields(r)`);

                        let fields: StructField[] = [];
                        if (isNode(variant, 'enumStructVariantTypeNode')) {
                            const structNode = resolveNestedTypeNode(variant.struct);
                            const collected = collectFields(structNode, variantClass, self);
                            imports.mergeWith(collected.imports);
                            nestedDefs.push(...collected.nestedDefs);
                            exports.push(...collected.exports);
                            fields = collected.fields;
                        } else if (isNode(variant, 'enumTupleVariantTypeNode')) {
                            const saveParent = parentName;
                            const saveNested = nestedStruct;
                            parentName = variantClass;
                            nestedStruct = true;
                            const manifest = visit(variant.tuple, self);
                            parentName = saveParent;
                            nestedStruct = saveNested;
                            imports.mergeWith(manifest.imports);
                            nestedDefs.push(...manifest.nestedDefs);
                            exports.push(...manifest.exports);
                            fields = [
                                {
                                    annotation: manifest.type,
                                    decode: applyDecode(manifest, 'r'),
                                    defaultRendered: null,
                                    docs: [],
                                    encodeDefault: null,
                                    encodeSelf: applyEncode(manifest, 'self.fields'),
                                    name: 'fields',
                                    omitted: false,
                                },
                            ];
                        }

                        variantBlocks.push(
                            renderDataClass({
                                baseClass: typeName,
                                className: variantClass,
                                docs: [],
                                fields,
                                serializePrelude: `_borsh.write_${sizeInfo.fn}(${discriminators[index]})`,
                                variant: true,
                            }),
                        );
                    });

                    const baseLines: string[] = [
                        `class ${typeName}:`,
                        '    def serialize(self) -> bytes:',
                        `        raise NotImplementedError("serialize must be called on a concrete ${typeName} variant")`,
                        '',
                        '    @classmethod',
                        `    def deserialize(cls, data: bytes) -> "${typeName}":`,
                        '        return cls.deserialize_reader(Reader(data))',
                        '',
                        '    @classmethod',
                        `    def deserialize_reader(cls, r: Reader) -> "${typeName}":`,
                        `        _index = r.read_${sizeInfo.fn}()`,
                        ...dispatchLines,
                        `        raise SerializationError("unknown variant index for ${typeName}: %d" % _index)`,
                    ];

                    return {
                        ...base,
                        exports,
                        imports,
                        nestedDefs,
                        type: [baseLines.join('\n'), ...variantBlocks].join('\n\n\n'),
                    };
                },

                visitFixedSizeType(fixedSizeType, { self }) {
                    const saveSize = parentSize;
                    parentSize = fixedSizeType.size;
                    const manifest = visit(fixedSizeType.type, self);
                    parentSize = saveSize;
                    return manifest;
                },

                visitMapType(mapType, { self }) {
                    const key = visit(mapType.key, self);
                    const value = visit(mapType.value, self);
                    const imports = new ImportMap()
                        .mergeWith(key.imports, value.imports)
                        .addBare('typing')
                        .add('~shared', 'borsh as _borsh');
                    const keyEncode = applyEncode(key, '_key');
                    const valueEncode = applyEncode(value, '_value');
                    const keyDecode = applyDecode(key, 'r');
                    const valueDecode = applyDecode(value, 'r');
                    const base = {
                        exports: [...key.exports, ...value.exports],
                        imports,
                        nestedDefs: [...key.nestedDefs, ...value.nestedDefs],
                        type: `typing.Dict[${key.type}, ${value.type}]`,
                    };
                    if (isNode(mapType.count, 'fixedCountNode')) {
                        const size = mapType.count.value;
                        return {
                            ...base,
                            decode: `_borsh.read_fixed_map(__R__, ${size}, lambda r: ${keyDecode}, lambda r: ${valueDecode})`,
                            encode: `_borsh.write_fixed_map(__VALUE__, ${size}, lambda _key: ${keyEncode}, lambda _value: ${valueEncode})`,
                        };
                    }
                    if (isNode(mapType.count, 'remainderCountNode')) {
                        return {
                            ...base,
                            decode: `_borsh.read_remainder_map(__R__, lambda r: ${keyDecode}, lambda r: ${valueDecode})`,
                            encode: `_borsh.write_remainder_map(__VALUE__, lambda _key: ${keyEncode}, lambda _value: ${valueEncode})`,
                        };
                    }
                    const width = prefixWidth(resolveNestedTypeNode(mapType.count.prefix));
                    return {
                        ...base,
                        decode: `_borsh.read_map(__R__, lambda r: ${keyDecode}, lambda r: ${valueDecode}, ${width})`,
                        encode: `_borsh.write_map(__VALUE__, lambda _key: ${keyEncode}, lambda _value: ${valueEncode}, ${width})`,
                    };
                },

                visitNumberType(numberType) {
                    if (numberType.endian !== 'le') {
                        throw new Error('Number endianness not supported by Borsh');
                    }
                    const info = NUMBER_INFO[numberType.format];
                    if (!info) {
                        throw new Error(`Number format not supported: ${numberType.format}`);
                    }
                    return {
                        decode: `__R__.read_${info.fn}()`,
                        encode: `_borsh.write_${info.fn}(__VALUE__)`,
                        exports: [],
                        imports: new ImportMap().add('~shared', 'borsh as _borsh'),
                        nestedDefs: [],
                        type: info.py,
                    };
                },

                visitOptionType(optionType, { self }) {
                    const child = visit(optionType.item, self);
                    const width = prefixWidth(resolveNestedTypeNode(optionType.prefix));
                    const imports = new ImportMap()
                        .mergeWith(child.imports)
                        .addBare('typing')
                        .add('~shared', 'borsh as _borsh');
                    return {
                        decode: `_borsh.read_option(__R__, lambda r: ${applyDecode(child, 'r')}, ${width})`,
                        encode: `_borsh.write_option(__VALUE__, lambda _item: ${applyEncode(child, '_item')}, ${width})`,
                        exports: child.exports,
                        imports,
                        nestedDefs: child.nestedDefs,
                        type: `typing.Optional[${child.type}]`,
                    };
                },

                visitPublicKeyType() {
                    return {
                        decode: 'Pubkey(__R__.read(32))',
                        encode: '__VALUE__.to_bytes()',
                        exports: [],
                        imports: new ImportMap().add('~shared.pubkey', 'Pubkey'),
                        nestedDefs: [],
                        type: 'Pubkey',
                    };
                },

                visitRemainderOptionType(node) {
                    throw new CodamaError(CODAMA_ERROR__RENDERERS__UNSUPPORTED_NODE, { kind: node.kind, node });
                },

                visitSetType(setType, { self }) {
                    const child = visit(setType.item, self);
                    const imports = new ImportMap()
                        .mergeWith(child.imports)
                        .addBare('typing')
                        .add('~shared', 'borsh as _borsh');
                    const itemEncode = applyEncode(child, '_item');
                    const itemDecode = applyDecode(child, 'r');
                    const base = {
                        exports: child.exports,
                        imports,
                        nestedDefs: child.nestedDefs,
                        type: `typing.Set[${child.type}]`,
                    };
                    if (isNode(setType.count, 'fixedCountNode')) {
                        const size = setType.count.value;
                        return {
                            ...base,
                            decode: `_borsh.read_fixed_set(__R__, ${size}, lambda r: ${itemDecode})`,
                            encode: `_borsh.write_fixed_set(__VALUE__, ${size}, lambda _item: ${itemEncode})`,
                        };
                    }
                    if (isNode(setType.count, 'remainderCountNode')) {
                        return {
                            ...base,
                            decode: `_borsh.read_remainder_set(__R__, lambda r: ${itemDecode})`,
                            encode: `_borsh.write_remainder_set(__VALUE__, lambda _item: ${itemEncode})`,
                        };
                    }
                    const width = prefixWidth(resolveNestedTypeNode(setType.count.prefix));
                    return {
                        ...base,
                        decode: `_borsh.read_set(__R__, lambda r: ${itemDecode}, ${width})`,
                        encode: `_borsh.write_set(__VALUE__, lambda _item: ${itemEncode}, ${width})`,
                    };
                },

                visitSizePrefixType(sizePrefixType, { self }) {
                    const saveSize = parentSize;
                    parentSize = resolveNestedTypeNode(sizePrefixType.prefix);
                    const manifest = visit(sizePrefixType.type, self);
                    parentSize = saveSize;
                    return manifest;
                },

                visitStringType() {
                    const imports = new ImportMap().add('~shared', 'borsh as _borsh');
                    if (typeof parentSize === 'number') {
                        return {
                            decode: `__R__.read_fixed_string(${parentSize})`,
                            encode: `_borsh.write_fixed_string(__VALUE__, ${parentSize})`,
                            exports: [],
                            imports,
                            nestedDefs: [],
                            type: 'str',
                        };
                    }
                    if (parentSize && typeof parentSize === 'object') {
                        const width = prefixWidth(parentSize);
                        return {
                            decode: `__R__.read_prefixed_string(${width})`,
                            encode: `_borsh.write_prefixed_string(__VALUE__, ${width})`,
                            exports: [],
                            imports,
                            nestedDefs: [],
                            type: 'str',
                        };
                    }
                    // Remainder string.
                    return {
                        decode: '__R__.read_remainder().decode("utf-8")',
                        encode: '__VALUE__.encode("utf-8")',
                        exports: [],
                        imports: new ImportMap(),
                        nestedDefs: [],
                        type: 'str',
                    };
                },

                visitStructType(structType, { self }) {
                    if (!parentName) {
                        throw new Error('Struct type must have a parent name.');
                    }
                    const className = pascalCase(parentName);
                    const isNested = nestedStruct;
                    const collected = collectFields(structType, className, self);
                    const imports = collected.imports.mergeWith(classManifestImports());
                    const classCode = renderDataClass({
                        className,
                        docs: [],
                        fields: collected.fields,
                        serializePrelude: 'b""',
                        variant: false,
                    });
                    const base = {
                        decode: `${className}.deserialize_reader(__R__)`,
                        encode: '__VALUE__.serialize()',
                        exports: [...collected.exports, className],
                        imports,
                    };
                    if (isNested) {
                        return { ...base, nestedDefs: [...collected.nestedDefs, classCode], type: className };
                    }
                    return { ...base, nestedDefs: collected.nestedDefs, type: classCode };
                },

                visitTupleType(tupleType, { self }) {
                    const items = tupleType.items.map(item => visit(item, self));
                    const imports = new ImportMap().mergeWith(...items.map(i => i.imports)).addBare('typing');
                    const encodeParts = items.map((item, i) => applyEncode(item, `__VALUE__[${i}]`));
                    const encode =
                        items.length === 0
                            ? 'b""'
                            : items.length === 1
                              ? encodeParts[0]
                              : encodeParts.map(part => `(${part})`).join(' + ');
                    const decodeParts = items.map(item => applyDecode(item, '__R__'));
                    const trailingComma = items.length === 1 ? ',' : '';
                    return {
                        decode: `(${decodeParts.join(', ')}${trailingComma})`,
                        encode,
                        exports: items.flatMap(i => i.exports),
                        imports,
                        nestedDefs: items.flatMap(i => i.nestedDefs),
                        type: `typing.Tuple[${items.map(i => i.type).join(', ')}]`,
                    };
                },

                visitZeroableOptionType(node) {
                    throw new CodamaError(CODAMA_ERROR__RENDERERS__UNSUPPORTED_NODE, { kind: node.kind, node });
                },
            }),
    );
}

/** Renders a Borsh-serializable Python `@dataclass`. */
export function renderDataClass(opts: {
    baseClass?: string;
    className: string;
    docs: string[];
    fields: StructField[];
    /** Expression initializing the `_data` buffer (e.g. `'b""'` or a variant index write). */
    serializePrelude: string;
    /** Enum variants use `_deserialize_fields` and omit the byte-level `deserialize`. */
    variant: boolean;
}): string {
    const { baseClass, className, docs, fields, serializePrelude, variant } = opts;
    const lines: string[] = [];
    if (docs.length > 0) lines.push(pyComment(docs));
    lines.push('@dataclass(frozen=True)');
    lines.push(`class ${className}${baseClass ? `(${baseClass})` : ''}:`);
    const visibleFields = fields.filter(f => !f.omitted);
    visibleFields.forEach(field => {
        if (field.docs.length > 0) lines.push(pyComment(field.docs, 4));
        lines.push(`    ${field.name}: ${field.annotation}`);
    });
    if (visibleFields.length > 0) lines.push('');

    lines.push('    def serialize(self) -> bytes:');
    lines.push(`        _data = ${serializePrelude}`);
    fields.forEach(field => {
        lines.push(`        _data += ${field.omitted ? field.encodeDefault : field.encodeSelf}`);
    });
    lines.push('        return _data');
    lines.push('');

    if (!variant) {
        lines.push('    @classmethod');
        lines.push(`    def deserialize(cls, data: bytes) -> "${className}":`);
        lines.push('        return cls.deserialize_reader(Reader(data))');
        lines.push('');
    }

    const decoderName = variant ? '_deserialize_fields' : 'deserialize_reader';
    lines.push('    @classmethod');
    lines.push(`    def ${decoderName}(cls, r: Reader) -> "${className}":`);
    fields.forEach(field => {
        if (field.omitted) {
            lines.push(`        _ = ${field.decode}  # skip omitted field: ${field.name}`);
        } else {
            lines.push(`        _dec_${field.name} = ${field.decode}`);
        }
    });
    lines.push(`        return cls(${visibleFields.map(f => `${f.name}=_dec_${f.name}`).join(', ')})`);
    return lines.join('\n');
}
