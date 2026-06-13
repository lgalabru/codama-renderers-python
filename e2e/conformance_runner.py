#!/usr/bin/env python3
"""Cross-language conformance runner for the generated Python clients.

Loads every vector from `../../conformance/vectors/*.json` (see the corpus
README for the schema) and asserts it against the GENERATED runtime: the
fixture clients in `e2e/{system,memo,pump-fun,dummy}/generated` must have been
generated first (`e2e/test.sh` does this).

Run from the package root: `python3 e2e/conformance_runner.py`.

Exits non-zero on any failure and prints passed / failed / skipped counts per
mode. `optional` vectors the runtime cannot honor are skipped, not failed.
"""

import hashlib
import importlib.util
import json
import os
import sys
import typing
from types import ModuleType

E2E_DIR = os.path.dirname(os.path.abspath(__file__))
VECTORS_DIR = os.path.normpath(
    os.path.join(E2E_DIR, "..", "..", "conformance", "vectors")
)

# Python keywords that `pyName` escapes with a trailing underscore.
_PY_KEYWORDS = frozenset(
    "False None True and as assert async await break class continue def del elif "
    "else except finally for from global if import in is lambda nonlocal not or "
    "pass raise return try while with yield".split()
)


class SkipVector(Exception):
    """Raised when a vector exercises behavior this runtime cannot honor."""


