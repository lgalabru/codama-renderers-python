#!/usr/bin/env python3
"""Smoke test exercising the generated Python clients (system + pump-fun).

Run from the package root: `python3 e2e/smoke_test.py`.
"""

import dataclasses
import importlib.util
import os
import sys
from types import ModuleType

E2E_DIR = os.path.dirname(os.path.abspath(__file__))


def load_package(name: str, path: str) -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        name, os.path.join(path, "__init__.py"), submodule_search_locations=[path]
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


system = load_package("system_generated", os.path.join(E2E_DIR, "system", "generated"))
pump = load_package("pump_generated", os.path.join(E2E_DIR, "pump-fun", "generated"))
memo = load_package("memo_generated", os.path.join(E2E_DIR, "memo", "generated"))
dummy = load_package("dummy_generated", os.path.join(E2E_DIR, "dummy", "generated"))

Pubkey = system.Pubkey

# ---------------------------------------------------------------------------
# 1. Base58 round-trips.
# ---------------------------------------------------------------------------
system_id = "11111111111111111111111111111111"
assert Pubkey.from_base58(system_id).to_bytes() == b"\x00" * 32
assert Pubkey.from_base58(system_id).to_base58() == system_id
for addr in (
    "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
    "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
    "9QupkCyPmS9N3GGtkrsfuVqQwnRCCemUY6mCMKahkQVh",
):
    assert Pubkey.from_base58(addr).to_base58() == addr, addr
assert system.SYSTEM_PROGRAM_ID == Pubkey.from_base58(system_id)
print("base58 round-trips: OK")

# ---------------------------------------------------------------------------
# 2. transfer_sol instruction: data bytes and account metas.
# ---------------------------------------------------------------------------
source = Pubkey.from_base58("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P")
destination = Pubkey.from_base58("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr")
amount = 1_000_000

ix = system.transfer_sol(source=source, destination=destination, amount=amount)
# The system IDL gives transfer_sol a u32 field discriminator of value 2.
assert system.TRANSFER_SOL_DISCRIMINATOR == bytes([2, 0, 0, 0])
assert ix.data == bytes([2, 0, 0, 0]) + amount.to_bytes(8, "little"), ix.data.hex()
assert ix.program_id == system.SYSTEM_PROGRAM_ID
assert len(ix.accounts) == 2
assert ix.accounts[0].pubkey == source
assert ix.accounts[0].is_signer is True
assert ix.accounts[0].is_writable is True
assert ix.accounts[1].pubkey == destination
assert ix.accounts[1].is_signer is False
assert ix.accounts[1].is_writable is True

# The instruction data class round-trips.
parsed = system.TransferSolInstructionData.deserialize(ix.data)
assert parsed.amount == amount
assert parsed.serialize() == ix.data
print("transfer_sol instruction: OK")

# ---------------------------------------------------------------------------
# 3. Account round-trip: system Nonce (u32-sized scalar enums + pubkeys + u64).
# ---------------------------------------------------------------------------
nonce = system.Nonce(
    version=system.NonceVersion.CURRENT,
    state=system.NonceState.INITIALIZED,
    authority=source,
    blockhash=destination,
    lamports_per_signature=5_000,
)
data = nonce.serialize()
assert len(data) == system.NONCE_SIZE == 80, len(data)
assert data[:4] == bytes([1, 0, 0, 0])  # NonceVersion.CURRENT as u32 LE
assert data[4:8] == bytes([1, 0, 0, 0])  # NonceState.INITIALIZED as u32 LE
decoded = system.Nonce.deserialize(data)
assert decoded == nonce
print("Nonce account round-trip: OK")

# ---------------------------------------------------------------------------
# 4. pump-fun: account with bytes discriminator + defined-type round-trips.
# ---------------------------------------------------------------------------
# Note: each generated package ships its own runtime, so pump objects must use
# pump's Pubkey class.
PumpPubkey = pump.Pubkey
creator = PumpPubkey.from_base58("9QupkCyPmS9N3GGtkrsfuVqQwnRCCemUY6mCMKahkQVh")
pump_source = PumpPubkey.from_base58("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P")
pump_destination = PumpPubkey.from_base58("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr")
curve = pump.BondingCurve(
    virtual_token_reserves=1,
    virtual_sol_reserves=2,
    real_token_reserves=3,
    real_sol_reserves=4,
    token_total_supply=5,
    complete=False,
    creator=creator,
    is_mayhem_mode=True,
)
curve_data = curve.serialize()
assert len(curve_data) == pump.BONDING_CURVE_SIZE == 82, len(curve_data)
assert (
    curve_data[:8]
    == pump.BONDING_CURVE_DISCRIMINATOR
    == bytes([23, 183, 248, 55, 96, 216, 172, 96])
)
assert pump.BondingCurve.deserialize(curve_data) == curve

