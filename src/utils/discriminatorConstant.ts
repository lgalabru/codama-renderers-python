import {
    ConstantDiscriminatorNode,
    DiscriminatorNode,
    FieldDiscriminatorNode,
    InstructionArgumentNode,
    isNode,
    isNodeFilter,
    snakeCase,
    StructFieldTypeNode,
    VALUE_NODES,
} from '@codama/nodes';
import { visit } from '@codama/visitors-core';

import { applyEncode, getTypeManifestVisitor } from '../getTypeManifestVisitor';
import { ImportMap } from '../ImportMap';
import { renderValueNode } from '../renderValueNodeVisitor';
import { GetImportFromFunction } from './linkOverrides';

type Fragment = { exports: string[]; imports: ImportMap; render: string };

export function getDiscriminatorConstants(scope: {
    discriminatorNodes: DiscriminatorNode[];
    fields: InstructionArgumentNode[] | StructFieldTypeNode[];
    getImportFrom: GetImportFromFunction;
    prefix: string;
    typeManifestVisitor: ReturnType<typeof getTypeManifestVisitor>;
}): Fragment {
    const fragments = scope.discriminatorNodes
        .map(node => getDiscriminatorConstant(node, scope))
        .filter(Boolean) as Fragment[];

    return {
        exports: fragments.flatMap(f => f.exports),
        imports: new ImportMap().mergeWith(...fragments.map(f => f.imports)),
        render: fragments.map(f => f.render).join('\n'),
    };
}

function getDiscriminatorConstant(
    discriminatorNode: DiscriminatorNode,
    scope: {
        discriminatorNodes: DiscriminatorNode[];
        fields: InstructionArgumentNode[] | StructFieldTypeNode[];
        getImportFrom: GetImportFromFunction;
        prefix: string;
        typeManifestVisitor: ReturnType<typeof getTypeManifestVisitor>;
    },
): Fragment | null {
    switch (discriminatorNode.kind) {
        case 'constantDiscriminatorNode':
            return getConstantDiscriminatorConstant(discriminatorNode, scope);
        case 'fieldDiscriminatorNode':
            return getFieldDiscriminatorConstant(discriminatorNode, scope);
        default:
            return null;
    }
}

function getConstantDiscriminatorConstant(
    discriminatorNode: ConstantDiscriminatorNode,
    scope: {
        discriminatorNodes: DiscriminatorNode[];
        getImportFrom: GetImportFromFunction;
        prefix: string;
        typeManifestVisitor: ReturnType<typeof getTypeManifestVisitor>;
    },
): Fragment {
    const { discriminatorNodes, getImportFrom, prefix, typeManifestVisitor } = scope;

    const index = discriminatorNodes.filter(isNodeFilter('constantDiscriminatorNode')).indexOf(discriminatorNode);
    const suffix = index <= 0 ? '' : `_${index + 1}`;

    const name = `${snakeCase(prefix).toUpperCase()}_DISCRIMINATOR${suffix}`;
    const typeManifest = visit(discriminatorNode.constant.type, typeManifestVisitor);
    const value = renderValueNode(discriminatorNode.constant.value, getImportFrom);
    return {
        exports: [name],
        imports: new ImportMap().mergeWith(typeManifest.imports, value.imports),
        render: `${name} = ${applyEncode(typeManifest, value.render)}`,
    };
}

function getFieldDiscriminatorConstant(
    discriminatorNode: FieldDiscriminatorNode,
    scope: {
        fields: InstructionArgumentNode[] | StructFieldTypeNode[];
        getImportFrom: GetImportFromFunction;
        prefix: string;
        typeManifestVisitor: ReturnType<typeof getTypeManifestVisitor>;
    },
): Fragment | null {
    const { fields, getImportFrom, prefix, typeManifestVisitor } = scope;

    const field = (fields as { defaultValue?: unknown; name: string }[]).find(
        f => f.name === discriminatorNode.name,
    ) as InstructionArgumentNode | StructFieldTypeNode | undefined;
    if (!field || !field.defaultValue || !isNode(field.defaultValue, VALUE_NODES)) {
        return null;
    }

    const name = `${snakeCase(prefix).toUpperCase()}_${snakeCase(discriminatorNode.name).toUpperCase()}`;
    const typeManifest = visit(field.type, typeManifestVisitor);
    const value = renderValueNode(field.defaultValue, getImportFrom);
    return {
        exports: [name],
        imports: new ImportMap().mergeWith(typeManifest.imports, value.imports),
        render: `${name} = ${applyEncode(typeManifest, value.render)}`,
    };
}
