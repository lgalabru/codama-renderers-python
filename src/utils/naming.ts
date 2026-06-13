import { pascalCase, snakeCase } from '@codama/nodes';

/** Python reserved keywords (3.9). */
const PY_KEYWORDS = new Set([
    'False',
    'None',
    'True',
    'and',
    'as',
    'assert',
    'async',
    'await',
    'break',
    'class',
    'continue',
    'def',
    'del',
    'elif',
    'else',
    'except',
    'finally',
    'for',
    'from',
    'global',
    'if',
    'import',
    'in',
    'is',
    'lambda',
    'nonlocal',
    'not',
    'or',
    'pass',
    'raise',
    'return',
    'try',
    'while',
    'with',
    'yield',
]);

/** Snake-case name escaped with a trailing underscore when it is a Python keyword. */
export function pyName(name: string): string {
    const snake = snakeCase(name);
    return PY_KEYWORDS.has(snake) ? `${snake}_` : snake;
}

/** Pascal-case name escaped with a trailing underscore when it is a Python keyword. */
export function pyClassName(name: string): string {
    const pascal = pascalCase(name);
    return PY_KEYWORDS.has(pascal) ? `${pascal}_` : pascal;
}
