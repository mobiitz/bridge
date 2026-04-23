import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import { ethers } from 'ethers';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

dotenv.config();

const tokenAbi = [
  'function BRIDGE_ROLE() view returns (bytes32)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function bridgeMint(address to, uint256 amount)',
  'function bridgeBurnFrom(address from, uint256 amount)',
  'function hasRole(bytes32 role, address account) view returns (bool)',
];

const bridgeRequestTypes = {
  BridgeRequest: [
    { name: 'account', type: 'address' },
    { name: 'recipient', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'sourceChainId', type: 'uint256' },
    { name: 'destinationChainId', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'deadline', type: 'uint256' },
  ],
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const txConfirmations = parsePositiveInt(process.env.TX_CONFIRMATIONS, 1);
const pollIntervalMs = parsePositiveInt(process.env.POLL_INTERVAL_MS, 15_000);
const requestTtlSeconds = parsePositiveInt(process.env.REQUEST_TTL_SECONDS, 900);
const stateFile = path.resolve(
  projectRoot,
  process.env.STATE_FILE || './server/bridge-state.json',
);
const operatorPrivateKey = requireEnv('BRIDGE_ADMIN_PRIVATE_KEY');

const chainList = [
  {
    chainId: 1,
    label: 'Ethereum',
    rpcUrls: [
      process.env.ETHEREUM_RPC_URL || process.env.VITE_ETHEREUM_RPC_URL,
      process.env.ETHEREUM_FALLBACK_RPC_URL ||
        process.env.VITE_ETHEREUM_FALLBACK_RPC_URL,
    ].filter(Boolean),
    tokenAddress:
      process.env.ETHEREUM_TOKEN_ADDRESS ||
      process.env.VITE_ETHEREUM_TOKEN_ADDRESS,
  },
  {
    chainId: 8453,
    label: 'Base',
    rpcUrls: [
      process.env.BASE_RPC_URL || process.env.VITE_BASE_RPC_URL,
      process.env.BASE_FALLBACK_RPC_URL || process.env.VITE_BASE_FALLBACK_RPC_URL,
    ].filter(Boolean),
    tokenAddress:
      process.env.BASE_TOKEN_ADDRESS || process.env.VITE_BASE_TOKEN_ADDRESS,
  },
].map((chain) => {
  if (chain.rpcUrls.length === 0) {
    throw new Error(`Missing RPC URL for ${chain.label}.`);
  }

  if (!chain.tokenAddress || !ethers.isAddress(chain.tokenAddress)) {
    throw new Error(`Missing or invalid token address for ${chain.label}.`);
  }

  const provider = createProvider(chain.chainId, chain.rpcUrls);
  const signer = new ethers.Wallet(operatorPrivateKey, provider);
  const tokenAddress = ethers.getAddress(chain.tokenAddress);

  return {
    ...chain,
    provider,
    signer,
    tokenAddress,
    token: new ethers.Contract(tokenAddress, tokenAbi, signer),
  };
});

const chains = Object.fromEntries(chainList.map((chain) => [chain.chainId, chain]));
let state = await loadState();
let reconcileInFlight = false;

await assertBridgePermissions();

const app = express();
app.use(
  cors({
    origin: resolveCorsOrigin(process.env.CORS_ORIGIN),
  }),
);
app.use(express.json());

app.get('/api/config', (_request, response) => {
  response.json({
    chains: chainList.map((chain) => ({
      chainId: chain.chainId,
      rpcCount: chain.rpcUrls.length,
      tokenAddress: chain.tokenAddress,
    })),
    operatorAddress: chainList[0]?.signer.address,
    requestTtlSeconds,
  });
});

app.get('/api/health', async (_request, response) => {
  const chainHealth = await Promise.all(
    chainList.map(async (chain) => {
      const bridgeRole = await chain.token.BRIDGE_ROLE();
      const hasBridgeRole = await chain.token.hasRole(
        bridgeRole,
        chain.signer.address,
      );

      return {
        chainId: chain.chainId,
        hasBridgeRole,
        label: chain.label,
        latestBlock: await chain.provider.getBlockNumber(),
        operatorAddress: chain.signer.address,
        rpcCount: chain.rpcUrls.length,
        tokenAddress: chain.tokenAddress,
      };
    }),
  );

  response.json({
    chains: chainHealth,
    ok: true,
    requestTtlSeconds,
    txConfirmations,
  });
});

app.get('/api/status/:requestId', async (request, response) => {
  const requestId = request.params.requestId.toLowerCase();
  const record = state.processed[requestId];

  if (!record) {
    response.json({ record: null });
    return;
  }

  response.json({
    record: await advanceBridge(record),
  });
});

app.post('/api/bridge', async (request, response) => {
  try {
    const payload = parseBridgePayload(request.body);
    const record = await processBridgeRequest(payload);

    response.json({
      record,
    });
  } catch (error) {
    response.status(400).json({
      error: toErrorMessage(error),
    });
  }
});

const port = parsePositiveInt(process.env.PORT, 8787);
app.listen(port, () => {
  console.info(`[bridge] relay listening on port ${port}`);
});

await reconcilePendingRecords();
setInterval(() => {
  void reconcilePendingRecords();
}, pollIntervalMs);

async function processBridgeRequest(payload) {
  const requestId = bridgeRequestId(payload).toLowerCase();
  const existingRecord = state.processed[requestId];

  if (existingRecord) {
    return advanceBridge(await prepareRecordForRetry(existingRecord));
  }

  if (destinationChainIdFor(payload.sourceChainId) !== payload.destinationChainId) {
    throw new Error('Destination chain does not match the selected source chain.');
  }

  if (payload.deadline < Math.floor(Date.now() / 1000)) {
    throw new Error('Bridge signature has expired.');
  }

  const nonceKey = bridgeNonceKey(payload.account, payload.nonce);

  if (state.usedNonces[nonceKey]) {
    throw new Error('This bridge nonce has already been used.');
  }

  const recoveredSigner = ethers.verifyTypedData(
    bridgeDomain(payload.sourceChainId),
    bridgeRequestTypes,
    bridgeTypedDataMessage(payload),
    payload.signature,
  );

  if (ethers.getAddress(recoveredSigner) !== payload.account) {
    throw new Error('Bridge signature did not match the requesting wallet.');
  }

  const source = chains[payload.sourceChainId];
  const [allowance, balance] = await Promise.all([
    source.token.allowance(payload.account, source.signer.address),
    source.token.balanceOf(payload.account),
  ]);

  if (allowance < payload.amount) {
    throw new Error('Source-chain allowance is below the requested bridge amount.');
  }

  if (balance < payload.amount) {
    throw new Error('Source-chain balance is below the requested bridge amount.');
  }

  const record = {
    account: payload.account,
    amount: payload.amount.toString(),
    createdAt: new Date().toISOString(),
    deadline: payload.deadline,
    destinationChainId: payload.destinationChainId,
    id: requestId,
    nonce: payload.nonce,
    recipient: payload.recipient,
    signature: payload.signature,
    sourceChainId: payload.sourceChainId,
    status: 'pending',
    updatedAt: new Date().toISOString(),
  };

  state.processed[requestId] = record;
  state.usedNonces[nonceKey] = requestId;
  await saveState();

  return advanceBridge(record);
}

async function advanceBridge(record) {
  if (record.status === 'completed') {
    return record;
  }

  if (!record.burnTxHash) {
    record = await submitBurn(record);

    if (!record.burnTxHash) {
      return record;
    }
  }

  record = await reconcileBurn(record);

  if (record.status === 'failed_burn' || record.status === 'burn_submitted') {
    return record;
  }

  if (!record.mintTxHash) {
    record = await submitMint(record);

    if (!record.mintTxHash) {
      return record;
    }
  }

  return reconcileMint(record);
}

async function submitBurn(record) {
  try {
    const source = chains[record.sourceChainId];
    const burnTx = await source.token.bridgeBurnFrom(
      record.account,
      BigInt(record.amount),
    );

    await updateRecord(record, {
      burnTxHash: burnTx.hash,
      error: undefined,
      status: 'burn_submitted',
    });

    console.info(`[bridge] submitted burn ${burnTx.hash} for ${record.id}`);
  } catch (error) {
    await updateRecord(record, {
      error: toErrorMessage(error),
      status: 'failed_burn',
    });
  }

  return record;
}

async function reconcileBurn(record) {
  if (!record.burnTxHash) {
    return record;
  }

  const source = chains[record.sourceChainId];
  const burnReceipt = await getConfirmedReceipt(source.provider, record.burnTxHash);

  if (!burnReceipt) {
    return record;
  }

  if (burnReceipt.status !== 1) {
    await updateRecord(record, {
      burnBlockNumber: Number(burnReceipt.blockNumber ?? 0),
      error: 'Source-chain bridgeBurnFrom reverted.',
      status: 'failed_burn',
    });
    return record;
  }

  await updateRecord(record, {
    burnBlockNumber: Number(burnReceipt.blockNumber ?? 0),
    error: undefined,
    status: 'burn_confirmed',
  });

  return record;
}

async function submitMint(record) {
  try {
    const destination = chains[record.destinationChainId];
    const mintTx = await destination.token.bridgeMint(
      record.recipient,
      BigInt(record.amount),
    );

    await updateRecord(record, {
      error: undefined,
      mintTxHash: mintTx.hash,
      status: 'mint_submitted',
    });

    console.info(`[bridge] submitted mint ${mintTx.hash} for ${record.id}`);
  } catch (error) {
    await updateRecord(record, {
      error: toErrorMessage(error),
      status: 'failed_mint',
    });
  }

  return record;
}

async function reconcileMint(record) {
  if (!record.mintTxHash) {
    return record;
  }

  const destination = chains[record.destinationChainId];
  const mintReceipt = await getConfirmedReceipt(
    destination.provider,
    record.mintTxHash,
  );

  if (!mintReceipt) {
    return record;
  }

  if (mintReceipt.status !== 1) {
    await updateRecord(record, {
      error: 'Destination-chain bridgeMint reverted.',
      mintBlockNumber: Number(mintReceipt.blockNumber ?? 0),
      status: 'failed_mint',
    });
    return record;
  }

  const completedAt = new Date().toISOString();
  await updateRecord(record, {
    completedAt,
    error: undefined,
    mintBlockNumber: Number(mintReceipt.blockNumber ?? 0),
    status: 'completed',
    updatedAt: completedAt,
  });

  console.info(`[bridge] completed ${record.id}`);
  return record;
}

async function reconcilePendingRecords() {
  if (reconcileInFlight) {
    return;
  }

  reconcileInFlight = true;

  try {
    const pendingRecords = Object.values(state.processed).filter(
      (record) => record.status !== 'completed',
    );

    for (const record of pendingRecords) {
      await advanceBridge(record);
    }
  } catch (error) {
    console.error('[bridge] reconcile error:', toErrorMessage(error));
  } finally {
    reconcileInFlight = false;
  }
}

async function prepareRecordForRetry(record) {
  if (record.status === 'failed_burn') {
    await updateRecord(record, {
      burnBlockNumber: undefined,
      burnTxHash: undefined,
      error: undefined,
      status: 'pending',
    });
  }

  if (record.status === 'failed_mint') {
    const destination = chains[record.destinationChainId];

    if (record.mintTxHash) {
      const mintReceipt = await destination.provider.getTransactionReceipt(
        record.mintTxHash,
      );

      if (mintReceipt?.status === 1) {
        const completedAt = new Date().toISOString();
        await updateRecord(record, {
          completedAt,
          error: undefined,
          mintBlockNumber: Number(mintReceipt.blockNumber ?? 0),
          status: 'completed',
          updatedAt: completedAt,
        });
        return record;
      }
    }

    await updateRecord(record, {
      error: undefined,
      mintBlockNumber: undefined,
      mintTxHash: undefined,
      status: 'burn_confirmed',
    });
  }

  return record;
}

async function assertBridgePermissions() {
  for (const chain of chainList) {
    const bridgeRole = await chain.token.BRIDGE_ROLE();
    const hasBridgeRole = await chain.token.hasRole(
      bridgeRole,
      chain.signer.address,
    );

    if (!hasBridgeRole) {
      throw new Error(
        `Bridge operator ${chain.signer.address} is missing BRIDGE_ROLE on ${chain.label}.`,
      );
    }
  }
}

async function getConfirmedReceipt(provider, txHash) {
  const receipt = await provider.getTransactionReceipt(txHash);

  if (!receipt) {
    return null;
  }

  const latestBlock = await provider.getBlockNumber();
  const blockNumber = Number(receipt.blockNumber ?? 0);

  if (latestBlock - blockNumber + 1 < txConfirmations) {
    return null;
  }

  return receipt;
}

async function loadState() {
  try {
    const file = await fs.readFile(stateFile, 'utf8');
    const parsed = JSON.parse(file);

    return {
      processed: parsed.processed ?? {},
      usedNonces: parsed.usedNonces ?? {},
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        processed: {},
        usedNonces: {},
      };
    }

    throw error;
  }
}

