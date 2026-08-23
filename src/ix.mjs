import { TransactionInstruction } from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM,
  DISCRIMINATORS,
  PUMPSWAP_PROGRAM,
  PUMP_PROGRAM,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  WSOL_MINT,
} from './constants.mjs';
import {
  associatedTokenAddress,
  eventAuthority,
  pumpCreatorVault,
  pumpswapCreatorVaultAuthority,
} from './pda.mjs';

const ro = (pubkey, isSigner = false) => ({ pubkey, isSigner, isWritable: false });
const rw = (pubkey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });

/**
 * pump.fun `collect_creator_fee`. Sweeps the creator's bonding-curve fee
 * vault back to the creator. Account order is verbatim from the IDL:
 *   creator, creator_vault, system_program, event_authority, program
 */
export function collectCreatorFeeIx(creator) {
  return new TransactionInstruction({
    programId: PUMP_PROGRAM,
    keys: [
      rw(creator, true), // signs, and receives the lamports
      rw(pumpCreatorVault(creator)), // drained, so writable
      ro(SYSTEM_PROGRAM),
      ro(eventAuthority(PUMP_PROGRAM)),
      ro(PUMP_PROGRAM),
    ],
    data: Buffer.from(DISCRIMINATORS.collect_creator_fee),
  });
}

/**
 * PumpSwap `collect_coin_creator_fee`. Post-bonding fees accrue as wrapped
 * SOL in a vault ATA, so this moves tokens rather than lamports. IDL order:
 *   quote_mint, quote_token_program, coin_creator, coin_creator_vault_authority,
 *   coin_creator_vault_ata, coin_creator_token_account, event_authority, program
 */
export function collectCoinCreatorFeeIx(
  coinCreator,
  quoteMint = WSOL_MINT,
  quoteTokenProgram = TOKEN_PROGRAM,
) {
  const vaultAuthority = pumpswapCreatorVaultAuthority(coinCreator);
  return new TransactionInstruction({
    programId: PUMPSWAP_PROGRAM,
    keys: [
      ro(quoteMint),
      ro(quoteTokenProgram),
      ro(coinCreator, true), // signs as the fee owner
      ro(vaultAuthority),
      rw(associatedTokenAddress(vaultAuthority, quoteMint, quoteTokenProgram)),
      rw(associatedTokenAddress(coinCreator, quoteMint, quoteTokenProgram)),
      ro(eventAuthority(PUMPSWAP_PROGRAM)),
      ro(PUMPSWAP_PROGRAM),
    ],
    data: Buffer.from(DISCRIMINATORS.collect_coin_creator_fee),
  });
}

/**
 * ATA create, idempotent variant (instruction byte 1) so it is a no-op when
 * the destination already exists. Needed because a wallet that has never
 * touched wrapped SOL has nowhere to receive PumpSwap fees.
 */
export function createAtaIdempotentIx(payer, owner, mint, tokenProgram = TOKEN_PROGRAM) {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM,
    keys: [
      rw(payer, true),
      rw(associatedTokenAddress(owner, mint, tokenProgram)),
      ro(owner),
      ro(mint),
      ro(SYSTEM_PROGRAM),
      ro(tokenProgram),
    ],
    data: Buffer.from([1]),
  });
}
