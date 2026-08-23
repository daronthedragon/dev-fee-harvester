import { PublicKey } from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM,
  PUMPSWAP_PROGRAM,
  PUMP_FEES_PROGRAM,
  PUMP_PROGRAM,
  SEED_BONDING_CURVE,
  SEED_EVENT_AUTHORITY,
  SEED_PUMPSWAP_CREATOR_VAULT,
  SEED_PUMP_CREATOR_VAULT,
  SEED_SHARING_CONFIG,
  TOKEN_PROGRAM,
} from './constants.mjs';

/**
 * Where pump.fun accrues a creator's SOL fees while their coin is still on
 * the bonding curve. Plain system account, so its lamport balance IS the
 * claimable amount (minus rent).
 */
export function pumpCreatorVault(creator) {
  return PublicKey.findProgramAddressSync(
    [SEED_PUMP_CREATOR_VAULT, creator.toBuffer()],
    PUMP_PROGRAM,
  )[0];
}

/** PumpSwap's vault authority PDA — note the underscore seed. */
export function pumpswapCreatorVaultAuthority(coinCreator) {
  return PublicKey.findProgramAddressSync(
    [SEED_PUMPSWAP_CREATOR_VAULT, coinCreator.toBuffer()],
    PUMPSWAP_PROGRAM,
  )[0];
}

/** Standard associated-token-account derivation. */
export function associatedTokenAddress(owner, mint, tokenProgram = TOKEN_PROGRAM) {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM,
  )[0];
}

/** The bonding curve for a mint. Its `creator` field is a wallet — or, once
 *  fees are shared, the sharing config PDA itself. */
export function bondingCurve(mint) {
  return PublicKey.findProgramAddressSync([SEED_BONDING_CURVE, mint.toBuffer()], PUMP_PROGRAM)[0];
}

/** Sharing config for a mint. Lives under pump_fees, not pump.fun. */
export function sharingConfig(mint) {
  return PublicKey.findProgramAddressSync(
    [SEED_SHARING_CONFIG, mint.toBuffer()],
    PUMP_FEES_PROGRAM,
  )[0];
}

/** Anchor's self-CPI event authority, seed "__event_authority". */
export function eventAuthority(programId) {
  return PublicKey.findProgramAddressSync([SEED_EVENT_AUTHORITY], programId)[0];
}
