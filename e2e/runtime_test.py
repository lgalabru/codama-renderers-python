#!/usr/bin/env python3
"""Supplemental tests for the generated `shared/` runtime.

Covers the runtime surface the conformance corpus cannot reach through its
type-descriptor language: fixed/remainder collections, fixed strings, writer
validation errors and the Pubkey value-object protocol. Asserted against the
system fixture client (every fixture ships the identical runtime).

Run from the package root: `python3 e2e/runtime_test.py`.
"""

import importlib.util
import os
import random
import struct
import sys
from enum import IntEnum
from functools import partial

E2E_DIR = os.path.dirname(os.path.abspath(__file__))
GENERATED = os.path.join(E2E_DIR, "system", "generated")

spec = importlib.util.spec_from_file_location(
    "system_generated",
    os.path.join(GENERATED, "__init__.py"),
    submodule_search_locations=[GENERATED],
)
system = importlib.util.module_from_spec(spec)
sys.modules["system_generated"] = system
spec.loader.exec_module(system)

borsh = system.borsh
Reader = system.Reader
SerializationError = system.SerializationError
Pubkey = system.Pubkey


def expect_error(fn, error=SerializationError):
    try:
        fn()
    except error:
        return
    raise AssertionError("expected %s from %r" % (error.__name__, fn))


class IntegerSubclass(int):
    pass


class IntegerEnum(IntEnum):
    ONE = 1


class IntOnly:
    def __int__(self):
        raise AssertionError("integer writers must not invoke __int__")


class IndexOnly:
    def __index__(self):
        raise AssertionError("integer writers must require an actual int")


INVALID_INTEGERS = (
    True,
    False,
    1.0,
    1.5,
    -1.5,
    float("nan"),
    float("inf"),
    float("-inf"),
    "1",
    b"1",
    bytearray(b"1"),
    None,
    IntOnly(),
    IndexOnly(),
)


def test_integer_writers():
    """Every fixed-width writer uses strict types and identical range errors."""
    rng = random.Random(20260717)
    formats = {8: "b", 16: "h", 32: "i", 64: "q"}
    for signed in (False, True):
        for bits in (8, 16, 32, 64, 128):
            name = f"{'i' if signed else 'u'}{bits}"
            writer = getattr(borsh, f"write_{name}")
            minimum = -(1 << (bits - 1)) if signed else 0
            maximum = (1 << (bits - int(signed))) - 1
            for invalid in (
                *INVALID_INTEGERS,
                minimum - 1,
                maximum + 1,
                -(1 << 16384),
                1 << 16384,
            ):
                expect_error(partial(writer, invalid))
            values = [minimum, minimum + 1, 0, 1, maximum - 1, maximum]
            values += [rng.randint(minimum, maximum) for _ in range(256)]
            for value in values:
                encoded = writer(value)
                # Independent byte extraction also covers 128-bit integers,
                # which Python's struct module does not support.
                expected = bytes((value >> shift) & 255 for shift in range(0, bits, 8))
                assert encoded == expected, (name, value)
                assert getattr(Reader(encoded), f"read_{name}")() == value
                if bits in formats:
                    fmt = formats[bits] if signed else formats[bits].upper()
                    assert encoded == struct.pack("<" + fmt, value)
            for value in (IntegerSubclass(1), IntegerEnum.ONE):
                assert writer(value) == writer(1)