def load_package(name: str, path: str) -> ModuleType:
    init = os.path.join(path, "__init__.py")
    if not os.path.exists(init):
        raise SystemExit(
            "missing generated client at %s -- run `./e2e/generate.cjs` first" % path
        )
    spec = importlib.util.spec_from_file_location(
        name, init, submodule_search_locations=[path]
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def snake_case(name: str) -> str:
    out = []
    for char in name:
        if char.isupper():
            out.append("_")
            out.append(char.lower())
        else:
            out.append(char)
    snake = "".join(out).lstrip("_")
    return snake + "_" if snake in _PY_KEYWORDS else snake


def pascal_case(name: str) -> str:
    snake = snake_case(name).rstrip("_")
    return "".join(part.capitalize() for part in snake.split("_") if part)


# ---------------------------------------------------------------------------
# Borsh type-descriptor interpreter.
#
# A descriptor maps to three functions against the generated runtime:
# convert (portable JSON value -> Python value), encode (Python value ->
# bytes) and decode (Reader -> Python value).
# ---------------------------------------------------------------------------

_INT_FORMATS = ("u8", "u16", "u32", "u64", "u128", "i8", "i16", "i32", "i64", "i128")


class BorshCodec:
    def __init__(
        self,
        convert: typing.Callable[[typing.Any], typing.Any],
        encode: typing.Callable[[typing.Any], bytes],
        decode: typing.Callable[[typing.Any], typing.Any],
    ) -> None:
        self.convert = convert
        self.encode = encode
        self.decode = decode


def make_codec(descriptor: typing.Any, runtime: ModuleType) -> BorshCodec:
    """Interprets a corpus type descriptor against `shared/borsh.py`."""
    borsh = runtime.borsh
    if isinstance(descriptor, str):
        if descriptor in _INT_FORMATS or descriptor in ("f32", "f64"):
            cast = float if descriptor.startswith("f") else int
            return BorshCodec(
                cast,
                getattr(borsh, "write_" + descriptor),
                lambda r, name=descriptor: getattr(r, "read_" + name)(),
            )
        if descriptor == "bool":
            return BorshCodec(bool, borsh.write_bool, lambda r: r.read_bool())
        if descriptor == "shortu16":
            return BorshCodec(int, borsh.write_shortu16, lambda r: r.read_shortu16())
        if descriptor == "string":
            return BorshCodec(
                str, borsh.write_prefixed_string, lambda r: r.read_prefixed_string()
            )
        if descriptor == "bytes":
            return BorshCodec(
                bytes.fromhex,
                borsh.write_prefixed_bytes,
                lambda r: r.read_prefixed_bytes(),
            )
        if descriptor == "pubkey":
            return BorshCodec(
                runtime.Pubkey.from_base58,
                lambda v: v.to_bytes(),
                lambda r: runtime.Pubkey(r.read(32)),
            )
        raise SkipVector("unsupported type descriptor: %r" % descriptor)
    if not isinstance(descriptor, dict) or len(descriptor) != 1:
        raise SkipVector("unsupported type descriptor: %r" % descriptor)
    kind, arg = next(iter(descriptor.items()))
    if kind == "option":
        item = make_codec(arg, runtime)

        def convert_option(value: typing.Any) -> typing.Any:
            if value is None:
                return None
            inner = value["some"]
            if inner is None:
                # The runtime uses None as its none sentinel, so some(none)
                # is not representable (it collapses to none).
                raise SkipVector("cannot represent some(none)")
            return item.convert(inner)

        return BorshCodec(
            convert_option,
            lambda v: borsh.write_option(v, item.encode),
            lambda r: borsh.read_option(r, item.decode),
        )
    if kind == "fixedBytes":
        return BorshCodec(
            bytes.fromhex,
            lambda v: borsh.write_fixed_bytes(v, arg),
            lambda r: r.read(arg),
        )
    if kind == "vec":
        item = make_codec(arg, runtime)
        return BorshCodec(
            lambda v: [item.convert(x) for x in v],
            lambda v: borsh.write_vec(v, item.encode),
            lambda r: borsh.read_vec(r, item.decode),
        )
    if kind == "array":
        item = make_codec(arg["item"], runtime)
        size = arg["size"]
        return BorshCodec(
            lambda v: [item.convert(x) for x in v],
            lambda v: borsh.write_fixed_array(v, size, item.encode),
            lambda r: borsh.read_fixed_array(r, size, item.decode),
        )
    if kind == "map":
        key = make_codec(arg["key"], runtime)
        value = make_codec(arg["value"], runtime)
        return BorshCodec(
            lambda v: {key.convert(k): value.convert(x) for k, x in v},
            lambda v: borsh.write_map(v, key.encode, value.encode),
            lambda r: borsh.read_map(r, key.decode, value.decode),
        )
    if kind == "set":
        item = make_codec(arg, runtime)
        return BorshCodec(
            lambda v: {item.convert(x) for x in v},
            lambda v: borsh.write_set(v, item.encode),
            lambda r: borsh.read_set(r, item.decode),
        )
    if kind == "tuple":
        items = [make_codec(t, runtime) for t in arg]
        return BorshCodec(
            lambda v: tuple(item.convert(x) for item, x in zip(items, v)),
            lambda v: b"".join(item.encode(x) for item, x in zip(items, v)),
            lambda r: tuple(item.decode(r) for item in items),
        )
    raise SkipVector("unsupported type descriptor: %r" % descriptor)


# ---------------------------------------------------------------------------
# IDL-driven value conversion for instruction args and account fields.
# ---------------------------------------------------------------------------


def make_idl_converter(
    type_node: dict, module: ModuleType, defined_types: dict
) -> typing.Callable[[typing.Any], typing.Any]:
    """Builds a portable-JSON -> Python converter from a Codama IDL type node."""
    kind = type_node["kind"]
    if kind == "numberTypeNode":
        return float if type_node["format"] in ("f32", "f64") else int
    if kind == "booleanTypeNode":
        return bool
    if kind == "publicKeyTypeNode":
        return module.Pubkey.from_base58
    if kind == "stringTypeNode":
        return str
    if kind == "bytesTypeNode":
        return bytes.fromhex
    if kind in ("sizePrefixTypeNode", "fixedSizeTypeNode"):
        return make_idl_converter(type_node["type"], module, defined_types)
    if kind == "optionTypeNode":
        item = make_idl_converter(type_node["item"], module, defined_types)
        return lambda v: None if v is None else item(v)
    if kind == "arrayTypeNode":
        item = make_idl_converter(type_node["item"], module, defined_types)
        return lambda v: [item(x) for x in v]
    if kind == "tupleTypeNode":
        items = [
            make_idl_converter(t, module, defined_types) for t in type_node["items"]
        ]
        return lambda v: tuple(item(x) for item, x in zip(items, v))
    if kind == "definedTypeLinkNode":
        name = type_node["name"]
        target = defined_types[name]
        target_kind = target["type"]["kind"]
        cls = getattr(module, pascal_case(name))
        if target_kind == "enumTypeNode":
            # Scalar enums are their numeric variant index in the corpus.
            return lambda v: cls(int(v))
        if target_kind == "structTypeNode":
            field_converters = {
                field["name"]: make_idl_converter(field["type"], module, defined_types)
                for field in target["type"]["fields"]
            }
            return lambda v: cls(
                **{snake_case(k): field_converters[k](x) for k, x in v.items()}
            )
        # Type aliases (e.g. pump's OptionBool tuple).
        return make_idl_converter(target["type"], module, defined_types)
    raise SkipVector("unsupported IDL type node: %s" % kind)


def load_idl_program(project: str) -> dict:
    with open(os.path.join(E2E_DIR, project, "idl.json")) as f:
        return json.load(f)["program"]


# ---------------------------------------------------------------------------
# Runner.
# ---------------------------------------------------------------------------


class Runner:
    def __init__(self) -> None:
        self.modules = {
            "system": load_package(
                "system_generated", os.path.join(E2E_DIR, "system", "generated")
            ),
            "pump": load_package(
                "pump_generated", os.path.join(E2E_DIR, "pump-fun", "generated")
            ),
            "memo": load_package(
                "memo_generated", os.path.join(E2E_DIR, "memo", "generated")
            ),
            "dummy": load_package(
                "dummy_generated", os.path.join(E2E_DIR, "dummy", "generated")
            ),
        }
        self.idls = {
            "system": load_idl_program("system"),
            "pump": load_idl_program("pump-fun"),
            "memo": load_idl_program("memo"),
            "dummy": load_idl_program("dummy"),
        }
        # Any client works for mode dispatch; they all ship the same runtime.
        self.runtime = self.modules["system"]
        self.counts: typing.Dict[str, typing.List[int]] = {}
        self.failures: typing.List[str] = []

    # -- assertion helpers --------------------------------------------------

    def check(self, condition: bool, message: str) -> None:
        if not condition:
            raise AssertionError(message)

    def expect_error(
        self, fn: typing.Callable[[], typing.Any], error: type, what: str
    ) -> None:
        try:
            result = fn()
        except error:
            return
        except Exception as exc:  # noqa: BLE001 -- report untyped errors as failures
            raise AssertionError(
                "%s raised %r instead of a typed %s" % (what, exc, error.__name__)
            ) from exc
        raise AssertionError("%s returned %r instead of raising" % (what, result))

    # -- mode handlers ------------------------------------------------------

    def run_borsh(self, vector: dict) -> None:
        runtime = self.runtime
        codec = make_codec(vector["input"]["type"], runtime)
        direction = vector["input"].get("direction")
        expected = vector["expected"]

        if direction == "decode":
            data = bytes.fromhex(vector["input"]["hex"])
            if expected.get("error"):
                self.expect_error(
                    lambda: codec.decode(runtime.Reader(data)),
                    runtime.SerializationError,
                    "decode",
                )
                return
            decoded = codec.decode(runtime.Reader(data))
            value = codec.convert(expected["value"])
            self.check(decoded == value, "decoded %r != %r" % (decoded, value))
            return

        value = codec.convert(vector["input"]["value"])
        encoded = codec.encode(value)
        self.check(
            encoded.hex() == expected["hex"],
            "encoded %s != %s" % (encoded.hex(), expected["hex"]),
        )
        if direction == "encode":
            return
        reader = runtime.Reader(bytes.fromhex(expected["hex"]))
        decoded = codec.decode(reader)
        self.check(decoded == value, "decoded %r != %r" % (decoded, value))
        self.check(reader.remaining == 0, "%d trailing bytes" % reader.remaining)

    def run_base58(self, vector: dict) -> None:
        runtime = self.runtime
        encoded = vector["input"]["base58"]
        expected = vector["expected"]
        if vector["input"]["as"] == "pubkey":
            if expected.get("error"):
                self.expect_error(
                    lambda: runtime.Pubkey.from_base58(encoded),
                    runtime.PubkeyError,
                    "Pubkey.from_base58",
                )
                return
            raw = bytes.fromhex(expected["hex"])
            self.check(
                runtime.Pubkey.from_base58(encoded).to_bytes() == raw,
                "pubkey decode mismatch",
            )
            self.check(
                runtime.Pubkey(raw).to_base58() == encoded, "pubkey encode mismatch"
            )
            return
        if expected.get("error"):
            self.expect_error(
                lambda: runtime.base58_decode(encoded),
                runtime.SerializationError,
                "base58_decode",
            )
            return
        raw = bytes.fromhex(expected["hex"])
        decoded = runtime.base58_decode(encoded)
        self.check(decoded == raw, "decoded %s != %s" % (decoded.hex(), raw.hex()))
        self.check(
            runtime.base58_encode(raw) == encoded,
            "encoded %r != %r" % (runtime.base58_encode(raw), encoded),
        )

    def run_sha256(self, vector: dict) -> None:
        # The generated runtime delegates sha256 to hashlib (see
        # shared/pda.py); these vectors pin that hashing path.
        spec = vector["input"]
        if "utf8" in spec:
            data = spec["utf8"].encode("utf-8")
        elif "hex" in spec:
            data = bytes.fromhex(spec["hex"])
        else:
            repeat = spec["repeat"]
            data = repeat["utf8"].encode("utf-8") * repeat["count"]
        digest = hashlib.sha256(data).hexdigest()
        self.check(
            digest == vector["expected"]["hex"],
            "digest %s != %s" % (digest, vector["expected"]["hex"]),
        )

    def run_pda(self, vector: dict) -> None:
        runtime = self.runtime
        spec = vector["input"]
        expected = vector["expected"]
        if spec["op"] == "isOnCurve":
            pda_module = sys.modules[runtime.create_program_address.__module__]
            on_curve = pda_module._is_on_curve(bytes.fromhex(spec["bytes"]))
            self.check(
                on_curve is expected["onCurve"],
                "isOnCurve %r != %r" % (on_curve, expected["onCurve"]),
            )
            return
        seeds = [bytes.fromhex(seed) for seed in spec["seeds"]]
        program_id = runtime.Pubkey.from_base58(spec["programId"])
        if spec["op"] == "findProgramAddress":
            address, bump = runtime.find_program_address(seeds, program_id)
            self.check(
                address.to_base58() == expected["address"],
                "address %s != %s" % (address, expected["address"]),
            )
            self.check(
                bump == expected["bump"], "bump %d != %d" % (bump, expected["bump"])
            )
            return
        if expected.get("error"):
            self.expect_error(
                lambda: runtime.create_program_address(seeds, program_id),
                runtime.PdaError,
                "create_program_address",
            )
            return
        address = runtime.create_program_address(seeds, program_id)
        self.check(
            address.to_base58() == expected["address"],
            "address %s != %s" % (address, expected["address"]),
        )

    def run_instruction(self, vector: dict) -> None:
        spec = vector["input"]
        expected = vector["expected"]
        module = self.modules[spec["program"]]
        idl = self.idls[spec["program"]]
        ix_node = next(
            ix for ix in idl["instructions"] if ix["name"] == spec["instruction"]
        )
        defined_types = {t["name"]: t for t in idl["definedTypes"]}

        if spec.get("direction") == "decode":
            data_class = getattr(
                module, pascal_case(spec["instruction"]) + "InstructionData"
            )
            data = bytes.fromhex(spec["dataHex"])
            self.check(expected.get("error", False) is True, "expected error vector")
            self.expect_error(
                lambda: data_class.deserialize(data),
                module.SerializationError,
                "instruction data decode",
            )
            return

        kwargs: typing.Dict[str, typing.Any] = {}
        for name, address in spec["accounts"].items():
            kwargs[snake_case(name)] = module.Pubkey.from_base58(address)
        # Required accounts the vector leaves unpinned (its expected metas
        # carry no address for them) still need a value to call the builder.
        placeholder = module.Pubkey.from_base58(
            "9QupkCyPmS9N3GGtkrsfuVqQwnRCCemUY6mCMKahkQVh"
        )
        for account in ix_node["accounts"]:
            # Mirrors the builder: only constant public-key defaults (and
            # optional accounts) make the parameter optional.
            default = account.get("defaultValue") or {}
            required = (
                not account.get("isOptional", False)
                and default.get("kind") != "publicKeyValueNode"
            )
            if required and snake_case(account["name"]) not in kwargs:
                kwargs[snake_case(account["name"])] = placeholder
        arg_nodes = {arg["name"]: arg for arg in ix_node["arguments"]}
        for name, value in spec["args"].items():
            converter = make_idl_converter(
                arg_nodes[name]["type"], module, defined_types
            )
            kwargs[snake_case(name)] = converter(value)

        instruction = getattr(module, snake_case(spec["instruction"]))(**kwargs)
        self.check(
            instruction.program_id.to_base58() == expected["programId"],
            "programId %s != %s" % (instruction.program_id, expected["programId"]),
        )
        self.check(
            instruction.data.hex() == expected["dataHex"],
            "data %s != %s" % (instruction.data.hex(), expected["dataHex"]),
        )
        if "accounts" not in expected:
            return
        self.check(
            len(instruction.accounts) == len(expected["accounts"]),
            "account count %d != %d"
            % (len(instruction.accounts), len(expected["accounts"])),
        )
        for meta, exp in zip(instruction.accounts, expected["accounts"]):
            name = exp["name"]
            self.check(
                meta.is_signer is exp["isSigner"],
                "%s is_signer %r != %r" % (name, meta.is_signer, exp["isSigner"]),
            )
            self.check(
                meta.is_writable is exp["isWritable"],
                "%s is_writable %r != %r" % (name, meta.is_writable, exp["isWritable"]),
            )
            if "address" in exp:
                self.check(
                    meta.pubkey.to_base58() == exp["address"],
                    "%s address %s != %s" % (name, meta.pubkey, exp["address"]),
                )

    def run_account(self, vector: dict) -> None:
        spec = vector["input"]
        expected = vector["expected"]
        module = self.modules[spec["program"]]
        idl = self.idls[spec["program"]]
        account_node = next(
            acc for acc in idl["accounts"] if acc["name"] == spec["account"]
        )
        defined_types = {t["name"]: t for t in idl["definedTypes"]}
        account_class = getattr(module, pascal_case(spec["account"]))

        if spec.get("direction") == "decode":
            data = bytes.fromhex(spec["hex"])
            self.check(expected.get("error", False) is True, "expected error vector")
            self.expect_error(
                lambda: account_class.deserialize(data),
                module.SerializationError,
                "account decode",
            )
            return

        kwargs: typing.Dict[str, typing.Any] = {}
        field_nodes = {f["name"]: f for f in account_node["data"]["fields"]}
        for name, value in spec["fields"].items():
            converter = make_idl_converter(
                field_nodes[name]["type"], module, defined_types
            )
            kwargs[snake_case(name)] = converter(value)
        account = account_class(**kwargs)
        data = account.serialize()
        self.check(
            data.hex() == expected["hex"],
            "serialized %s != %s" % (data.hex(), expected["hex"]),
        )
        if "size" in expected:
            self.check(
                len(data) == expected["size"],
                "size %d != %d" % (len(data), expected["size"]),
            )
        decoded = account_class.deserialize(bytes.fromhex(expected["hex"]))
        self.check(decoded == account, "deserialize round-trip mismatch")

    # -- driver -------------------------------------------------------------

    def run_vector(self, vector: dict) -> None:
        mode = vector["mode"]
        passed, failed, skipped = self.counts.setdefault(mode, [0, 0, 0])
        handler = getattr(self, "run_" + mode, None)
        try:
            if handler is None:
                raise SkipVector("unsupported mode: %s" % mode)
            handler(vector)
        except SkipVector as skip:
            if not vector.get("optional", False):
                self.counts[mode][1] += 1
                self.failures.append(
                    "%s: required vector skipped (%s)" % (vector["id"], skip)
                )
                return
            self.counts[mode][2] += 1
            print("  SKIP %s (%s)" % (vector["id"], skip))
        except (AssertionError, Exception) as exc:  # noqa: BLE001
            self.counts[mode][1] += 1
            self.failures.append("%s: %s" % (vector["id"], exc))
        else:
            self.counts[mode][0] += 1

    def run(self) -> int:
        if not os.path.isdir(VECTORS_DIR):
            print(
                "WARNING: conformance corpus not found at %s -- skipping." % VECTORS_DIR
            )
            return 0
        total = 0
        for filename in sorted(os.listdir(VECTORS_DIR)):
            if not filename.endswith(".json"):
                continue
            with open(os.path.join(VECTORS_DIR, filename)) as f:
                vectors = json.load(f)
            print("%s: %d vectors" % (filename, len(vectors)))
            for vector in vectors:
                self.run_vector(vector)
                total += 1

        print()
        print("conformance results (%d vectors):" % total)
        all_passed = all_failed = all_skipped = 0
        for mode in sorted(self.counts):
            passed, failed, skipped = self.counts[mode]
            all_passed += passed
            all_failed += failed
            all_skipped += skipped
            print(
                "  %-12s passed=%-3d failed=%-3d skipped=%d"
                % (mode, passed, failed, skipped)
            )
        print(
            "  %-12s passed=%-3d failed=%-3d skipped=%d"
            % ("TOTAL", all_passed, all_failed, all_skipped)
        )
        if self.failures:
            print()
            for failure in self.failures:
                print("FAIL %s" % failure)
            return 1
        return 0


if __name__ == "__main__":
    sys.exit(Runner().run())
