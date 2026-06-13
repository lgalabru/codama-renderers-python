import { dirname as pathDirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { camelCase, kebabCase, pascalCase, snakeCase, titleCase } from '@codama/nodes';
import nunjucks, { ConfigureOptions as NunJucksOptions } from 'nunjucks';

/** Renders a list of doc lines as Python `#` comments. */
export function pyComment(docs: string[], indent = 0): string {
    if (docs.length <= 0) return '';
    const pad = ' '.repeat(indent);
    return docs.map(doc => `${pad}# ${doc}`).join('\n');
}

/** Indents every non-empty line by `levels` levels of four spaces. */
export function indent(text: string, levels = 1): string {
    const pad = '    '.repeat(levels);
    return text
        .split('\n')
        .map(line => (line.trim().length === 0 ? '' : pad + line))
        .join('\n');
}

export const render = (template: string, context?: object, options?: NunJucksOptions): string => {
    // @ts-expect-error import.meta will be used in the right environment.
    const dirname = __ESM__ ? pathDirname(fileURLToPath(import.meta.url)) : __dirname;
    const templates = __TEST__ ? join(dirname, '..', '..', 'public', 'templates') : join(dirname, 'templates'); // Path to templates from bundled output file.
    const env = nunjucks.configure(templates, { autoescape: false, trimBlocks: true, ...options });
    env.addFilter('pascalCase', pascalCase);
    env.addFilter('camelCase', camelCase);
    env.addFilter('snakeCase', snakeCase);
    env.addFilter('kebabCase', kebabCase);
    env.addFilter('titleCase', titleCase);
    env.addFilter('upper', (str: string) => str.toUpperCase());
    env.addFilter('pyComment', (docs: string[], indentLevels?: number) => pyComment(docs, (indentLevels ?? 0) * 4));
    return env.render(template, context);
};