def test_shortu16_writer():
    for invalid in (*INVALID_INTEGERS, -1, 65536, -(1 << 16384), 1 << 16384):
        expect_error(partial(borsh.write_shortu16, invalid))
    boundaries = {
        0: b"\x00",
        1: b"\x01",
        127: b"\x7f",
        128: b"\x80\x01",
        16383: b"\xff\x7f",
        16384: b"\x80\x80\x01",
        65535: b"\xff\xff\x03",
    }
    for value, expected in boundaries.items():
        assert borsh.write_shortu16(value) == expected
    # Exhaust the small domain, checking canonical length and independent bytes.
    for value in range(65536):
        groups = max(1, (value.bit_length() + 6) // 7)
        expected = bytes(
            ((value >> (7 * i)) & 127) | (128 if i + 1 < groups else 0)
            for i in range(groups)
        )
        assert borsh.write_shortu16(value) == expected
        assert Reader(expected).read_shortu16() == value
    for value in (IntegerSubclass(1), IntegerEnum.ONE):
        assert borsh.write_shortu16(value) == b"\x01"


def test_instruction_integer_validation():
    """Public generated data classes and builders must not coerce amounts."""
    source = Pubkey.default()
    destination = Pubkey(b"\x01" * 32)
    for invalid in (*INVALID_INTEGERS, -1, 1 << 64):
        expect_error(system.TransferSolInstructionData(amount=invalid).serialize)
        expect_error(partial(system.transfer_sol, source, destination, invalid))
    for amount in (0, 1, (1 << 64) - 1, IntegerSubclass(1), IntegerEnum.ONE):
        expected = struct.pack("<IQ", 2, amount)
        data = system.TransferSolInstructionData(amount=amount)
        assert data.serialize() == expected
        assert system.TransferSolInstructionData.deserialize(expected).amount == amount
        assert system.transfer_sol(source, destination, amount).data == expected


test_integer_writers()
test_shortu16_writer()
test_instruction_integer_validation()


# ---------------------------------------------------------------------------
# Reader basics.
# ---------------------------------------------------------------------------
r = Reader(b"\x01\x02\x03", offset=1)
assert r.remaining == 2
assert r.read_remainder() == b"\x02\x03"
expect_error(lambda: Reader(b"").read(-1))

# Remainder strings (memo-style payloads).
assert Reader("héllo".encode()).read_remainder().decode("utf-8") == "héllo"

# ---------------------------------------------------------------------------
# Fixed strings.
# ---------------------------------------------------------------------------
assert borsh.write_fixed_string("ab", 4) == b"ab\x00\x00"
assert Reader(b"ab\x00\x00").read_fixed_string(4) == "ab"
assert borsh.write_fixed_string("abcd", 4) == b"abcd"
expect_error(lambda: borsh.write_fixed_string("abcde", 4))
expect_error(lambda: borsh.write_fixed_bytes(b"abc", 4))

# ---------------------------------------------------------------------------
# shortU16 writer validation (the boundary values live in the corpus).
# ---------------------------------------------------------------------------
expect_error(lambda: borsh.write_shortu16(-1))
expect_error(lambda: borsh.write_shortu16(0x10000))
# A terminated three-byte encoding above 0xffff must fail on decode too.
expect_error(lambda: Reader(bytes.fromhex("ffff7f")).read_shortu16())

# shortU16 as a collection length prefix.
assert borsh.write_vec([7, 8], borsh.write_u8, "shortu16") == b"\x02\x07\x08"
assert borsh.read_vec(Reader(b"\x02\x07\x08"), lambda r: r.read_u8(), "shortu16") == [
    7,
    8,
]
assert borsh.write_prefixed_string("hi", "shortu16") == b"\x02hi"
assert Reader(b"\x02hi").read_prefixed_string("shortu16") == "hi"

# ---------------------------------------------------------------------------
# Bool strictness.
# ---------------------------------------------------------------------------
expect_error(lambda: Reader(b"\x02").read_bool())

# ---------------------------------------------------------------------------
# Fixed and remainder arrays.
# ---------------------------------------------------------------------------
assert borsh.write_fixed_array([1, 2], 2, borsh.write_u8) == b"\x01\x02"
expect_error(lambda: borsh.write_fixed_array([1], 2, borsh.write_u8))
assert borsh.write_remainder_array([1, 2], borsh.write_u8) == b"\x01\x02"
assert borsh.read_remainder_array(Reader(b"\x01\x02"), lambda r: r.read_u8()) == [1, 2]

# ---------------------------------------------------------------------------
# Fixed and remainder sets (written in ascending order).
# ---------------------------------------------------------------------------
assert borsh.write_fixed_set({2, 1}, 2, borsh.write_u8) == b"\x01\x02"
expect_error(lambda: borsh.write_fixed_set({1}, 2, borsh.write_u8))
assert borsh.read_fixed_set(Reader(b"\x01\x02"), 2, lambda r: r.read_u8()) == {1, 2}
assert borsh.write_remainder_set({2, 1}, borsh.write_u8) == b"\x01\x02"
assert borsh.read_remainder_set(Reader(b"\x01\x02"), lambda r: r.read_u8()) == {1, 2}

# Items without a natural ordering (e.g. pubkeys) fall back to encoded-byte
# order.
pk_lo = Pubkey(b"\x01" * 32)
pk_hi = Pubkey(b"\x02" * 32)
encoded = borsh.write_remainder_set({pk_hi, pk_lo}, lambda pk: pk.to_bytes())
assert encoded == pk_lo.to_bytes() + pk_hi.to_bytes()

# ---------------------------------------------------------------------------
# Fixed and remainder maps (entries in ascending key order).
# ---------------------------------------------------------------------------
assert borsh.write_fixed_map({2: 20, 1: 10}, 2, borsh.write_u8, borsh.write_u8) == (
    b"\x01\x0a\x02\x14"
)
expect_error(lambda: borsh.write_fixed_map({}, 1, borsh.write_u8, borsh.write_u8))
read_fixed = borsh.read_fixed_map(
    Reader(b"\x01\x0a\x02\x14"), 2, lambda r: r.read_u8(), lambda r: r.read_u8()
)
assert read_fixed == {1: 10, 2: 20}
assert borsh.write_remainder_map({2: 20, 1: 10}, borsh.write_u8, borsh.write_u8) == (
    b"\x01\x0a\x02\x14"
)
read_rem = borsh.read_remainder_map(
    Reader(b"\x01\x0a\x02\x14"), lambda r: r.read_u8(), lambda r: r.read_u8()
)
assert read_rem == {1: 10, 2: 20}

# ---------------------------------------------------------------------------
# Pubkey value-object protocol.
# ---------------------------------------------------------------------------
pk = Pubkey.from_bytes(b"\x00" * 32)
assert pk == Pubkey.default()
assert bytes(pk) == b"\x00" * 32
assert str(pk) == "11111111111111111111111111111111"
assert repr(pk) == "Pubkey(11111111111111111111111111111111)"
assert pk != object()
assert hash(pk) == hash(Pubkey.default())
expect_error(lambda: setattr(pk, "anything", 1), AttributeError)

# ---------------------------------------------------------------------------
# Ed25519 point-decoding edge cases not pinned by the PDA corpus.
# ---------------------------------------------------------------------------
pda_module = sys.modules[system.create_program_address.__module__]
# Wrong length is never on the curve.
assert pda_module._is_on_curve(b"") is False
assert pda_module._is_on_curve(b"\x00" * 31) is False
# x = 0 with the sign bit set is an invalid encoding (RFC 8032 §5.1.3 step 4).
assert pda_module._is_on_curve(b"\x01" + b"\x00" * 30 + b"\x80") is False

print("All runtime tests passed.")
