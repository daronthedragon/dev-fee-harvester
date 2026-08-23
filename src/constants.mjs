import { PublicKey } from '@solana/web3.js';

// Every value below was read from the programs' own on-chain Anchor IDL
// (anchor:idl PDA) rather than copied from a blog post. Regenerate and
// re-check at any time with:  npm run verify:onchain
//
// Both program accounts confirmed executable, owner BPFLoaderUpgradeab1e...

/** pump.fun bonding curve program. */
export const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

/** PumpSwap ("pump AMM") program, where a coin lands after it bonds. */
export const PUMPSWAP_PROGRAM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');

/**
 * pump_fees — owns the SharingConfig accounts used for team fee splits.
 * Not guessed: this address is the `program` override on the sharing_config
 * PDA in pump.fun's own IDL, which is why sharing configs are invisible if
 * you look for them under the pump.fun program.
 */
export const PUMP_FEES_PROGRAM = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');

export const SYSTEM_PROGRAM = new PublicKey('11111111111111111111111111111111');
export const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const ASSOCIATED_TOKEN_PROGRAM = new PublicKey(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
);
export const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

// Anchor discriminators = sha256("global:<snake_case_name>")[0..8].
// Listed as literals so a wrong RPC can never silently change what we sign.
export const DISCRIMINATORS = {
  collect_creator_fee: Uint8Array.from([20, 22, 86, 123, 198, 28, 219, 132]),
  collect_coin_creator_fee: Uint8Array.from([160, 57, 89, 42, 181, 139, 43, 66]),
  distribute_creator_fees: Uint8Array.from([165, 114, 103, 0, 121, 206, 247, 81]),
};

/** Anchor account discriminator = sha256("account:SharingConfig")[0..8]. */
export const SHARING_CONFIG_DISCRIMINATOR = Uint8Array.from([216, 74, 9, 0, 56, 140, 93, 75]);

/** Sharing configs are allocated at a fixed size, which bounds shareholders. */
export const SHARING_CONFIG_SIZE = 1024;

// The two programs spell the seed differently. This is not a typo, and it is
// the single easiest thing to get wrong in this whole tool:
//   pump.fun bonding curve -> "creator-vault"  (HYPHEN)
//   PumpSwap AMM           -> "creator_vault"  (UNDERSCORE)
export const SEED_PUMP_CREATOR_VAULT = Buffer.from('creator-vault');
export const SEED_PUMPSWAP_CREATOR_VAULT = Buffer.from('creator_vault');
export const SEED_EVENT_AUTHORITY = Buffer.from('__event_authority');
export const SEED_BONDING_CURVE = Buffer.from('bonding-curve');
export const SEED_SHARING_CONFIG = Buffer.from('sharing-config');

/** Rent-exempt floor for a bare system account; below this a vault is empty. */
export const SYSTEM_ACCOUNT_RENT_LAMPORTS = 890880;

export const LAMPORTS_PER_SOL = 1_000_000_000;
