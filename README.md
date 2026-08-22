<div align="center">

# dev-fee-harvester

**Mass-select developer wallets and claim their creator fees in one go.**

[![Node](https://img.shields.io/badge/Node-%E2%89%A520-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Tests](https://img.shields.io/badge/tests-34%20passing-brightgreen)](#development)
[![Verified on mainnet](https://img.shields.io/badge/instructions-simulated%20on%20mainnet-blue)](#how-it-was-verified)
[![License](https://img.shields.io/badge/license-MIT-black)](LICENSE)

</div>

---

If you launch coins, your fees are scattered across a lot of wallets. Claiming them means opening each one, connecting it, clicking claim, and repeating — which is why most creators leave fees sitting in vaults for months.

This finds every claimable fee across all of your wallets, shows you the total, lets you tick the ones you want, and drains them in **batched transactions** — up to 8 wallets co-signing a single transaction instead of one transaction per wallet.

The wallet list is streamed, so there is no practical limit on how many wallets you point it at: 500,000 wallets scan in constant memory. See [Scale](#scale).

Supports **pump.fun** (bonding-curve creator fees), **PumpSwap** (post-bonding fees, held as wrapped SOL), **team fee-sharing configs**, and **Bags**.

## Quick start

```bash
npm install
```

Create `wallets.json` (see [`wallets.example.json`](wallets.example.json)) — a base58 secret key, a Solana CLI keypair array, or a bare pubkey for watch-only:

```json
[
  { "label": "dev-main", "secret": "base58-secret-key" },
  { "label": "cold-watch", "pubkey": "9gquPn41Jjn3JEWwxfZU7894ACpaLzJD6fupcAqAdGZQ" }
]
```

Then look before you leap:

```bash
node bin/harvest.mjs scan
```

```
WALLET    ADDRESS              PUMP     PUMPSWAP      SHARING        TOTAL  STATUS
dev-main  9gquPn41Jj…      0.000000     0.000000     0.000000     0.000000  ready
    └ sharing config HssQnt18Qz… · crank 2.669515 SOL to 1 shareholder
dev-alt   7WjrJhR3WP…      0.000000     0.000000     0.000000     0.000000  ready
    └ sharing config CuCET6nV7Q… · crank 0.298454 SOL to 1 shareholder
dev-03    23QuARJvRD…      0.003625     0.000294     0.000000     0.003919  ready
dev-04    3z4vj1nAuj…      0.002672     0.000000     0.000000     0.002672  ready

0.006591 SOL claimable across 4 wallet(s)  ·  2.967969 SOL released by distribution
```

<sub>Real output against live mainnet wallets. The first two are not wallets at all — see [fee sharing](#fee-sharing).</sub>

## Claiming

```bash
node bin/harvest.mjs claim
```

Opens a terminal picker — `space` toggle, `a` all, `r` claimable only, `enter` confirm. Everything worth claiming is pre-ticked, so the common case is just `enter`.

**Claiming is a dry run until you pass `--execute`.** Without it, every transaction is simulated against mainnet and you are told exactly what would land.

```bash
node bin/harvest.mjs claim --all --execute --priority-fee 50000
```

## Dashboard

```bash
node bin/harvest.mjs dashboard
```

A local page with a checkbox per wallet, select-all / select-claimable, a live running total, and per-transaction results linked to Solscan.

It binds to `127.0.0.1` only, and every API call needs a token minted at startup and printed in the URL — this process holds signing keys, so an open port must not be enough to drive a claim. The dashboard is also dry-run unless you start it with `--execute`.

## How the batching works

A claim is a small instruction, but every extra wallet adds a 64-byte signature and a 32-byte pubkey to the transaction. So batches are packed **by measurement, not by guesswork**: each candidate batch is compiled and its real serialised length checked against Solana's 1232-byte cap before another wallet is added.

In practice that is ~8 wallets per transaction. Forty wallets settle in five transactions rather than forty, and you pay five base fees instead of forty.

## Scale

The wallet list is streamed, not loaded. Wallets that hold nothing are discarded the moment they are read, so peak memory tracks the number of **funded** wallets rather than the size of the list — there is no wallet count at which this falls over.

Measured on a 500,000-wallet file with a stubbed RPC:

```
workers=8  scanned 500,000 in 75.2s  = 6,645 wallets/s
  after   100,000: 5 MB retained
  after   200,000: 5 MB retained
  after   300,000: 5 MB retained
  after   400,000: 5 MB retained
  after   500,000: 5 MB retained
found 5/5 planted; all correct: true
```

Flat. Three things get it there:

- **Keys are derived lazily.** A Solana 64-byte secret key is `seed(32) || pubkey(32)`, so the public key is a slice, not an ed25519 derivation — measured at **279× cheaper**. Signing keys are built only for the wallets that actually enter a transaction. Loading 20,000 wallets went from 4481ms to 104ms.
- **Deduplication happens late.** Holding a Set of every address seen cost ~1.1KB per wallet, five times the wallet records themselves. Duplicates are removed from the funded set instead, which is exact and free.
- **Address derivation is threaded.** Each wallet needs three program addresses at ~280µs each, almost all of it inside the pure-JS `isOnCurve` check, and that — not the RPC — is the real floor on a large scan. Spreading it over 8 workers measured **5.7× faster**, with 0 address mismatches against the single-threaded reference across 12,000 addresses.

For very large lists use JSONL, which streams line by line (a giant JSON array has to be materialised whole):

```jsonl
{"label":"dev-1","secret":"base58-secret-key"}
{"label":"dev-2","pubkey":"9gquPn41Jjn3JEWwxfZU7894ACpaLzJD6fupcAqAdGZQ"}
```

```bash
node bin/harvest.mjs scan --wallets wallets.jsonl --out found.jsonl --concurrency 32
```

`--out` appends each funded wallet the moment it is found, so a long run is useful even if you stop it early. On a private RPC raise `--concurrency`; on a strict one set `--rpc-delay`. RPC failures are retried with backoff and, if they still fail, reported — never silently treated as "no fees here".

## Fee sharing

A large share of real creators split fees with a team through a **sharing config**. pump.fun implements this in a way that quietly defeats a naive claimer: it sets `bonding_curve.creator` to the *sharing config PDA* rather than to a wallet. Fees then pile up in a vault belonging to that PDA, and `collect_creator_fee` refuses to touch it with error `6050`.

Two things follow, and both cost money if you ignore them.

**Those fees are invisible to a per-wallet scan.** The vault is not derived from any wallet you hold, so scanning your wallets reports zero while real SOL sits in a vault that names you as a shareholder. Run with `--find-shares` and the scan also hunts for configs where one of your wallets is a shareholder:

```
shareholder 5bQMLqKtmi…      0.000000     0.000000     3.573280     3.573280  ready
    └ share in Hzm2XygHVB… · crank 0.746627 SOL to 3 shareholders  → you receive 0.253853 SOL
    └ share in HssQnt18Qz… · crank 2.669687 SOL to 1 shareholder   → you receive 2.669687 SOL
    …
```

That wallet reads as **0.000000 SOL** without the flag and **3.573280 SOL** with it.

**Releasing them is a different instruction.** `distribute_creator_fees` splits the vault across the config's shareholders by basis points. It takes **no signer** — anyone may crank it, and the funds can only ever go to the shareholders the config already names, so cranking someone else's config does not let you take anything. This tool emits it automatically for any config it finds.

Because "what moves" and "what you receive" differ, the output shows both: the crank amount and your share of it.

A migrated config also used to be able to poison a batch — one `6050` revert fails the whole transaction and nobody gets paid. Every unit of work is therefore simulated on its own first, and anything the chain rejects is dropped from the batch with the program's own explanation rather than taking its batch-mates down.

Sharing configs live under a **separate program**, `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ` (`pump_fees`), which is why they are invisible if you look for them under pump.fun. That address is not hardcoded on trust — it is read from the `program` override on pump.fun's own IDL and re-checked by `npm run verify:onchain`.

> `--find-shares` issues one filtered `getProgramAccounts` per shareholder slot (27 of them). The public RPC rate-limits that hard. If a slot fails, the scan says so loudly and refuses to report a total, because a silent zero here is the one wrong answer that costs you money — use a private RPC for this flag.

## Notes on correctness

- **Nothing here is guessed.** Program IDs, instruction discriminators, account ordering, and PDA seeds are all read from the programs' own on-chain Anchor IDLs. Re-check them at any time with `npm run verify:onchain`, which also regenerates the error table.
- The two programs spell the vault seed differently — pump.fun uses `creator-vault` (hyphen), PumpSwap uses `creator_vault` (underscore). Getting this wrong derives a valid-looking address that simply has no money in it.
- The bonding-curve vault is a plain system account, so it must keep the rent-exempt minimum. Claimable amounts subtract that 890,880 lamports rather than promising you a balance that cannot move.
- Fees accrue in the **vault**, not the wallet, so a creator sitting on 3 SOL of fees can have an empty wallet and be unable to pay a transaction fee. The fee payer defaults to your richest signing wallet, and you are warned if it is too thin.

## Your keys

Keys are read from your local wallets file and used only to sign locally. They are never logged, never serialised into output, and never sent anywhere — the Bags adapter posts only public keys and receives unsigned transactions, which are then signed on your machine.

`wallets.json` is in `.gitignore`. Keep it that way.

## How it was verified

Both instructions were simulated against real, funded mainnet vaults before any of it was wired up.

`collect_creator_fee`:

```
BEFORE  vault=65379194
Program log: Instruction: CollectCreatorFee
ERR: null
AFTER   vault=890880
SWEPT   64488314 lamports out of the vault
```

`distribute_creator_fees`, against a config whose single shareholder holds 10000 bps:

```
Program log: Instruction: DistributeCreatorFees
ERR: null
vault 2669529318 -> 890880  (moved 2668638438)
holder 5bQMLqKtmi…: 2136720 -> 2670775158  (+2668638438)
```

And the batching end to end — 14 actions across two wallets, packed and simulated:

```
14 actions packed into 3 transaction(s)
batch 1: 6 actions, 1214/1232 bytes, err: null
batch 2: 6 actions, 1214/1232 bytes, err: null
batch 3: 2 actions,  744/1232 bytes, err: null
TOTAL MOVED: 4505246557 lamports = 4.505247 SOL
```

Multi-wallet co-signing is checked cryptographically in the test suite (Ed25519 verification of every signature slot), and batch packing is checked against the real 1232-byte serialised limit.

## Development

```bash
npm test                 # 34 tests, no network required
npm run verify:onchain   # re-derive every constant from the on-chain IDLs
```

## Options

| Flag | |
|---|---|
| `--wallets <path>` | wallets JSON file, or a directory of keypair files |
| `--rpc <url>` | RPC endpoint. A private one is strongly recommended; the public endpoint rate-limits hard |
| `--payer <key>` | who pays fees, by label or pubkey |
| `--min <sol>` | ignore wallets below this amount |
| `--all` | take every claimable wallet, no picker |
| `--execute` | actually send. Without it, everything is simulated |
| `--priority-fee <n>` | compute unit price in micro-lamports |
| `--max-per-tx <n>` | wallets per transaction (default 8) |
| `--batch-size <n>` | wallets scanned per pass (default 1000) |
| `--concurrency <n>` | parallel RPC requests (default 8; raise on a private RPC) |
| `--workers <n>` | threads for address derivation (default cores-1, max 8; `0` disables) |
| `--rpc-delay <ms>` | minimum gap between RPC requests, for strict rate limits |
| `--out <file.jsonl>` | append every funded wallet as it is found |
| `--find-shares` | also hunt fees held for you in team sharing configs (needs a private RPC) |
| `--bags` | include Bags positions (needs `BAGS_API_KEY`) |
| `--json` | machine-readable scan output |

## License

MIT
