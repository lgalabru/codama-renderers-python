import { TypeManifest } from './getTypeManifestVisitor';

/**
 * Import map for generated Python modules.
 *
 * Module specifiers starting with `~` reference modules inside the generated
 * package (e.g. `~shared.borsh`, `~types.my_type`, `~programs`). They are
 * resolved to relative imports based on the package the current file lives in.
 * Any other specifier is treated as an absolute Python module.
 *
 * Rendering follows the conventions enforced by `ruff check --select I`
 * (isort): standard library, third-party and local sections separated by
 * blank lines, modules sorted within each section and imported names sorted
 * by kind (constants, classes, then functions/variables).
 */
export class ImportMap {
    protected readonly _bare: Set<string> = new Set();

    protected readonly _named: Map<string, Set<string>> = new Map();

    /** Adds plain `import <module>` statements (e.g. `typing`). */
    addBare(modules: Set<string> | string[] | string): ImportMap {
        const newModules = typeof modules === 'string' ? [modules] : modules;
        newModules.forEach(m => this._bare.add(m));
        return this;
    }

    /** Adds `from <module> import <names>` statements. */
    add(module: string, names: Set<string> | string[] | string): ImportMap {
        const newNames = typeof names === 'string' ? [names] : names;
        const existing = this._named.get(module) ?? new Set<string>();
        newNames.forEach(n => existing.add(n));
        this._named.set(module, existing);
        return this;
    }

    mergeWith(...others: ImportMap[]): ImportMap {
        others.forEach(other => {
            this.addBare(other._bare);
            other._named.forEach((names, module) => this.add(module, names));
        });
        return this;
    }

    mergeWithManifest(manifest: TypeManifest): ImportMap {
        return this.mergeWith(manifest.imports);
    }

    isEmpty(): boolean {
        return this._bare.size === 0 && this._named.size === 0;
    }

    /**
     * Renders the import statements.
     *
     * @param currentPackage - the sub-package the current file lives in
     * (e.g. `'types'`, `'accounts'`, `'instructions'`, `'shared'`) or `''`
     * for files at the root of the generated package.
     * @param omitModules - generated module specifiers to skip (used to avoid
     * self-imports for recursive type definitions).
     * @param dependencyMap - maps custom link override keys to absolute modules.
     */
    toString(currentPackage = '', omitModules: Set<string> = new Set(), dependencyMap: Record<string, string> = {}): string {
        type Section = { bare: string[]; from: { module: string; names: string[] }[] };
        const sections: Record<'local' | 'stdlib' | 'thirdParty', Section> = {
            local: { bare: [], from: [] },
            stdlib: { bare: [], from: [] },
            thirdParty: { bare: [], from: [] },
        };

        [...this._bare].forEach(module => {
            sections[classifyModule(module)].bare.push(module);
        });
        [...this._named.keys()].forEach(module => {
            if (omitModules.has(module)) return;
            const names = [...(this._named.get(module) ?? [])];
            if (names.length === 0) return;
            const resolved = resolveModule(module, currentPackage, dependencyMap);
            sections[classifyModule(resolved)].from.push({ module: resolved, names: sortPythonNames(names) });
        });

        const blocks = [sections.stdlib, sections.thirdParty, sections.local]
            .map(section => renderSection(section))
            .filter(block => block.length > 0);
        return blocks.join('\n\n');
    }
}

/** Standard library modules the renderer may emit imports for. */
const STDLIB_MODULES = new Set([
    'abc',
    'base64',
    'binascii',
    'collections',
    'dataclasses',
    'enum',
    'functools',
    'hashlib',
    'io',
    'itertools',
    'json',
    'math',
    'os',
    're',
    'struct',
    'sys',
    'typing',
]);

function classifyModule(module: string): 'local' | 'stdlib' | 'thirdParty' {
    if (module.startsWith('.')) return 'local';
    const base = module.split('.')[0];
    return STDLIB_MODULES.has(base) ? 'stdlib' : 'thirdParty';
}

function renderSection(section: { bare: string[]; from: { module: string; names: string[] }[] }): string {
    const lines: string[] = [];
    [...section.bare].sort().forEach(module => lines.push(`import ${module}`));
    [...section.from]
        .sort((a, b) => compareModules(a.module, b.module))
        .forEach(({ module, names }) => lines.push(`from ${module} import ${names.join(', ')}`));
    return lines.join('\n');
}

/** Sorts modules the way isort does: deeper relative imports first, then by path. */
function compareModules(a: string, b: string): number {
    const dotsA = countLeadingDots(a);
    const dotsB = countLeadingDots(b);
    if (dotsA !== dotsB) return dotsB - dotsA;
    const pathA = a.slice(dotsA);
    const pathB = b.slice(dotsB);
    return pathA < pathB ? -1 : pathA > pathB ? 1 : 0;
}

function countLeadingDots(module: string): number {
    let count = 0;
    while (count < module.length && module[count] === '.') count += 1;
    return count;
}

/** isort's `order-by-type` groups: constants, then classes, then the rest. */
function importedNameGroup(name: string): number {
    if (/^[A-Z0-9_]+$/.test(name)) return 0;
    if (/^[A-Z]/.test(name)) return 1;
    return 2;
}

/**
 * Sorts Python names the way isort's `order-by-type` does: constants first,
 * then classes, then functions/variables, case-insensitively within each
 * group. Used for `from x import …` name lists and `__all__` declarations.
 */
export function sortPythonNames(names: string[]): string[] {
    return [...names].sort((a, b) => {
        const groupA = importedNameGroup(a);
        const groupB = importedNameGroup(b);
        if (groupA !== groupB) return groupA - groupB;
        const lowerA = a.toLowerCase();
        const lowerB = b.toLowerCase();
        if (lowerA !== lowerB) return lowerA < lowerB ? -1 : 1;
        return a < b ? -1 : a > b ? 1 : 0;
    });
}

function resolveModule(module: string, currentPackage: string, dependencyMap: Record<string, string>): string {
    if (!module.startsWith('~')) {
        return dependencyMap[module] ?? module;
    }
    const path = module.slice(1); // e.g. 'shared.borsh', 'programs', 'types.foo'
    if (currentPackage === '') {
        return `.${path}`;
    }
    const segments = path.split('.');
    if (segments[0] === currentPackage && segments.length > 1) {
        return `.${segments.slice(1).join('.')}`;
    }
    return `..${path}`;
}
