import { logWarn } from '@codama/errors';
import {
    getAllInstructionsWithSubs,
    getAllPrograms,
    InstructionNode,
    isNode,
    parseDocs,
    pascalCase,
    ProgramNode,
    resolveNestedTypeNode,
    snakeCase,
    structTypeNodeFromInstructionArgumentNodes,
    VALUE_NODES,
} from '@codama/nodes';
import { addToRenderMap, createRenderMap, mergeRenderMaps } from '@codama/renderers-core';
import {
    extendVisitor,
    LinkableDictionary,
    NodeStack,
    pipe,
    recordLinkablesOnFirstVisitVisitor,
    recordNodeStackVisitor,
    staticVisitor,
    visit,
} from '@codama/visitors-core';

import { applyEncode, getTypeManifestVisitor } from './getTypeManifestVisitor';
import { ImportMap, sortPythonNames } from './ImportMap';
import { renderValueNode } from './renderValueNodeVisitor';
import { getDiscriminatorConstants, getImportFromFactory, LinkOverrides, pyName, render } from './utils';

export type GetRenderMapOptions = {
    dependencyMap?: Record<string, string>;
    linkOverrides?: LinkOverrides;
    renderParentInstructions?: boolean;
};

type BuilderParam = { annotation: string; default: string | null; name: string };

/** A generated module together with the public names it defines. */
type ModuleExports = { module: string; names: string[] };

/** Names re-exported from the static `shared` runtime package. */
const SHARED_REEXPORTS = [
    'AccountMeta',
    'CodamaError',
    'Instruction',
    'PdaError',
    'ProgramError',
    'Pubkey',
    'PubkeyError',
    'Reader',
    'SerializationError',
    'base58_decode',
    'base58_encode',
    'borsh',
    'create_program_address',
    'find_program_address',
];

function programIdConstant(program: ProgramNode | null): string {
    return `${snakeCase(program?.name ?? 'program').toUpperCase()}_PROGRAM_ID`;
}

/**
 * Builds the context for an `__init__.py` re-export module: one explicit
 * `from <module> import <names>` group per module (sorted), plus a combined
 * `__all__`. Duplicate names are only re-exported from their first module.
 */
function buildReexportContext(modules: ModuleExports[]): {
    allNames: string[];
    groups: { module: string; names: string[] }[];
} {
    const sorted = [...modules].sort((a, b) => (a.module < b.module ? -1 : a.module > b.module ? 1 : 0));
    const seen = new Set<string>();
    const groups = sorted
        .map(({ module, names }) => {
            const unique = names.filter(name => {
                if (seen.has(name)) {
                    logWarn(`[Python] Name [${name}] is defined more than once and is only re-exported once.`);
                    return false;
                }
                seen.add(name);
                return true;
            });
            return { module, names: sortPythonNames(unique) };
        })
        .filter(group => group.names.length > 0);
    return { allNames: sortPythonNames([...seen]), groups };
}

