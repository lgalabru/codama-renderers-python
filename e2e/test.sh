#!/usr/bin/env bash
set -eux

function test_project() {
    ./e2e/generate.cjs $1
    python3 -m compileall -q e2e/$1/generated
}

test_project dummy
test_project system
test_project memo
test_project pump-fun

# The generated clients (and the e2e test scripts) must be lint-clean and
# formatted. Configuration lives in e2e/ruff.toml (target-version py39).
uvx ruff check e2e
uvx ruff format --check e2e

# Locate coverage.py (optional): prefer uvx, fall back to a local install.
# When it is missing, the tests still run but coverage is skipped.
COVERAGE=""
if command -v uvx >/dev/null 2>&1 && uvx coverage --version >/dev/null 2>&1; then
    COVERAGE="uvx coverage"
elif python3 -m coverage --version >/dev/null 2>&1; then
    COVERAGE="python3 -m coverage"
else
    echo "WARNING: coverage.py not found (tried uvx and python3 -m coverage);" \
        "running e2e tests without coverage." >&2
fi

function run_py() {
    if [ -n "$COVERAGE" ]; then
        $COVERAGE run --rcfile=e2e/.coveragerc -p "$@"
    else
        python3 "$@"
    fi
}

[ -z "$COVERAGE" ] || rm -f .coverage .coverage.*

# The smoke test, the cross-language conformance runner (see ../conformance)
# and the supplemental runtime tests.
run_py e2e/smoke_test.py
run_py e2e/conformance_runner.py
run_py e2e/runtime_test.py

if [ -n "$COVERAGE" ]; then
    $COVERAGE combine --rcfile=e2e/.coveragerc
    # Informational: line coverage of the full generated tree.
    $COVERAGE report --rcfile=e2e/.coveragerc --include='*/e2e/*/generated/*'
    # Enforced: the static shared/ runtime must stay >= 90% line coverage.
    $COVERAGE report --rcfile=e2e/.coveragerc \
        --include='*/e2e/*/generated/shared/*' --fail-under=90
    rm -f .coverage
fi