# Defined type with a u128 field and a nested defined-type link.
fee_tier = pump.FeeTier(
    market_cap_lamports_threshold=2**100 + 7,
    fees=pump.Fees(lp_fee_bps=10, protocol_fee_bps=20, creator_fee_bps=30),
)
assert pump.FeeTier.deserialize(fee_tier.serialize()) == fee_tier

# Tuple-aliased defined type (OptionBool) used as an instruction argument.
buy_ix = pump.buy(
    global_=creator,
    fee_recipient=pump_source,
    mint=pump_destination,
    bonding_curve=creator,
    associated_bonding_curve=pump_source,
    associated_user=pump_destination,
    user=creator,
    creator_vault=pump_destination,
    event_authority=creator,
    global_volume_accumulator=pump_source,
    user_volume_accumulator=pump_destination,
    fee_config=creator,
    amount=42,
    max_sol_cost=43,
    track_volume=(True,),
)
expected_data = (
    pump.BUY_DISCRIMINATOR
    + (42).to_bytes(8, "little")
    + (43).to_bytes(8, "little")
    + b"\x01"
)
assert buy_ix.data == expected_data, buy_ix.data.hex()
assert len(buy_ix.accounts) == 16
# Accounts with constant public key defaults resolve when omitted.
assert buy_ix.accounts[7].pubkey == PumpPubkey.from_base58(
    "11111111111111111111111111111111"
)  # system program
assert buy_ix.accounts[8].pubkey == PumpPubkey.from_base58(
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
)  # token program
assert buy_ix.accounts[6].is_signer is True  # user
assert buy_ix.program_id == pump.PUMP_PROGRAM_ID
print("pump-fun round-trips: OK")

# ---------------------------------------------------------------------------
# 5. Borsh option / vec / string helpers via the shared runtime.
# ---------------------------------------------------------------------------
borsh = system.borsh
assert borsh.write_option(None, borsh.write_u64) == b"\x00"
assert borsh.write_option(7, borsh.write_u64) == b"\x01" + (7).to_bytes(8, "little")
r = borsh.Reader(b"\x01\x2a\x00\x00\x00\x00\x00\x00\x00")
assert borsh.read_option(r, lambda r: r.read_u64()) == 42
assert borsh.write_prefixed_string("hi") == b"\x02\x00\x00\x00hi"
assert borsh.Reader(b"\x02\x00\x00\x00hi").read_prefixed_string() == "hi"
assert borsh.write_i128(-1) == b"\xff" * 16
assert borsh.Reader(b"\xff" * 16).read_i128() == -1
assert borsh.write_u128(2**127) == bytes(15) + b"\x80"
assert borsh.Reader(bytes(15) + b"\x80").read_u128() == 2**127

# Maps and sets are encoded deterministically: entries are written in
# ascending key order, regardless of insertion order.
assert borsh.write_map({3: 30, 1: 10}, borsh.write_u8, borsh.write_u8) == bytes(
    [2, 0, 0, 0, 1, 10, 3, 30]
)
assert borsh.write_map(
    {1: 10, 3: 30}, borsh.write_u8, borsh.write_u8
) == borsh.write_map({3: 30, 1: 10}, borsh.write_u8, borsh.write_u8)
assert (
    borsh.write_set({"b", "a"}, borsh.write_prefixed_string)
    == bytes([2, 0, 0, 0]) + b"\x01\x00\x00\x00a" + b"\x01\x00\x00\x00b"
)
print("borsh helpers: OK")

# ---------------------------------------------------------------------------
# 6. PDA derivation against vectors generated with @solana/web3.js.
# ---------------------------------------------------------------------------
find_program_address = system.find_program_address
create_program_address = system.create_program_address
pump_id = Pubkey.from_base58("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P")
memo_id = Pubkey.from_base58("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr")

# Vector 1: bump 255 (first candidate is already off-curve).
addr, bump = find_program_address([b"global"], pump_id)
assert addr.to_base58() == "4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf", addr
assert bump == 255, bump

# Vector 2: bump 250 (bumps 255..251 all land on the curve and must be rejected).
addr, bump = find_program_address([b"vault", bytes([35])], pump_id)
assert addr.to_base58() == "76jNgxjtv5f2MkuXWMkNKdqsnL8yMm3jnmBez2Bn3Mbz", addr
assert bump == 250, bump
# create_program_address must therefore fail for bump 255 with a typed
# error (PdaError subclasses both CodamaError and ValueError).
try:
    create_program_address([b"vault", bytes([35]), bytes([255])], pump_id)
    raise AssertionError("expected an on-curve failure for bump 255")