async function saveState() {
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  await fs.writeFile(stateFile, JSON.stringify(state, null, 2));
}

function updateRecord(record, updates) {
  Object.assign(record, updates, {
    updatedAt: updates.updatedAt ?? new Date().toISOString(),
  });
  state.processed[record.id] = record;
  return saveState();
}

function createProvider(chainId, rpcUrls) {
  const providers = rpcUrls.map(
    (rpcUrl) => new ethers.JsonRpcProvider(rpcUrl, chainId),
  );

  if (providers.length === 1) {
    return providers[0];
  }

  return new ethers.FallbackProvider(
    providers.map((provider, index) => ({
      priority: index + 1,
      provider,
      stallTimeout: 1_000,
      weight: 1,
    })),
  );
}

function parseBridgePayload(body) {
  const sourceChainId = Number(body?.sourceChainId);
  const destinationChainId = Number(body?.destinationChainId);
  const deadline = Number(body?.deadline);
  const amount = parseBigInt(body?.amount, 'amount');
  const account = normalizeAddress(body?.account, 'account');
  const recipient = normalizeAddress(body?.recipient, 'recipient');
  const nonce = normalizeBytes32(body?.nonce, 'nonce');
  const signature = normalizeSignature(body?.signature);

  if (!chains[sourceChainId]) {
    throw new Error('Unsupported source chain.');
  }

  if (!chains[destinationChainId]) {
    throw new Error('Unsupported destination chain.');
  }

  if (!Number.isInteger(deadline) || deadline <= 0) {
    throw new Error('Invalid deadline.');
  }

  if (deadline > Math.floor(Date.now() / 1000) + requestTtlSeconds * 10) {
    throw new Error('Deadline is unrealistically far in the future.');
  }

  return {
    account,
    amount,
    deadline,
    destinationChainId,
    nonce,
    recipient,
    signature,
    sourceChainId,
  };
}

