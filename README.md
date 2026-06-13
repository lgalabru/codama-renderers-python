# Codama ➤ Renderers ➤ Python

[![npm][npm-image]][npm-url]

[npm-image]: https://img.shields.io/npm/v/@codama/renderers-python.svg?style=flat&label=%40codama%2Frenderers-python
[npm-url]: https://www.npmjs.com/package/@codama/renderers-python

This package generates Python clients from your Codama IDLs.

## Installation

```sh
pnpm install @codama/renderers-python
```

## Usage

Once you have a Codama IDL, you can use the `renderVisitor` of this package to generate Python clients.

```ts
// codama.mjs
import { renderVisitor } from '@codama/renderers-python';

const pathToGeneratedFolder = path.join(__dirname, 'clients', 'python', 'src', 'generated');
const options = {}; // See below.
codama.accept(renderVisitor(pathToGeneratedFolder, options));
```

The following options are available:

| Option                        | Type                      | Default | Description                                                                                                |
| ----------------------------- | ------------------------- | ------- | ---------------------------------------------------------------------------------------------------------- |
| `deleteFolderBeforeRendering` | `boolean`                 | `true`  | Whether to delete the output folder before generating the client.                                          |
| `formatCode`                  | `boolean`                 | `true`  | Whether to format the generated code with `ruff format` (directly or via `uvx`, falling back to `black`); skipped when no formatter is found. |
| `linkOverrides`               | `LinkOverrides`           | `{}`    | Overrides the default import paths for link nodes.                                                          |
| `dependencyMap`               | `Record<string, string>`  | `{}`    | Maps link-override keys to Python module paths.                                                             |
| `renderParentInstructions`    | `boolean`                 | `false` | When using nested instructions, whether to render parent instructions as well.                              |

## The generated client

The generated client is **self-contained** (Python ≥ 3.9, standard library only) and laid out as a package:

```
<generated>/
├── __init__.py            # Explicitly re-exports everything below.
├── programs.py            # <PROGRAM>_PROGRAM_ID / <PROGRAM>_PROGRAM_NAME constants.
├── errors.py              # Error code constants, code → message lookup and a typed <Program>ProgramError.
├── accounts/<name>.py     # One dataclass per account (+ discriminators, sizes, PDA helpers).
├── instructions/<name>.py # Instruction data classes + builder functions.
├── types/<name>.py        # Defined types: dataclasses, IntEnums and tagged unions.
└── shared/                # Runtime: Borsh codecs, Pubkey/base58, PDA derivation (ed25519 on-curve check), errors.
```

### Conventions

The generated code follows a few explicit conventions:

- **Fully typed**: every module uses `from __future__ import annotations` with `typing.Optional/List/Dict/Tuple` annotations (Python 3.9 compatible) and declares `__all__`. The `__init__.py` files use explicit (non-star) re-exports.
- **Frozen value objects**: accounts, defined types, instruction data classes, `AccountMeta` and `Instruction` are `@dataclass(frozen=True)`; `Pubkey` is an immutable `__slots__` value object.
- **Explicit error types** (`shared/errors.py`): `CodamaError` is the base for every raised error; `SerializationError` (and its `PubkeyError` subclass) and `PdaError` also subclass `ValueError` for ergonomic catching. Programs with errors get a typed `<Program>ProgramError` carrying `code` and `message`, plus `get_<program>_error(code)` and `get_<program>_error_message(code)` lookups.
- **Deterministic serialization**: struct fields and sequence items are written in order; map entries and set items are written in ascending key order — by the key's natural ordering when comparable (matching canonical Borsh for integers and strings), falling back to the encoded key bytes (matching Rust's ordering for fixed byte arrays such as pubkeys).
- **Lint clean**: the e2e suite enforces `ruff check` (defaults + import sorting) and `ruff format --check` with `target-version = "py39"` over all generated fixtures (see `e2e/ruff.toml`).

Example:

```python
from generated import transfer_sol, Nonce, Pubkey, find_program_address

ix = transfer_sol(
    source=Pubkey.from_base58("..."),
    destination=Pubkey.from_base58("..."),
    amount=1_000_000,
)
# ix.program_id, ix.accounts ([AccountMeta(pubkey, is_signer, is_writable), ...]), ix.data (bytes)

nonce = Nonce.deserialize(account_data)   # Borsh decoding
data = nonce.serialize()                  # Borsh encoding
pda, bump = find_program_address([b"seed"], Pubkey.from_base58("..."))
```

## Testing

```sh
pnpm build      # Bundle the renderer.
pnpm test:unit  # Vitest unit tests with enforced coverage (see below).
pnpm test:e2e   # Generates clients for the e2e fixtures, syntax-checks, lints (uvx ruff),
                # smoke-tests them, runs the conformance corpus and checks runtime coverage.
```

### Conformance vectors

`e2e/conformance_runner.py` asserts the generated clients against the shared
cross-language corpus in [`../conformance`](../conformance) (see its README
for the vector schema). It loads every `vectors/*.json` file, dispatches on
each vector's `mode` and runs it against the **generated** fixture clients in
`e2e/{system,memo,pump-fun,dummy}/generated`:

- `borsh` — interprets the corpus type-descriptor language against
  `shared/borsh.py` (including the variable-length `shortU16` codec),
- `base58` / `sha256` / `pda` — generic base58 and `Pubkey`, the hashlib-backed
  sha256 path and `find/create_program_address` (incl. the ed25519 on-curve
  check),
- `instruction` / `account` — instruction builders, instruction-data classes
  and account dataclasses, converting portable vector values through the
  fixture IDLs.

Vectors whose `expected` is `{"error": true}` must raise the runtime's typed
errors (`SerializationError` / `PdaError`). `optional` vectors are asserted
when the runtime can honor them and skipped (and counted) otherwise — the only
skip today is `borsh-option-nested-some-none`, because the runtime uses `None`
as its option sentinel and cannot represent `some(none)`. The runner prints
passed/failed/skipped counts per mode and exits non-zero on any failure. If
the corpus directory is missing, it warns and skips gracefully.

### Coverage

- **TypeScript sources**: `pnpm test:unit` runs Vitest with `@vitest/coverage-v8`
  over `src/**` and enforces thresholds (lines/statements/functions ≥ 90%,
  branches ≥ 92%) configured in `vitest.config.mts`.
- **Generated Python**: `e2e/test.sh` measures the generated clients with
  coverage.py (via `uvx coverage`, falling back to `python3 -m coverage`;
  skipped with a warning when neither is available) while running the smoke
  test, the conformance runner and `e2e/runtime_test.py`. The four identical
  copies of the static `shared/` runtime are merged via `e2e/.coveragerc`
  `[paths]` aliasing, reported for the full generated tree, and enforced at
  ≥ 90% lines for the `shared/` runtime.
