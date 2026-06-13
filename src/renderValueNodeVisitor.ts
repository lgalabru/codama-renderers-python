import { bytesValueNode, isNode, pascalCase, RegisteredValueNode, snakeCase, ValueNode } from '@codama/nodes';
import { visit, Visitor } from '@codama/visitors-core';

import { ImportMap } from './ImportMap';
import { getBytesFromBytesValueNode, GetImportFromFunction, pyClassName, pyName } from './utils';

const NUMBER_WRITER_MAP: Record<string, string> = {
    f32: 'write_f32',
    f64: 'write_f64',
    i128: 'write_i128',
    i16: 'write_i16',
    i32: 'write_i32',
    i64: 'write_i64',
    i8: 'write_i8',
    shortU16: 'write_shortu16',
    u128: 'write_u128',
    u16: 'write_u16',
    u32: 'write_u32',
    u64: 'write_u64',
    u8: 'write_u8',
};

export function renderValueNode(
    value: ValueNode,
    getImportFrom?: GetImportFromFunction,
): {
    imports: ImportMap;
    render: string;
} {
    return visit(value, renderValueNodeVisitor(getImportFrom));
}

export function renderValueNodeVisitor(getImportFrom?: GetImportFromFunction): Visitor<
    {
        imports: ImportMap;
        render: string;
    },
    RegisteredValueNode['kind']
> {
    return {
        visitArrayValue(node) {
            const list = node.items.map(v => visit(v, this));
            return {
                imports: new ImportMap().mergeWith(...list.map(c => c.imports)),
                render: `[${list.map(c => c.render).join(', ')}]`,
            };
        },
        visitBooleanValue(node) {
            return {
                imports: new ImportMap(),
                render: node.boolean ? 'True' : 'False',
            };
        },
        visitBytesValue(node) {
            const bytes = getBytesFromBytesValueNode(node);
            return {
                imports: new ImportMap(),
                render: `bytes([${Array.from(bytes).join(', ')}])`,
            };
        },
        visitConstantValue(node) {
            // Constant values render as `bytes` (they are mostly used as PDA
            // seeds and discriminators).
            if (isNode(node.value, 'bytesValueNode')) {
                return visit(node.value, this);
            }
            if (isNode(node.type, 'stringTypeNode') && isNode(node.value, 'stringValueNode')) {
                return visit(bytesValueNode(node.type.encoding, node.value.string), this);
            }
            if (isNode(node.type, 'numberTypeNode') && isNode(node.value, 'numberValueNode')) {
                const writer = NUMBER_WRITER_MAP[node.type.format];
                if (!writer || node.type.endian !== 'le') {
                    throw new Error(`Unsupported constant number type: ${node.type.format} (${node.type.endian})`);
                }
                return {
                    imports: new ImportMap().add('~shared', 'borsh as _borsh'),
                    render: `_borsh.${writer}(${node.value.number})`,
                };
            }
            throw new Error('Unsupported constant value type.');
        },
        visitEnumValue(node) {
            const imports = new ImportMap();
            const enumName = pyClassName(node.enum.name);
            const variantPascal = pascalCase(node.variant);
            const importFrom = getImportFrom?.(node.enum) ?? 'generatedTypes';
            const module = importFrom === 'generatedTypes' ? `~types.${pyName(node.enum.name)}` : importFrom;
            if (!node.value) {
                imports.add(module, enumName);
                return { imports, render: `${enumName}.${snakeCase(node.variant).toUpperCase()}` };
            }
            const variantClass = `${enumName}${variantPascal}`;
            imports.add(module, variantClass);
            const enumValue = visit(node.value, this);
            return {
                imports: imports.mergeWith(enumValue.imports),
                render: `${variantClass}${enumValue.render}`,
            };
        },
        visitMapEntryValue(node) {
            const mapKey = visit(node.key, this);
            const mapValue = visit(node.value, this);
            return {
                imports: mapKey.imports.mergeWith(mapValue.imports),
                render: `${mapKey.render}: ${mapValue.render}`,
            };
        },
        visitMapValue(node) {
            const map = node.entries.map(entry => visit(entry, this));
            return {
                imports: new ImportMap().mergeWith(...map.map(c => c.imports)),
                render: `{${map.map(c => c.render).join(', ')}}`,
            };
        },
        visitNoneValue() {
            return {
                imports: new ImportMap(),
                render: 'None',
            };
        },
        visitNumberValue(node) {
            return {
                imports: new ImportMap(),
                render: node.number.toString(),
            };
        },
        visitPublicKeyValue(node) {
            return {
                imports: new ImportMap().add('~shared.pubkey', 'Pubkey'),
                render: `Pubkey.from_base58("${node.publicKey}")`,
            };
        },
        visitSetValue(node) {
            const set = node.items.map(v => visit(v, this));
            if (set.length === 0) {
                return { imports: new ImportMap(), render: 'set()' };
            }
            return {
                imports: new ImportMap().mergeWith(...set.map(c => c.imports)),
                render: `{${set.map(c => c.render).join(', ')}}`,
            };
        },
        visitSomeValue(node) {
            // Options are rendered as `typing.Optional`, so `some(x)` is just `x`.
            return visit(node.value, this);
        },
        visitStringValue(node) {
            // JSON string literals are valid Python string literals.
            return {
                imports: new ImportMap(),
                render: JSON.stringify(node.string),
            };
        },
        visitStructFieldValue(node) {
            const structValue = visit(node.value, this);
            return {
                imports: structValue.imports,
                render: `${pyName(node.name)}=${structValue.render}`,
            };
        },
        visitStructValue(node) {
            // Rendered as keyword arguments; the parent context (e.g. an enum
            // variant value) prepends the class name.
            const struct = node.fields.map(field => visit(field, this));
            return {
                imports: new ImportMap().mergeWith(...struct.map(c => c.imports)),
                render: `(${struct.map(c => c.render).join(', ')})`,
            };
        },
        visitTupleValue(node) {
            const tuple = node.items.map(v => visit(v, this));
            const trailingComma = tuple.length === 1 ? ',' : '';
            return {
                imports: new ImportMap().mergeWith(...tuple.map(c => c.imports)),
                render: `(${tuple.map(c => c.render).join(', ')}${trailingComma})`,
            };
        },
    };
}
