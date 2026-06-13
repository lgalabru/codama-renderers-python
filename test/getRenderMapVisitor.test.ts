import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
    accountNode,
    definedTypeNode,
    instructionAccountNode,
    instructionArgumentNode,
    instructionNode,
    numberTypeNode,
    numberValueNode,
    programNode,
    publicKeyValueNode,
    rootNode,
    structFieldTypeNode,
    structTypeNode,
} from '@codama/nodes';
import { visit } from '@codama/visitors-core';
import { describe, expect, test, vi } from 'vitest';

import { getRenderMapVisitor } from '../src';

const PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

function loadFixtureRoot(project: string) {
    const idl = JSON.parse(readFileSync(join(__dirname, '..', 'e2e', project, 'idl.json'), 'utf8')) as {
        program: Parameters<typeof rootNode>[0];
    };
    return rootNode(idl.program);
}

function renderToMap(root: ReturnType<typeof rootNode>, options = {}) {
    const renderMap = visit(root, getRenderMapVisitor(options)) as Map<string, { content: string }>;
    const files = new Map<string, string>();
    for (const [key, fragment] of renderMap.entries()) {
        files.set(key, fragment.content);
    }
    return files;
}

describe('getRenderMapVisitor', () => {
    test('renders the system fixture (errors, scalar enums, field discriminators)', () => {
        const files = renderToMap(loadFixtureRoot('system'));
        expect(files.get('errors.py')).toContain('SYSTEM_ERROR__ACCOUNT_ALREADY_IN_USE = 0');
        expect(files.get('errors.py')).toContain('class SystemProgramError(ProgramError):');
        expect(files.get('accounts/nonce.py')).toContain('NONCE_SIZE = 80');
        expect(files.get('instructions/transfer_sol.py')).toContain(
            'TRANSFER_SOL_DISCRIMINATOR = _borsh.write_u32(2)',
        );
        expect(files.get('programs.py')).toContain('SYSTEM_PROGRAM_ID = Pubkey.from_base58');
        expect(files.get('shared/borsh.py')).toContain('def write_shortu16(value: int) -> bytes:');
    });

    test('renders the pump-fun fixture (bytes discriminators, account defaults)', () => {
        const files = renderToMap(loadFixtureRoot('pump-fun'));
        expect(files.get('accounts/bonding_curve.py')).toContain(
            'BONDING_CURVE_DISCRIMINATOR = _borsh.write_fixed_bytes(bytes([23, 183, 248, 55, 96, 216, 172, 96]), 8)',
        );
        // Constant public-key account defaults resolve when omitted.
        expect(files.get('instructions/buy.py')).toContain('if system_program is None:');
        expect(files.get('instructions/buy.py')).toContain(
            'system_program = Pubkey.from_base58("11111111111111111111111111111111")',
        );
    });

    test('renders the memo and dummy fixtures (remaining accounts, optional accounts)', () => {
        const memo = renderToMap(loadFixtureRoot('memo'));
        expect(memo.get('instructions/add_memo.py')).toContain('remaining_accounts');

        const dummy = renderToMap(loadFixtureRoot('dummy'));
        // instruction5: optional argument resolved to its default.
        expect(dummy.get('instructions/instruction5.py')).toContain('if my_argument is None:');
        // instruction7: optional account using the programId strategy.
        expect(dummy.get('instructions/instruction7.py')).toContain('else DUMMY_PROGRAM_ID');
    });

    test('renders optional accounts with the omitted strategy', () => {
        const root = rootNode(
            programNode({
                accounts: [],
                definedTypes: [],
                errors: [],
                instructions: [
                    instructionNode({
                        accounts: [
                            instructionAccountNode({
                                isOptional: true,
                                isSigner: false,
                                isWritable: true,
                                name: 'myAccount',
                            }),
                        ],
                        arguments: [],
                        name: 'withOmitted',
                        optionalAccountStrategy: 'omitted',
                    }),
                ],
                name: 'test',
                publicKey: PROGRAM_ID,
                version: '1.0.0',
            }),
        );
        const content = renderToMap(root).get('instructions/with_omitted.py')!;
        expect(content).toContain('if my_account is not None:');
        expect(content).toContain('accounts.append(AccountMeta(pubkey=my_account');
    });

    test('honors link overrides and the dependency map', () => {
        const root = loadFixtureRoot('system');
        const files = renderToMap(root, {
            dependencyMap: { external: 'my_pkg.types' },
            linkOverrides: { definedTypes: { nonceState: 'external' } },
        });
        expect(files.get('accounts/nonce.py')).toContain('from my_pkg.types import NonceState');
        expect(files.has('types/nonce_state.py')).toBe(true);
    });

    test('warns on conflicting account and argument names', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const conflicting = rootNode(
                programNode({
                    accounts: [],
                    definedTypes: [],
                    errors: [],
                    instructions: [
                        instructionNode({
                            accounts: [
                                instructionAccountNode({ isSigner: true, isWritable: false, name: 'payload' }),
                            ],
                            arguments: [
                                instructionArgumentNode({ name: 'payload', type: numberTypeNode('u8') }),
                                instructionArgumentNode({
                                    defaultValue: numberValueNode(0),
                                    name: 'other',
                                    type: numberTypeNode('u8'),
                                }),
                            ],
                            name: 'conflicted',
                        }),
                    ],
                    name: 'test',
                    publicKey: PROGRAM_ID,
                    version: '1.0.0',
                }),
            );
            const files = renderToMap(conflicting);
            const content = files.get('instructions/conflicted.py')!;
            expect(content).toContain('payload_arg: int');
            expect(content).toContain('payload=payload_arg');
            expect(warn).toHaveBeenCalled();
        } finally {
            warn.mockRestore();
        }
    });

    test('warns when a name is re-exported more than once', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            // An account and a defined type with the same name both export
            // the `Config` class from the root `__init__.py`.
            const duplicated = rootNode(
                programNode({
                    accounts: [
                        accountNode({
                            data: structTypeNode([
                                structFieldTypeNode({ name: 'value', type: numberTypeNode('u8') }),
                            ]),
                            name: 'config',
                        }),
                    ],
                    definedTypes: [definedTypeNode({ name: 'config', type: structTypeNode([]) })],
                    errors: [],
                    instructions: [],
                    name: 'test',
                    publicKey: PROGRAM_ID,
                    version: '1.0.0',
                }),
            );
            renderToMap(duplicated);
            expect(warn).toHaveBeenCalled();
        } finally {
            warn.mockRestore();
        }
    });

    test('renders signer defaults for optional accounts with public-key defaults', () => {
        const root = rootNode(
            programNode({
                accounts: [],
                definedTypes: [],
                errors: [],
                instructions: [
                    instructionNode({
                        accounts: [
                            instructionAccountNode({
                                defaultValue: publicKeyValueNode('11111111111111111111111111111111'),
                                isSigner: 'either',
                                isWritable: true,
                                name: 'helper',
                            }),
                        ],
                        arguments: [],
                        name: 'withDefault',
                    }),
                ],
                name: 'test',
                publicKey: PROGRAM_ID,
                version: '1.0.0',
            }),
        );
        const content = renderToMap(root).get('instructions/with_default.py')!;
        // `isSigner: 'either'` is treated as a non-signer.
        expect(content).toContain('is_signer=False');
        expect(content).toContain('if helper is None:');
    });
});