function bridgeTypedDataMessage(payload) {
  return {
    account: payload.account,
    amount: payload.amount,
    deadline: BigInt(payload.deadline),
    destinationChainId: BigInt(payload.destinationChainId),
    nonce: payload.nonce,
    recipient: payload.recipient,
    sourceChainId: BigInt(payload.sourceChainId),
  };
}

function bridgeRequestId(payload) {
  return ethers.TypedDataEncoder.hash(
    bridgeDomain(payload.sourceChainId),
    bridgeRequestTypes,
    bridgeTypedDataMessage(payload),
  );
}

function bridgeDomain(sourceChainId) {
  return {
    chainId: sourceChainId,
    name: 'MBTC Bridge',
    version: '1',
  };
}

function bridgeNonceKey(account, nonce) {
  return `${account.toLowerCase()}:${nonce.toLowerCase()}`;
}

function destinationChainIdFor(sourceChainId) {
  if (sourceChainId === 1) {
    return 8453;
  }

  if (sourceChainId === 8453) {
    return 1;
  }

  throw new Error(`Unsupported source chain ${sourceChainId}.`);
}

function normalizeAddress(value, label) {
  if (!value || !ethers.isAddress(value)) {
    throw new Error(`Invalid ${label}.`);
  }

  return ethers.getAddress(value);
}

function normalizeBytes32(value, label) {
  if (!value || !ethers.isHexString(value, 32)) {
    throw new Error(`Invalid ${label}.`);
  }

  return value.toLowerCase();
}

function normalizeSignature(value) {
  if (!value || !ethers.isHexString(value)) {
    throw new Error('Invalid signature.');
  }

  return value;
}

function parseBigInt(value, label) {
  try {
    const parsed = BigInt(value);

    if (parsed <= 0n) {
      throw new Error();
    }

    return parsed;
  } catch {
    throw new Error(`Invalid ${label}.`);
  }
}

function requireEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable ${name}.`);
  }

  return value;
}

function resolveCorsOrigin(rawValue) {
  if (!rawValue) {
    return true;
  }

  const origins = rawValue
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (origins.length === 0) {
    return true;
  }

  return origins;
}

function parsePositiveInt(rawValue, fallback) {
  if (!rawValue) {
    return fallback;
  }

  const parsed = Number.parseInt(rawValue, 10);

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Expected a positive integer, received "${rawValue}".`);
  }

  return parsed;
}

function toErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Unknown error.';
}
