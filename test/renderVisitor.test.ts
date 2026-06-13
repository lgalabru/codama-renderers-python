import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    accountNode,
    numberTypeNode,
    programNode,
    rootNode,
    structFieldTypeNode,
    structTypeNode,
} from '@codama/nodes';
import { visit } from '@codama/visitors-core';
import { describe, expect, test } from 'vitest';

import { renderVisitor } from '../src';

const PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

function buildRoot() {
    return rootNode(
        programNode({
            accounts: [
                accountNode({
                    data: structTypeNode([structFieldTypeNode({ name: 'value', type: numberTypeNode('u64') })]),
                    name: 'thing',
                }),
            ],
            definedTypes: [],
            errors: [],
            instructions: [],
            name: 'test',
            publicKey: PROGRAM_ID,
            version: '1.0.0',
        }),
    );
}

describe('renderVisitor', () => {
    test('writes the generated client to disk without formatting', () => {
        const dir = join(mkdtempSync(join(tmpdir(), 'codama-renderers-python-')), 'generated');
        visit(buildRoot(), renderVisitor(dir, { formatCode: false }));
        expect(existsSync(join(dir, '__init__.py'))).toBe(true);
        expect(existsSync(join(dir, 'shared', 'borsh.py'))).toBe(true);
        expect(readFileSync(join(dir, 'accounts', 'thing.py'), 'utf8')).toContain('class Thing:');
    });

    test('deletes the previous output before rendering by default', () => {
        const dir = join(mkdtempSync(join(tmpdir(), 'codama-renderers-python-')), 'generated');
        visit(buildRoot(), renderVisitor(dir, { formatCode: false }));
        const stale = join(dir, 'stale.py');
        writeFileSync(stale, '# stale');
        visit(buildRoot(), renderVisitor(dir, { formatCode: false }));
        expect(existsSync(stale)).toBe(false);

        // With deletion disabled, stray files survive.
        writeFileSync(stale, '# stale');
        visit(buildRoot(), renderVisitor(dir, { deleteFolderBeforeRendering: false, formatCode: false }));
        expect(existsSync(stale)).toBe(true);
    });

    test('formats the generated code when a formatter is available', () => {
        const dir = join(mkdtempSync(join(tmpdir(), 'codama-renderers-python-')), 'generated');
        // Uses ruff/uvx/black when present and logs a warning otherwise;
        // either way rendering must succeed.
        visit(buildRoot(), renderVisitor(dir));
        expect(existsSync(join(dir, '__init__.py'))).toBe(true);
    });
});
