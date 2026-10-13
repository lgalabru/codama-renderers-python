#!/usr/bin/env python3
"""Verify generated enum tags against wire bytes, not only round trips."""

from dummy.generated.shared.errors import SerializationError
from dummy.generated.types.sparse_scalar import SparseScalar
from dummy.generated.types.sparse_tagged import (
    SparseTagged,
    SparseTaggedEmpty,
    SparseTaggedImplicit,
    SparseTaggedRecord,
    SparseTaggedTuple,
)


def main():
    scalar_cases = [
        (SparseScalar.HIGH, b"\x13"),
        (SparseScalar.LOW, b"\x04"),
        (SparseScalar.IMPLICIT, b"\x02"),
        (SparseScalar.ZERO, b"\x00"),
    ]
    tagged_cases = [
        (SparseTaggedRecord(value=0x1234), b"\x13\x34\x12"),
        (SparseTaggedTuple(fields=(42,)), b"\x04\x2a"),
        (SparseTaggedEmpty(), b"\x09"),
        (SparseTaggedImplicit(), b"\x03"),
    ]
    for enum, cases in [(SparseScalar, scalar_cases), (SparseTagged, tagged_cases)]:
        for value, wire in cases:
            assert value.serialize() == wire
            assert enum.deserialize(wire) == value
        for wire in [b"\x01", b"\xff"]:
            try:
                enum.deserialize(wire)
            except SerializationError:
                pass
            else:
                raise AssertionError(f"{enum.__name__} accepted unknown tag {wire!r}")
    print("Sparse scalar and tagged enum wire fixtures passed")


if __name__ == "__main__":
    main()