export function getRenderMapVisitor(options: GetRenderMapOptions = {}) {
    const linkables = new LinkableDictionary();
    const stack = new NodeStack();
    let program: ProgramNode | null = null;

    const renderParentInstructions = options.renderParentInstructions ?? false;
    const dependencyMap = options.dependencyMap ?? {};
    const getImportFrom = getImportFromFactory(options.linkOverrides ?? {});
    const typeManifestVisitor = getTypeManifestVisitor({ getImportFrom });

    // Modules (and their exports) collected while visiting, used to build
    // the explicit re-exports of the `__init__.py` files.
    const accountModules: ModuleExports[] = [];
    const instructionModules: ModuleExports[] = [];
    const typeModules: ModuleExports[] = [];
    const errorExports: string[] = [];

    return pipe(
        staticVisitor(() => createRenderMap(), {
            keys: ['rootNode', 'programNode', 'instructionNode', 'accountNode', 'definedTypeNode'],
        }),
        v =>
            extendVisitor(v, {
                visitAccount(node) {
                    const typeManifest = visit(node, typeManifestVisitor);
                    const imports = new ImportMap().mergeWith(typeManifest.imports);
                    const exports = [...typeManifest.exports];

                    // Discriminator constants.
                    const fields = resolveNestedTypeNode(node.data).fields;
                    const discriminatorConstants = getDiscriminatorConstants({
                        discriminatorNodes: node.discriminators ?? [],
                        fields,
                        getImportFrom,
                        prefix: node.name,
                        typeManifestVisitor,
                    });
                    imports.mergeWith(discriminatorConstants.imports);
                    exports.push(...discriminatorConstants.exports);

                    // Size constant.
                    let sizeConst: string | null = null;
                    if (node.size !== undefined && node.size !== null) {
                        const sizeName = `${snakeCase(node.name).toUpperCase()}_SIZE`;
                        sizeConst = `${sizeName} = ${node.size}`;
                        exports.push(sizeName);
                    }

                    // PDA seed helper.
                    const pdaNode = node.pda ? linkables.get([...stack.getPath(), node.pda]) : undefined;
                    let pda: { functionName: string; params: BuilderParam[]; seedExprs: string[] } | null = null;
                    if (pdaNode) {
                        const params: BuilderParam[] = [];
                        const seedExprs = pdaNode.seeds.map(seed => {
                            if (isNode(seed, 'variablePdaSeedNode')) {
                                const seedManifest = visit(seed.type, typeManifestVisitor);
                                imports.mergeWith(seedManifest.imports);
                                const paramName = pyName(seed.name);
                                params.push({ annotation: seedManifest.type, default: null, name: paramName });
                                return applyEncode(seedManifest, paramName);
                            }
                            if (isNode(seed.value, 'programIdValueNode')) {
                                return `${programIdConstant(program)}.to_bytes()`;
                            }
                            const seedManifest = visit(seed.type, typeManifestVisitor);
                            const valueManifest = renderValueNode(seed.value, getImportFrom);
                            imports.mergeWith(seedManifest.imports, valueManifest.imports);
                            return applyEncode(seedManifest, valueManifest.render);
                        });
                        const functionName = `find_${snakeCase(node.name)}_address`;
                        pda = { functionName, params, seedExprs };
                        exports.push(functionName);
                        imports
                            .addBare('typing')
                            .add('~shared.pda', 'find_program_address')
                            .add('~shared.pubkey', 'Pubkey')
                            .add('~programs', programIdConstant(program));
                    }

                    const uniqueExports = sortPythonNames([...new Set(exports)]);
                    accountModules.push({ module: pyName(node.name), names: uniqueExports });

                    return createRenderMap(`accounts/${pyName(node.name)}.py`, {
                        content: render('accountsPage.njk', {
                            body: [...typeManifest.nestedDefs, typeManifest.type].join('\n\n\n'),
                            discriminatorConstants: discriminatorConstants.render,
                            docs: parseDocs(node.docs),
                            exports: uniqueExports,
                            imports: imports.toString('accounts', new Set(), dependencyMap),
                            pda,
                            programIdConst: programIdConstant(program),
                            sizeConst,
                        }),
                    });
                },

                visitDefinedType(node) {
                    const typeManifest = visit(node, typeManifestVisitor);
                    const imports = new ImportMap().mergeWithManifest(typeManifest);
                    const selfModule = `~types.${pyName(node.name)}`;

                    const uniqueExports = sortPythonNames([...new Set(typeManifest.exports)]);
                    typeModules.push({ module: pyName(node.name), names: uniqueExports });

                    return createRenderMap(`types/${pyName(node.name)}.py`, {
                        content: render('definedTypesPage.njk', {
                            body: [...typeManifest.nestedDefs, typeManifest.type].join('\n\n\n'),
                            docs: parseDocs(node.docs),
                            exports: uniqueExports,
                            imports: imports.toString('types', new Set([selfModule]), dependencyMap),
                        }),
                    });
                },

                visitInstruction(node) {
                    // `typing` and `AccountMeta` are always used by the
                    // builder's annotated `accounts` list.
                    const imports = new ImportMap()
                        .addBare('typing')
                        .add('~shared.instruction', ['AccountMeta', 'Instruction'])
                        .add('~programs', programIdConstant(program));
                    const exports: string[] = [];

                    // Account and argument name conflicts.
                    const accountsAndArgsConflicts = getConflictsForInstructionAccountsAndArgs(node);
                    if (accountsAndArgsConflicts.length > 0) {
                        logWarn(
                            `[Python] Accounts and args of instruction [${node.name}] have the following ` +
                                `conflicting attributes [${accountsAndArgsConflicts.join(', ')}]. ` +
                                `Thus, the conflicting arguments will be suffixed with "_arg". ` +
                                'You may want to rename the conflicting attributes.',
                        );
                    }

                    // Discriminator constants.
                    const discriminatorConstants = getDiscriminatorConstants({
                        discriminatorNodes: node.discriminators ?? [],
                        fields: node.arguments,
                        getImportFrom,
                        prefix: node.name,
                        typeManifestVisitor,
                    });
                    imports.mergeWith(discriminatorConstants.imports);
                    exports.push(...discriminatorConstants.exports);

                    // Instruction data class.
                    const dataClassName = `${pascalCase(node.name)}InstructionData`;
                    const struct = structTypeNodeFromInstructionArgumentNodes(node.arguments);
                    const structVisitor = getTypeManifestVisitor({ getImportFrom, parentName: dataClassName });
                    const typeManifest = visit(struct, structVisitor);
                    imports.mergeWith(typeManifest.imports);
                    exports.push(...typeManifest.exports);

                    // Builder arguments.
                    const requiredArgs: BuilderParam[] = [];
                    const optionalArgs: BuilderParam[] = [];
                    const argFields: { fieldName: string; param: string }[] = [];
                    const argResolutions: { default: string; param: string }[] = [];
                    node.arguments.forEach(argument => {
                        const hasDefaultValue = !!argument.defaultValue && isNode(argument.defaultValue, VALUE_NODES);
                        const omitted = hasDefaultValue && argument.defaultValueStrategy === 'omitted';
                        if (omitted) return;

                        const argumentVisitor = getTypeManifestVisitor({
                            getImportFrom,
                            nestedStruct: true,
                            parentName: dataClassName + pascalCase(argument.name),
                        });
                        const manifest = visit(argument.type, argumentVisitor);
                        // Note: nested definitions are already emitted with the
                        // data class manifest; here we only need the annotation.
                        imports.mergeWith(manifest.imports);

                        const paramName = accountsAndArgsConflicts.includes(argument.name)
                            ? `${pyName(argument.name)}_arg`
                            : pyName(argument.name);
                        argFields.push({ fieldName: pyName(argument.name), param: paramName });

                        if (hasDefaultValue) {
                            const value = renderValueNode(argument.defaultValue!, getImportFrom);
                            imports.mergeWith(value.imports);
                            imports.addBare('typing');
                            optionalArgs.push({
                                annotation: `typing.Optional[${manifest.type}]`,
                                default: 'None',
                                name: paramName,
                            });
                            if (value.render !== 'None') {
                                argResolutions.push({ default: value.render, param: paramName });
                            }
                        } else {
                            requiredArgs.push({ annotation: manifest.type, default: null, name: paramName });
                        }
                    });

                    // Builder accounts.
                    const requiredAccounts: BuilderParam[] = [];
                    const optionalAccounts: BuilderParam[] = [];
                    const accountResolutions: { defaultExpr: string; param: string }[] = [];
                    const accountMetas: {
                        isSignerPy: string;
                        isWritablePy: string;
                        optional: boolean;
                        param: string;
                        strategy: string;
                    }[] = [];
                    node.accounts.forEach(account => {
                        const paramName = pyName(account.name);
                        const hasPkDefault = !!account.defaultValue && isNode(account.defaultValue, 'publicKeyValueNode');
                        if (account.isOptional) {
                            imports.addBare('typing');
                            optionalAccounts.push({
                                annotation: 'typing.Optional[Pubkey]',
                                default: 'None',
                                name: paramName,
                            });
                        } else if (hasPkDefault) {
                            const value = renderValueNode(account.defaultValue!, getImportFrom);
                            imports.mergeWith(value.imports);
                            imports.addBare('typing');
                            optionalAccounts.push({
                                annotation: 'typing.Optional[Pubkey]',
                                default: 'None',
                                name: paramName,
                            });
                            accountResolutions.push({ defaultExpr: value.render, param: paramName });
                        } else {
                            requiredAccounts.push({ annotation: 'Pubkey', default: null, name: paramName });
                        }
                        accountMetas.push({
                            // `isSigner === 'either'` is treated as a non-signer in the builder.
                            isSignerPy: account.isSigner === true ? 'True' : 'False',
                            isWritablePy: account.isWritable ? 'True' : 'False',
                            optional: account.isOptional ?? false,
                            param: paramName,
                            strategy: node.optionalAccountStrategy ?? 'programId',
                        });
                    });

                    const hasRemainingAccounts = (node.remainingAccounts ?? []).length > 0;
                    if (node.accounts.length > 0) {
                        imports.add('~shared.pubkey', 'Pubkey');
                    }

                    const params: BuilderParam[] = [
                        ...requiredAccounts,
                        ...requiredArgs,
                        ...optionalAccounts,
                        ...optionalArgs,
                        ...(hasRemainingAccounts
                            ? [
                                  {
                                      annotation: 'typing.Optional[typing.List[AccountMeta]]',
                                      default: 'None',
                                      name: 'remaining_accounts',
                                  },
                              ]
                            : []),
                    ];

                    const functionName = pyName(node.name);
                    exports.push(functionName);

                    const uniqueExports = sortPythonNames([...new Set(exports)]);
                    instructionModules.push({ module: pyName(node.name), names: uniqueExports });

                    return createRenderMap(`instructions/${pyName(node.name)}.py`, {
                        content: render('instructionsPage.njk', {
                            accountMetas,
                            accountResolutions,
                            argFields,
                            argResolutions,
                            dataClass: [...typeManifest.nestedDefs, typeManifest.type].join('\n\n\n'),
                            dataClassName,
                            discriminatorConstants: discriminatorConstants.render,
                            docs: parseDocs(node.docs),
                            exports: uniqueExports,
                            functionName,
                            hasRemainingAccounts,
                            imports: imports.toString('instructions', new Set(), dependencyMap),
                            params,
                            programIdConst: programIdConstant(program),
                        }),
                    });
                },

                visitProgram(node, { self }) {
                    program = node;
                    let renders = mergeRenderMaps([
                        ...node.accounts.map(account => visit(account, self)),
                        ...node.definedTypes.map(type => visit(type, self)),
                        ...getAllInstructionsWithSubs(node, {
                            leavesOnly: !renderParentInstructions,
                        }).map(ix => visit(ix, self)),
                    ]);

                    // Errors.
                    if (node.errors.length > 0) {
                        const prefix = snakeCase(node.name).toUpperCase();
                        const errors = [...node.errors]
                            .sort((a, b) => a.code - b.code)
                            .map(error => ({
                                code: error.code,
                                constName: `${prefix}_ERROR__${snakeCase(error.name).toUpperCase()}`,
                                docs: parseDocs(error.docs),
                                messagePy: JSON.stringify(error.message),
                            }));
                        const dictName = `${prefix}_ERROR_MESSAGES`;
                        const errorClassName = `${pascalCase(node.name)}ProgramError`;
                        const functionName = `get_${snakeCase(node.name)}_error_message`;
                        const errorLookupFunctionName = `get_${snakeCase(node.name)}_error`;
                        const exports = sortPythonNames([
                            ...errors.map(e => e.constName),
                            dictName,
                            errorClassName,
                            functionName,
                            errorLookupFunctionName,
                        ]);
                        errorExports.push(...exports);
                        renders = addToRenderMap(renders, 'errors.py', {
                            content: render('errorsPage.njk', {
                                dictName,
                                errorClassName,
                                errorLookupFunctionName,
                                errors,
                                exports,
                                functionName,
                                programName: node.name,
                            }),
                        });
                    }

                    program = null;
                    return renders;
                },

                visitRoot(node, { self }) {
                    const programsToExport = getAllPrograms(node);

                    // Visit programs first so module lists are populated.
                    const programRenders = programsToExport.map(p => visit(p, self));

                    const programsCtx = programsToExport.map(p => ({
                        idConst: programIdConstant(p),
                        name: p.name,
                        nameConst: `${snakeCase(p.name).toUpperCase()}_PROGRAM_NAME`,
                        publicKey: p.publicKey,
                    }));
                    const programExports = sortPythonNames(programsCtx.flatMap(p => [p.nameConst, p.idConst]));

                    // Subpackage `__init__.py` contexts (explicit re-exports).
                    const accountsInit = buildReexportContext(accountModules);
                    const instructionsInit = buildReexportContext(instructionModules);
                    const typesInit = buildReexportContext(typeModules);

                    // Root `__init__.py`: re-export everything explicitly.
                    const rootInit = buildReexportContext([
                        { module: '.programs', names: programExports },
                        { module: '.shared', names: SHARED_REEXPORTS },
                        ...(errorExports.length > 0 ? [{ module: '.errors', names: errorExports }] : []),
                        ...(typesInit.allNames.length > 0 ? [{ module: '.types', names: typesInit.allNames }] : []),
                        ...(accountsInit.allNames.length > 0
                            ? [{ module: '.accounts', names: accountsInit.allNames }]
                            : []),
                        ...(instructionsInit.allNames.length > 0
                            ? [{ module: '.instructions', names: instructionsInit.allNames }]
                            : []),
                    ]);

                    let renders = createRenderMap({
                        ['__init__.py']: {
                            content: render('rootMod.njk', {
                                allNames: rootInit.allNames,
                                reexports: rootInit.groups,
                            }),
                        },
                        ['programs.py']: {
                            content: render('programsPage.njk', {
                                exports: programExports,
                                programs: programsCtx,
                            }),
                        },
                        ['shared/__init__.py']: { content: render('sharedInit.njk') },
                        ['shared/borsh.py']: { content: render('sharedBorsh.njk') },
                        ['shared/errors.py']: { content: render('sharedErrors.njk') },
                        ['shared/instruction.py']: { content: render('sharedInstruction.njk') },
                        ['shared/pda.py']: { content: render('sharedPda.njk') },
                        ['shared/pubkey.py']: { content: render('sharedPubkey.njk') },
                    });

                    if (accountModules.length > 0) {
                        renders = addToRenderMap(renders, 'accounts/__init__.py', {
                            content: render('subpackageMod.njk', {
                                allNames: accountsInit.allNames,
                                modules: accountsInit.groups,
                            }),
                        });
                    }
                    if (instructionModules.length > 0) {
                        renders = addToRenderMap(renders, 'instructions/__init__.py', {
                            content: render('subpackageMod.njk', {
                                allNames: instructionsInit.allNames,
                                modules: instructionsInit.groups,
                            }),
                        });
                    }
                    if (typeModules.length > 0) {
                        renders = addToRenderMap(renders, 'types/__init__.py', {
                            content: render('subpackageMod.njk', {
                                allNames: typesInit.allNames,
                                modules: typesInit.groups,
                            }),
                        });
                    }

                    return mergeRenderMaps([renders, ...programRenders]);
                },
            }),
        v => recordNodeStackVisitor(v, stack),
        v => recordLinkablesOnFirstVisitVisitor(v, linkables),
    );
}

function getConflictsForInstructionAccountsAndArgs(instruction: InstructionNode): string[] {
    const allNames = [
        ...instruction.accounts.map(account => account.name),
        ...instruction.arguments.map(argument => argument.name),
    ];
    const duplicates = allNames.filter((e, i, a) => a.indexOf(e) !== i);
    return [...new Set(duplicates)];
}
