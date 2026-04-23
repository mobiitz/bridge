# mBTC Bridge

This repository contains two components:

1. A RainbowKit-powered frontend for `bridge.mbtc.us`.
2. An operator relay service that executes `bridgeBurnFrom` on the source chain and `bridgeMint` on the destination chain.

## Bridge model

This repository now matches the MBTC contract you pasted:

- `bridgeMint(address,uint256)` is restricted to `BRIDGE_ROLE`.
- `bridgeBurnFrom(address,uint256)` is restricted to `BRIDGE_ROLE`.
- `bridgeBurnFrom` consumes ERC-20 allowance from the user.
- The relay signer must hold `BRIDGE_ROLE` on both token contracts.

That means the bridge flow is:

1. The user connects a wallet.
2. The user approves the bridge operator on the source-chain MBTC token.
3. The user signs an off-chain bridge request.
4. The relay verifies the signature and calls `bridgeBurnFrom`.
5. After the burn confirms, the relay calls `bridgeMint` on the destination chain.

## Frontend

The frontend uses:

- `RainbowKit` for multi-wallet support
- `wagmi` and `viem` for Ethereum/Base wallet operations
- `Vite` + `React`

It lets the user:

- connect a wallet
- choose Ethereum-to-Base or Base-to-Ethereum
- approve the bridge operator on the source chain
- optionally choose a different destination address
- sign a bridge request for the relay
- monitor relay status and view burn/mint transactions

## Relay

The relay does the operational bridge work:

- verifies the signed bridge request with EIP-712 typed data
- checks the source-chain allowance and balance
- submits `bridgeBurnFrom(from, amount)` on the source chain
- submits `bridgeMint(to, amount)` on the destination chain
- records bridge state and used nonces in `server/bridge-state.json`
- exposes `GET /api/config`, `GET /api/status/:requestId`, and `POST /api/bridge`

For this contract, yes: the relay is still the other core component you need besides the frontend. It is the bridge-role wallet that actually performs the burn and mint transactions.

## Environment

Copy `.env.example` to `.env` and fill in:

- `VITE_WALLETCONNECT_PROJECT_ID`
- both token addresses
- both primary RPC URLs
- both fallback RPC URLs if you want a backup endpoint on each chain
- `VITE_RELAYER_URL`
- `VITE_BRIDGE_OPERATOR_ADDRESS` if you do not want the frontend to rely on `/api/config`
- `BRIDGE_ADMIN_PRIVATE_KEY`
- relay CORS settings

The private key in `BRIDGE_ADMIN_PRIVATE_KEY` must belong to the wallet that already has `BRIDGE_ROLE` on both MBTC tokens. If it does not, the relay refuses to start.

## GitHub Env Blob

If you want one multiline GitHub secret for deployment, create a repository secret named `ENV_BLOB` and paste normal dotenv content into it.

Do not put this blob in repository variables because it contains `BRIDGE_ADMIN_PRIVATE_KEY`.

Example:

```env
VITE_WALLETCONNECT_PROJECT_ID=your_walletconnect_project_id
VITE_ETHEREUM_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/your-key
VITE_ETHEREUM_FALLBACK_RPC_URL=https://ethereum.llamarpc.com
VITE_BASE_RPC_URL=https://base-mainnet.g.alchemy.com/v2/your-key
VITE_BASE_FALLBACK_RPC_URL=https://mainnet.base.org
VITE_ETHEREUM_TOKEN_ADDRESS=0x3898257dd2cd6d2a3b6e3435f73568a725262b9b
VITE_BASE_TOKEN_ADDRESS=0x3898257dd2cd6d2a3b6e3435f73568a725262b9b
VITE_RELAYER_URL=https://bridge-relay.mbtc.us
VITE_BRIDGE_OPERATOR_ADDRESS=0xYourBridgeOperatorAddress
VITE_BRIDGE_REQUEST_TTL_SECONDS=900
BRIDGE_ADMIN_PRIVATE_KEY=0xyour_bridge_operator_private_key
ETHEREUM_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/your-key
ETHEREUM_FALLBACK_RPC_URL=https://ethereum.llamarpc.com
BASE_RPC_URL=https://base-mainnet.g.alchemy.com/v2/your-key
BASE_FALLBACK_RPC_URL=https://mainnet.base.org
ETHEREUM_TOKEN_ADDRESS=0x3898257dd2cd6d2a3b6e3435f73568a725262b9b
BASE_TOKEN_ADDRESS=0x3898257dd2cd6d2a3b6e3435f73568a725262b9b
TX_CONFIRMATIONS=1
REQUEST_TTL_SECONDS=900
POLL_INTERVAL_MS=15000
PORT=8787
CORS_ORIGIN=https://bridge.mbtc.us
STATE_FILE=./server/bridge-state.json
```

Notes:

- The `VITE_` values are frontend-visible at build time, so they are not sensitive.
- `BRIDGE_ADMIN_PRIVATE_KEY` is sensitive and must stay in GitHub Secrets, not repository variables.
- The fallback RPC values are optional. If set, the frontend and relayer will fail over to them when the primary endpoint is unavailable.
- If your deploy pipeline already injects separate env vars, you do not need an `ENV_BLOB`; individual secrets work fine too.

## GitHub Pages

This repo now includes [.github/workflows/deploy-pages.yml](/home/office/bridge/.github/workflows/deploy-pages.yml), which deploys the frontend to GitHub Pages on pushes to `main`.

For the Pages build, set these repository variables or secrets:

- `VITE_WALLETCONNECT_PROJECT_ID`
- `VITE_ETHEREUM_RPC_URL`
- `VITE_ETHEREUM_FALLBACK_RPC_URL`
- `VITE_BASE_RPC_URL`
- `VITE_BASE_FALLBACK_RPC_URL`
- `VITE_ETHEREUM_TOKEN_ADDRESS`
- `VITE_BASE_TOKEN_ADDRESS`
- `VITE_RELAYER_URL`
- `VITE_BRIDGE_OPERATOR_ADDRESS`
- `VITE_BRIDGE_REQUEST_TTL_SECONDS`

The workflow prefers GitHub Secrets when both a secret and a variable exist with the same name. The deployed artifact also includes [public/CNAME](/home/office/bridge/public/CNAME) so Pages serves the site from `bridge.mbtc.us` once your DNS and repository Pages settings point at GitHub.

## Run locally

Install dependencies:

```bash
npm install
```

Run the frontend:

```bash
npm run dev
```

Run the relay:

```bash
npm run relay
```

## Production notes

- Use a dedicated bridge operator wallet, not a personal wallet with unrelated funds.
- Grant `BRIDGE_ROLE` to that wallet on both MBTC contracts.
- Put the relay behind a process manager like `systemd`, `pm2`, or Docker.
- Back up `server/bridge-state.json` or replace it with a real database before meaningful volume.
- Add monitoring and alerting for failed relay records, especially `failed_mint`.
- This is still a highly trusted bridge. The operator wallet can burn approved balances and mint destination balances. If you want a lower-trust model, you need a dedicated bridge contract design instead of token-role operations.
