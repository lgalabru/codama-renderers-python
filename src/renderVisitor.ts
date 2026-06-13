import { logWarn } from '@codama/errors';
import { deleteDirectory, writeRenderMapVisitor } from '@codama/renderers-core';
import { rootNodeVisitor, visit } from '@codama/visitors-core';
import { spawnSync } from 'child_process';

import { GetRenderMapOptions, getRenderMapVisitor } from './getRenderMapVisitor';

export type RenderOptions = GetRenderMapOptions & {
    deleteFolderBeforeRendering?: boolean;
    formatCode?: boolean;
};

export function renderVisitor(path: string, options: RenderOptions = {}) {
    return rootNodeVisitor(root => {
        // Delete existing generated folder.
        if (options.deleteFolderBeforeRendering ?? true) {
            deleteDirectory(path);
        }

        // Render the new files.
        visit(root, writeRenderMapVisitor(getRenderMapVisitor(options), path));

        // Format the generated Python code with `ruff format` (directly or
        // through `uvx`), falling back to `black`. Skip gracefully when no
        // formatter is installed.
        if (options.formatCode ?? true) {
            const formatters: [string, string[]][] = [
                ['ruff', ['format', '--quiet', path]],
                ['uvx', ['ruff', 'format', '--quiet', path]],
                ['black', ['--quiet', path]],
            ];
            for (const [cmd, args] of formatters) {
                if (runFormatter(cmd, args)) return;
            }
            logWarn('Could not find ruff, uvx or black, skipping formatting.');
        }
    });
}

function runFormatter(cmd: string, args: string[]): boolean {
    const { stderr, error, status } = spawnSync(cmd, args);
    if (error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
    }
    if (status !== 0) {
        if (stderr && stderr.length > 0) {
            logWarn(`(${cmd}) ${stderr.toString()}`);
        }
        return false; // Let the next formatter try.
    }
    return true;
}