except system.PdaError as exc:
    assert isinstance(exc, system.CodamaError)
    assert isinstance(exc, ValueError)
# ... and reproduce the address for bump 250.
assert (
    create_program_address([b"vault", bytes([35]), bytes([250])], pump_id).to_base58()
    == "76jNgxjtv5f2MkuXWMkNKdqsnL8yMm3jnmBez2Bn3Mbz"
)

# Vector 3: bump 249, multiple seeds incl. a pubkey, derived under the system program.
addr, bump = find_program_address(
    [b"user-stats", memo_id.to_bytes(), bytes([6])], system.SYSTEM_PROGRAM_ID
)
assert addr.to_base58() == "8SWwACT3P72rLtLx9rRirNG5ezxQ17pPwTiNYoZN1MUP", addr
assert bump == 249, bump
print("PDA derivation vectors: OK")

# ---------------------------------------------------------------------------
# 7. memo: remainder string + remaining accounts; dummy: optional accounts
#    and optional arguments with defaults.
# ---------------------------------------------------------------------------
signer = memo.Pubkey.from_base58("9QupkCyPmS9N3GGtkrsfuVqQwnRCCemUY6mCMKahkQVh")
memo_ix = memo.add_memo(
    memo="hello memo",
    remaining_accounts=[memo.AccountMeta(pubkey=signer, is_signer=True)],
)
assert memo_ix.data == b"hello memo"
assert len(memo_ix.accounts) == 1 and memo_ix.accounts[0].is_signer is True
assert memo_ix.program_id == memo.MEMO_PROGRAM_ID

# instruction3: omitted u32 discriminator (42) only.
assert dummy.instruction3().data == (42).to_bytes(4, "little")
# instruction5: optional argument defaults to 42.
assert dummy.instruction5().data == (42).to_bytes(8, "little")
assert dummy.instruction5(my_argument=7).data == (7).to_bytes(8, "little")
# instruction7: optional account defaults to the program id (programId strategy).
ix7 = dummy.instruction7()
assert ix7.accounts[0].pubkey == dummy.DUMMY_PROGRAM_ID
assert ix7.accounts[0].is_signer is False
my_account = dummy.Pubkey.from_base58("9QupkCyPmS9N3GGtkrsfuVqQwnRCCemUY6mCMKahkQVh")
assert dummy.instruction7(my_account=my_account).accounts[0].pubkey == my_account
print("memo + dummy instructions: OK")

# ---------------------------------------------------------------------------
# 8. Error hierarchy: code constants, message lookup and typed program errors.
# ---------------------------------------------------------------------------
assert system.SYSTEM_ERROR__ACCOUNT_ALREADY_IN_USE == 0
assert (
    system.get_system_error_message(0)
    == "an account with the same address already exists"
)
assert system.get_system_error_message(999_999) is None

err = system.get_system_error(0)
assert isinstance(err, system.SystemProgramError)
assert isinstance(err, system.ProgramError)
assert isinstance(err, system.CodamaError)
assert err.code == 0
assert err.message == "an account with the same address already exists"
assert str(err) == "[0] an account with the same address already exists"
assert system.get_system_error(999_999) is None

# Malformed data raises a typed SerializationError (a CodamaError + ValueError).
try:
    system.Nonce.deserialize(b"\x00")
    raise AssertionError("expected a buffer underflow failure")
except system.SerializationError as exc:
    assert isinstance(exc, system.CodamaError)
    assert isinstance(exc, ValueError)
try:
    system.Pubkey(b"\x01\x02")
    raise AssertionError("expected a pubkey length failure")
except system.PubkeyError as exc:
    assert isinstance(exc, system.SerializationError)
print("error hierarchy: OK")

# ---------------------------------------------------------------------------
# 9. Generated value objects are frozen (immutable) dataclasses.
# ---------------------------------------------------------------------------
try:
    nonce.lamports_per_signature = 0
    raise AssertionError("expected a frozen dataclass failure")
except dataclasses.FrozenInstanceError:
    pass
try:
    ix.accounts[0].is_signer = False
    raise AssertionError("expected a frozen dataclass failure")
except dataclasses.FrozenInstanceError:
    pass
try:
    source._bytes = b"\x00" * 32
    raise AssertionError("expected an immutable pubkey failure")
except AttributeError:
    pass
print("frozen value objects: OK")

print("All smoke tests passed.")
