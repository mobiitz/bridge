import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { fallback, http } from 'wagmi';
import { base, mainnet } from 'wagmi/chains';

export const supportedChains = [mainnet, base] as const;

const fallbackProjectId = 'replace-with-walletconnect-project-id';
const walletConnectProjectId =
  import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || fallbackProjectId;

export const walletConnectConfigured =
  walletConnectProjectId !== fallbackProjectId;

const defaultRpcFallbacks: Record<number, string[]> = {
  [mainnet.id]: [
    'https://rpc.flashbots.net/fast',
    'https://ethereum-rpc.publicnode.com',
  ],
  [base.id]: [
    'https://base.meowrpc.com',
    'https://base.llamarpc.com',
  ],
};

function createRpcTransport(
  chain: (typeof supportedChains)[number],
  primaryUrl?: string,
  fallbackUrl?: string,
) {
  const urls = [
    primaryUrl,
    fallbackUrl,
    ...defaultRpcFallbacks[chain.id],
    ...chain.rpcUrls.default.http,
  ].filter((url, index, allUrls): url is string => Boolean(url) && allUrls.indexOf(url) === index);

  const transports = urls.map((url) => http(url));

  if (transports.length > 1) {
    return fallback(
      transports as [ReturnType<typeof http>, ...Array<ReturnType<typeof http>>],
    );
  }

  return transports[0] ?? http();
}

export const wagmiConfig = getDefaultConfig({
  appName: 'mBTC Bridge',
  projectId: walletConnectProjectId,
  chains: supportedChains,
  ssr: false,
  transports: {
    [mainnet.id]: createRpcTransport(
      mainnet,
      import.meta.env.VITE_ETHEREUM_RPC_URL,
      import.meta.env.VITE_ETHEREUM_FALLBACK_RPC_URL,
    ),
    [base.id]: createRpcTransport(
      base,
      import.meta.env.VITE_BASE_RPC_URL,
      import.meta.env.VITE_BASE_FALLBACK_RPC_URL,
    ),
  },
});
