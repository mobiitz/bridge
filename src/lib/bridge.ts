import type { Address } from 'viem';
import { formatUnits, hashTypedData } from 'viem';
import { base, mainnet } from 'wagmi/chains';

export type BridgeDirection = 'eth-to-base' | 'base-to-eth';

export type BridgePhase =
  | 'idle'
  | 'confirming_approval'
  | 'awaiting_signature'
  | 'submitting_request'
  | 'relay_processing'
  | 'completed'
  | 'failed';

export type RelayStatus =
  | 'pending'
  | 'burn_submitted'
  | 'burn_confirmed'
  | 'mint_submitted'
  | 'completed'
  | 'failed_burn'
  | 'failed_mint';

export type RelayStatusRecord = {
  account: string;
  amount: string;
  burnBlockNumber?: number;
  burnTxHash?: string;
  completedAt?: string;
  destinationChainId: number;
  deadline: number;
  error?: string;
  id: string;
  mintBlockNumber?: number;
  mintTxHash?: string;
  nonce: string;
  recipient: string;
  sourceChainId: number;
  status: RelayStatus;
  updatedAt?: string;
};

type ChainMeta = {
  badge: string;
  explorerTxBaseUrl: string;
  label: string;
  accent: string;
};

export const chainMeta: Record<number, ChainMeta> = {
  [mainnet.id]: {
    badge: 'ETH',
    explorerTxBaseUrl: 'https://etherscan.io/tx/',
    label: 'Ethereum',
    accent: '#0e7a6d',
  },
  [base.id]: {
    badge: 'BASE',
    explorerTxBaseUrl: 'https://basescan.org/tx/',
    label: 'Base',
    accent: '#0052ff',
  },
};

const tokenAddresses: Partial<Record<number, Address>> = {
  [mainnet.id]: normalizeAddress(import.meta.env.VITE_ETHEREUM_TOKEN_ADDRESS),
  [base.id]: normalizeAddress(import.meta.env.VITE_BASE_TOKEN_ADDRESS),
};

export const bridgeRequestTypes = {
  BridgeRequest: [
    { name: 'account', type: 'address' },
    { name: 'recipient', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'sourceChainId', type: 'uint256' },
    { name: 'destinationChainId', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

export type BridgeRequestMessage = {
  account: Address;
  recipient: Address;
  amount: bigint;
  sourceChainId: bigint;
  destinationChainId: bigint;
  nonce: `0x${string}`;
  deadline: bigint;
};

export function getRoute(direction: BridgeDirection) {
  if (direction === 'eth-to-base') {
    return {
      directionLabel: 'Ethereum to Base',
      sourceChainId: mainnet.id,
      destinationChainId: base.id,
    };
  }

  return {
    directionLabel: 'Base to Ethereum',
    sourceChainId: base.id,
    destinationChainId: mainnet.id,
  };
}

export function getTokenAddress(chainId: number) {
  return tokenAddresses[chainId];
}

export function getRelayBaseUrl() {
  return import.meta.env.VITE_RELAYER_URL?.replace(/\/$/, '') ?? '';
}

export function getBridgeOperatorAddress() {
  return normalizeAddress(import.meta.env.VITE_BRIDGE_OPERATOR_ADDRESS);
}

export function getBridgeRequestTtlSeconds() {
  const rawValue = import.meta.env.VITE_BRIDGE_REQUEST_TTL_SECONDS;

  if (!rawValue) {
    return 900;
  }

  const parsed = Number.parseInt(rawValue, 10);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    return 900;
  }

  return parsed;
}

export function buildBridgeTypedData(message: BridgeRequestMessage) {
  return {
    domain: {
      name: 'MBTC Bridge',
      version: '1',
      chainId: Number(message.sourceChainId),
    },
    primaryType: 'BridgeRequest' as const,
    types: bridgeRequestTypes,
    message,
  };
}

export function getBridgeRequestId(message: BridgeRequestMessage) {
  return hashTypedData(buildBridgeTypedData(message));
}

export function getExplorerTxUrl(chainId: number, txHash: string) {
  const baseUrl = chainMeta[chainId]?.explorerTxBaseUrl;

  if (!baseUrl) {
    return '#';
  }

  return `${baseUrl}${txHash}`;
}

export function shortAddress(address?: string, size = 6) {
  if (!address) {
    return '--';
  }

  return `${address.slice(0, size)}...${address.slice(-4)}`;
}

export function formatAmount(value?: string) {
  if (!value) {
    return '0';
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return value;
  }

  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 6,
  }).format(parsed);
}

export function formatTokenAmount(value: bigint | string | undefined, decimals?: number) {
  if (value === undefined || decimals === undefined) {
    return '--';
  }

  return formatAmount(formatUnits(BigInt(value), decimals));
}

export function phaseFromRelayRecord(record: RelayStatusRecord): BridgePhase {
  if (record.status === 'completed') {
    return 'completed';
  }

  if (record.status === 'failed_burn' || record.status === 'failed_mint') {
    return 'failed';
  }

  return 'relay_processing';
}

function normalizeAddress(value?: string): Address | undefined {
  if (!value || !value.startsWith('0x')) {
    return undefined;
  }

  return value as Address;
}
