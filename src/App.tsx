import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useEffect, useState } from 'react';
import {
  formatUnits,
  isAddress,
  keccak256,
  parseUnits,
  stringToHex,
  type Address,
  type Hex,
} from 'viem';
import {
  useAccount,
  useChainId,
  usePublicClient,
  useReadContract,
  useSignTypedData,
  useSwitchChain,
  useWriteContract,
} from 'wagmi';
import { mbtcAbi } from './abi/mbtc';
import { StatusPanel } from './components/StatusPanel';
import { walletConnectConfigured } from './config/wagmi';
import {
  buildBridgeTypedData,
  chainMeta,
  formatAmount,
  formatTokenAmount,
  getBridgeOperatorAddress,
  getBridgeRequestId,
  getBridgeRequestTtlSeconds,
  getRelayBaseUrl,
  getRoute,
  getTokenAddress,
  phaseFromRelayRecord,
  shortAddress,
  type BridgeDirection,
  type BridgePhase,
  type BridgeRequestMessage,
  type RelayStatusRecord,
} from './lib/bridge';
import logoSrc from '../MBTC_light.png';

type BridgeIntent = {
  account: Address;
  amount: string;
  amountRaw: string;
  destinationChainId: number;
  deadline?: number;
  id?: Hex;
  nonce?: Hex;
  recipient: Address;
  signature?: Hex;
  sourceChainId: number;
};

type RelayBridgeResponse = {
  record?: RelayStatusRecord;
  error?: string;
};

type RelayConfigResponse = {
  operatorAddress?: Address;
  requestTtlSeconds?: number;
};

const activeBridgePhases: BridgePhase[] = [
  'confirming_approval',
  'awaiting_signature',
  'submitting_request',
  'relay_processing',
];

function App() {
  const [direction, setDirection] = useState<BridgeDirection>('eth-to-base');
  const [amount, setAmount] = useState('');
  const [recipient, setRecipient] = useState('');
  const [bridgeIntent, setBridgeIntent] = useState<BridgeIntent | null>(null);
  const [bridgePhase, setBridgePhase] = useState<BridgePhase>('idle');
  const [formError, setFormError] = useState('');
  const [relayError, setRelayError] = useState('');
  const [relayRecord, setRelayRecord] = useState<RelayStatusRecord | null>(null);
  const [relayConfig, setRelayConfig] = useState<RelayConfigResponse | null>(null);

  const relayBaseUrl = getRelayBaseUrl();
  const route = getRoute(direction);
  const activeChainId = useChainId();
  const { address, isConnected } = useAccount();
  const { switchChainAsync, isPending: isSwitching } = useSwitchChain();
  const { signTypedDataAsync, isPending: isSigning } = useSignTypedData();
  const sourcePublicClient = usePublicClient({ chainId: route.sourceChainId });
  const { writeContractAsync, isPending: isWriting } = useWriteContract();

  const sourceTokenAddress = getTokenAddress(route.sourceChainId);
  const destinationTokenAddress = getTokenAddress(route.destinationChainId);
  const bridgeOperatorAddress =
    relayConfig?.operatorAddress || getBridgeOperatorAddress();
  const requestTtlSeconds =
    relayConfig?.requestTtlSeconds || getBridgeRequestTtlSeconds();
  const wrongNetwork = isConnected && activeChainId !== route.sourceChainId;
  const hasActiveBridgeFlow =
    bridgeIntent !== null && activeBridgePhases.includes(bridgePhase);
  const allowanceArgs =
    address && bridgeOperatorAddress
      ? ([address, bridgeOperatorAddress] as const)
      : undefined;

  const { data: sourceDecimals } = useReadContract({
    abi: mbtcAbi,
    address: sourceTokenAddress,
    chainId: route.sourceChainId,
    functionName: 'decimals',
    query: {
      enabled: Boolean(sourceTokenAddress),
    },
  });

  const { data: sourceSymbol } = useReadContract({
    abi: mbtcAbi,
    address: sourceTokenAddress,
    chainId: route.sourceChainId,
    functionName: 'symbol',
    query: {
      enabled: Boolean(sourceTokenAddress),
    },
  });

  const {
    data: sourceAllowance,
    refetch: refetchAllowance,
  } = useReadContract({
    abi: mbtcAbi,
    address: sourceTokenAddress,
    chainId: route.sourceChainId,
    functionName: 'allowance',
    args: allowanceArgs,
    query: {
      enabled: Boolean(sourceTokenAddress && allowanceArgs),
    },
  });

  const {
    data: sourceBalanceValue,
    refetch: refetchSourceBalance,
  } = useReadContract({
    abi: mbtcAbi,
    address: sourceTokenAddress,
    chainId: route.sourceChainId,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: {
      enabled: Boolean(address && sourceTokenAddress),
    },
  });
  const sourceTokenDecimals =
    sourceDecimals !== undefined ? Number(sourceDecimals) : 18;
  const sourceTokenSymbol = sourceSymbol || 'MBTC';

  useEffect(() => {
    if (address && !recipient) {
      setRecipient(address);
    }
  }, [address, recipient]);

  useEffect(() => {
    setFormError('');
    setRelayError('');
  }, [direction, activeChainId]);

  useEffect(() => {
    if (!relayBaseUrl) {
      return;
    }

    let cancelled = false;

    async function loadRelayConfig() {
      try {
        const response = await fetch(`${relayBaseUrl}/api/config`);
        const payload = (await response.json()) as RelayConfigResponse;

        if (!response.ok || cancelled) {
          return;
        }

        setRelayConfig(payload);
      } catch {
        if (!cancelled) {
          setRelayConfig(null);
        }
      }
    }

    void loadRelayConfig();

    return () => {
      cancelled = true;
    };
  }, [relayBaseUrl]);

  const bridgeRequestId = bridgeIntent?.id;

  useEffect(() => {
    if (!bridgeRequestId || !relayBaseUrl) {
      return;
    }

    let cancelled = false;

    async function pollStatus() {
      try {
        const url = new URL(`${relayBaseUrl}/api/status/${bridgeRequestId}`);
        const response = await fetch(url.toString());
        const payload = (await response.json()) as { record: RelayStatusRecord | null };

        if (!response.ok || !payload.record || cancelled) {
          return;
        }

        setRelayRecord(payload.record);
        setBridgePhase(phaseFromRelayRecord(payload.record));

        if (payload.record.status === 'completed') {
          setRelayError('');
          void refetchAllowance();
          void refetchSourceBalance();
        }
      } catch {
        if (!cancelled && bridgePhase === 'submitting_request') {
          setBridgePhase('relay_processing');
        }
      }
    }

    void pollStatus();
    const timerId = window.setInterval(() => {
      void pollStatus();
    }, 12000);

    return () => {
      cancelled = true;
      window.clearInterval(timerId);
    };
  }, [
    bridgePhase,
    bridgeRequestId,
    refetchAllowance,
    refetchSourceBalance,
    relayBaseUrl,
  ]);

  useEffect(() => {
    void refetchAllowance();
    void refetchSourceBalance();
  }, [direction, refetchAllowance, refetchSourceBalance]);

  async function handleDirectionChange(nextDirection: BridgeDirection) {
    if (nextDirection === direction || controlsDisabled) {
      return;
    }

    setFormError('');
    setRelayError('');

    const nextRoute = getRoute(nextDirection);

    if (isConnected && activeChainId !== nextRoute.sourceChainId) {
      try {
        await switchChainAsync({ chainId: nextRoute.sourceChainId });
      } catch (error) {
        setFormError(toErrorMessage(error));
        return;
      }
    }

    setDirection(nextDirection);
  }

  async function submitToRelay(intent: BridgeIntent) {
    if (!relayBaseUrl || !intent.signature || !intent.nonce || !intent.deadline) {
      return;
    }

    setRelayError('');
    setBridgePhase('submitting_request');

    try {
      const response = await fetch(`${relayBaseUrl}/api/bridge`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          account: intent.account,
          amount: intent.amountRaw,
          deadline: intent.deadline,
          destinationChainId: intent.destinationChainId,
          nonce: intent.nonce,
          recipient: intent.recipient,
          signature: intent.signature,
          sourceChainId: intent.sourceChainId,
        }),
      });

      const payload = (await response.json()) as RelayBridgeResponse;

      if (!response.ok) {
        throw new Error(payload.error || 'Relay rejected the bridge request.');
      }

      const nextRecord = payload.record ?? null;

      if (nextRecord) {
        setRelayRecord(nextRecord);
        setBridgePhase(phaseFromRelayRecord(nextRecord));
        return;
      }

      setBridgePhase('relay_processing');
    } catch (error) {
      setBridgePhase('failed');
      setRelayError(toErrorMessage(error));
    }
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError('');
    setRelayError('');
    setRelayRecord(null);

    if (!isConnected || !address) {
      setFormError('Connect a wallet before starting the bridge.');
      return;
    }

    if (hasActiveBridgeFlow) {
      setFormError('Wait for the current bridge request to finish before starting another route.');
      return;
    }

    if (!sourceTokenAddress || !destinationTokenAddress) {
      setFormError('Token addresses are not configured yet.');
      return;
    }

    if (!relayBaseUrl) {
      setFormError('Set VITE_RELAYER_URL so the frontend can reach the bridge relay.');
      return;
    }

    if (!bridgeOperatorAddress) {
      setFormError('The bridge operator address is not configured yet.');
      return;
    }

    if (wrongNetwork) {
      try {
        await switchChainAsync({ chainId: route.sourceChainId });
      } catch (error) {
        setFormError(toErrorMessage(error));
      }
      return;
    }

    if (!sourcePublicClient) {
      setFormError('Source-chain client is still loading.');
      return;
    }

    if (sourceAllowance === undefined) {
      setFormError('Allowance data is still loading.');
      return;
    }

    let parsedAmount: bigint;

    try {
      parsedAmount = parseUnits(amount, sourceTokenDecimals);
    } catch {
      setFormError('Enter a valid amount.');
      return;
    }

    if (parsedAmount <= 0n) {
      setFormError('Amount must be greater than zero.');
      return;
    }

    if (sourceBalanceValue === undefined) {
      setFormError('Balance data is still loading.');
      return;
    }

    if (parsedAmount > sourceBalanceValue) {
      setFormError(`Amount exceeds your ${sourceTokenSymbol} balance on ${sourceChain.label}.`);
      return;
    }

    const normalizedRecipient = recipient.trim() || address;

    if (!normalizedRecipient || !isAddress(normalizedRecipient)) {
      setFormError('Enter a valid destination address.');
      return;
    }

    const draftIntent: BridgeIntent = {
      account: address,
      amount,
      amountRaw: parsedAmount.toString(),
      destinationChainId: route.destinationChainId,
      recipient: normalizedRecipient,
      sourceChainId: route.sourceChainId,
    };

    setBridgeIntent(draftIntent);

    try {
      if (sourceAllowance < parsedAmount) {
        setBridgePhase('confirming_approval');

        const approvalTxHash = await writeContractAsync({
          abi: mbtcAbi,
          address: sourceTokenAddress,
          args: [bridgeOperatorAddress, parsedAmount],
          chainId: route.sourceChainId,
          functionName: 'approve',
        });

        const approvalReceipt = await sourcePublicClient.waitForTransactionReceipt({
          confirmations: 1,
          hash: approvalTxHash,
        });

        if (approvalReceipt.status !== 'success') {
          throw new Error('Approval transaction reverted.');
        }

        await refetchAllowance();
      }

      setBridgePhase('awaiting_signature');

      const nonce = keccak256(
        stringToHex(`${window.crypto.randomUUID()}-${Date.now()}-${route.sourceChainId}`),
      );
      const deadline = Math.floor(Date.now() / 1000) + requestTtlSeconds;
      const requestMessage: BridgeRequestMessage = {
        account: address,
        amount: parsedAmount,
        deadline: BigInt(deadline),
        destinationChainId: BigInt(route.destinationChainId),
        nonce,
        recipient: normalizedRecipient,
        sourceChainId: BigInt(route.sourceChainId),
      };
      const signature = await signTypedDataAsync(buildBridgeTypedData(requestMessage));
      const signedIntent: BridgeIntent = {
        ...draftIntent,
        deadline,
        id: getBridgeRequestId(requestMessage),
        nonce,
        signature,
      };

      setBridgeIntent(signedIntent);
      setBridgePhase('submitting_request');
      await submitToRelay(signedIntent);
    } catch (error) {
      setBridgePhase('failed');
      setFormError(toErrorMessage(error));
    }
  }

  const sourceChain = chainMeta[route.sourceChainId];
  const destinationChain = chainMeta[route.destinationChainId];
  const sourceBalanceDecimals =
    sourceTokenDecimals;
  const routeScopedBridgeIntent = isRouteMatch(bridgeIntent, route)
    ? bridgeIntent
    : null;
  const routeScopedRelayRecord = isRouteMatch(relayRecord, route) ? relayRecord : null;
  const routeScopedPhase =
    routeScopedBridgeIntent || routeScopedRelayRecord ? bridgePhase : 'idle';
  const controlsDisabled = isWriting || isSigning || isSwitching || hasActiveBridgeFlow;
  const bridgeIndicatorTone =
    routeScopedPhase === 'failed' || Boolean(formError || relayError) ? 'failed' : 'live';
  const bridgeIndicatorLabel =
    bridgeIndicatorTone === 'failed'
      ? 'Attention'
      : routeScopedBridgeIntent || routeScopedRelayRecord
        ? 'In Flight'
        : 'Online';
  const bridgeButtonLabel = wrongNetwork
    ? `Switch to ${sourceChain.label}`
    : bridgePhase === 'confirming_approval'
      ? 'Waiting for approval confirmation'
      : bridgePhase === 'awaiting_signature' || isSigning
        ? 'Confirm bridge signature'
        : bridgePhase === 'submitting_request'
          ? 'Submitting bridge request'
          : sourceAllowance !== undefined &&
              isValidPositiveAmount(amount, sourceTokenDecimals) &&
              sourceAllowance < parseUnits(amount, sourceTokenDecimals)
            ? `Approve ${sourceTokenSymbol}`
            : 'Sign and bridge';
  const balanceLabel =
    sourceBalanceValue !== undefined &&
    sourceBalanceDecimals !== undefined
      ? `${formatAmount(formatUnits(sourceBalanceValue, sourceBalanceDecimals))} ${sourceTokenSymbol}`
      : '--';
  const allowanceLabel =
      sourceBalanceDecimals !== undefined
      ? formatTokenAmount(sourceAllowance, sourceBalanceDecimals)
      : '--';

  return (
    <div className="app-shell">
      <div className="page-background" />
      <div className="background-blur background-blur--left" />
      <div className="background-blur background-blur--right" />

      <main className="layout">
        <section className="panel hero-panel">
          <div className="brand-card">
            <div className="brand-card__top">
              <img src={logoSrc} alt="MAGA Bitcoin logo" className="brand-logo" />
            </div>
            <div className="brand-card__copy">
              <div className={`brand-status brand-status--${bridgeIndicatorTone}`}>
                <span className="brand-status__dot" />
                <span className="brand-status__label">MBTC Bridge Status</span>
                <strong>{bridgeIndicatorLabel}</strong>
              </div>
              <p>
                Welcome to the $MBTC Bridge, where we can move our $MBTC
                tokens from the Ethereum Network, to the Base Network, and vice
                versa!
              </p>
            </div>
          </div>

          <StatusPanel
            approvalSatisfied={Boolean(
              routeScopedRelayRecord ||
                routeScopedBridgeIntent?.id ||
                (routeScopedBridgeIntent &&
                  sourceAllowance !== undefined &&
                  BigInt(routeScopedBridgeIntent.amountRaw) > 0n &&
                  sourceAllowance >= BigInt(routeScopedBridgeIntent.amountRaw)),
            )}
            bridgeIntent={routeScopedBridgeIntent}
            bridgeOperatorAddress={bridgeOperatorAddress}
            phase={routeScopedPhase}
            relayError={relayError}
            relayRecord={routeScopedRelayRecord}
            onRetryRelay={() => {
              if (routeScopedBridgeIntent) {
                setBridgePhase('submitting_request');
                void submitToRelay(routeScopedBridgeIntent);
              }
            }}
          />
          <div className="wallet-row">
            <ConnectButton />
            <div className="wallet-details">
              <span>Connected wallet</span>
              <strong>{address ? shortAddress(address) : 'No wallet connected'}</strong>
            </div>
          </div>

          <div className="contract-grid">
            <div className="contract-card">
              <span>{sourceChain.label} token</span>
              <strong>{sourceTokenAddress ? shortAddress(sourceTokenAddress) : 'Not configured'}</strong>
            </div>
            <div className="contract-card">
              <span>{destinationChain.label} token</span>
              <strong>
                {destinationTokenAddress
                  ? shortAddress(destinationTokenAddress)
                  : 'Not configured'}
              </strong>
            </div>
          </div>
        </section>

        <section className="panel bridge-panel">
          <div className="route-toggle">
            <button
              className={direction === 'eth-to-base' ? 'route-toggle__button route-toggle__button--active' : 'route-toggle__button'}
              type="button"
              disabled={controlsDisabled}
              onClick={() => {
                void handleDirectionChange('eth-to-base');
              }}
            >
              Ethereum to Base
            </button>
            <button
              className={direction === 'base-to-eth' ? 'route-toggle__button route-toggle__button--active' : 'route-toggle__button'}
              type="button"
              disabled={controlsDisabled}
              onClick={() => {
                void handleDirectionChange('base-to-eth');
              }}
            >
              Base to Ethereum
            </button>
          </div>

          <form className="bridge-form" onSubmit={handleSubmit}>
            <label className="field">
              <div className="field__header">
                <span>Amount to bridge</span>
                <small>
                  Balance:{' '}
                  <strong>{balanceLabel}</strong>
                </small>
              </div>
              <input
                disabled={controlsDisabled}
                inputMode="decimal"
                onChange={(event) => setAmount(event.target.value)}
                placeholder="0.00"
                type="text"
                value={amount}
              />
              <div className="quick-fill-row">
                {([25, 50, 75] as const).map((percentage) => (
                  <button
                    key={percentage}
                    className="quick-fill-button"
                    disabled={
                      controlsDisabled || !sourceBalanceValue || sourceBalanceValue <= 0n
                    }
                    onClick={() => {
                      if (!sourceBalanceValue) {
                        return;
                      }

                      fillAmountFromBalance(
                        percentage,
                        sourceBalanceValue,
                        sourceBalanceDecimals,
                        setAmount,
                      );
                    }}
                    type="button"
                  >
                    {percentage}%
                  </button>
                ))}
                <button
                  className="quick-fill-button quick-fill-button--max"
                  disabled={
                    controlsDisabled || !sourceBalanceValue || sourceBalanceValue <= 0n
                  }
                  onClick={() => {
                    if (!sourceBalanceValue) {
                      return;
                    }

                    fillAmountFromBalance(
                      'max',
                      sourceBalanceValue,
                      sourceBalanceDecimals,
                      setAmount,
                    );
                  }}
                  type="button"
                >
                  MAX
                </button>
              </div>
            </label>

            <label className="field field--mirror">
              <span>Destination amount</span>
              <input
                className="input--mirror"
                placeholder="0.00"
                readOnly
                tabIndex={-1}
                type="text"
                value={amount}
              />
            </label>

            <label className="field">
              <span>Destination address</span>
              <input
                disabled={controlsDisabled}
                onChange={(event) => setRecipient(event.target.value)}
                placeholder="0x..."
                type="text"
                value={recipient}
              />
            </label>

            <div className="form-meta">
              <span>
                Allowance: <strong>{allowanceLabel}</strong>
              </span>
              <span>
                Token: <strong>{sourceTokenSymbol}</strong>
              </span>
              <span>
                Operator:{' '}
                <strong>
                  {bridgeOperatorAddress
                    ? shortAddress(bridgeOperatorAddress)
                    : 'Not configured'}
                </strong>
              </span>
            </div>

            {!walletConnectConfigured && (
              <p className="note">
                Add `VITE_WALLETCONNECT_PROJECT_ID` before going live, otherwise
                WalletConnect-based wallets will not initialize correctly.
              </p>
            )}

            {(formError || relayError) && (
              <p className="error-banner">{formError || relayError}</p>
            )}

            <button
              className="primary-button"
              disabled={controlsDisabled}
              type="submit"
            >
              {isWriting || isSigning || isSwitching ? bridgeButtonLabel : bridgeButtonLabel}
            </button>
          </form>
        </section>
      </main>
      <div className="footer-note">Copyright MAGA Bitcoin 2026</div>
    </div>
  );
}

function isValidPositiveAmount(value: string, decimals: number) {
  try {
    return parseUnits(value, decimals) > 0n;
  } catch {
    return false;
  }
}

function fillAmountFromBalance(
  percentage: 25 | 50 | 75 | 'max',
  rawBalance: bigint,
  decimals: number | undefined,
  setAmount: (value: string) => void,
) {
  if (decimals === undefined) {
    return;
  }

  const nextRawAmount =
    percentage === 'max'
      ? rawBalance
      : (rawBalance * BigInt(percentage)) / 100n;

  setAmount(formatInputAmount(nextRawAmount, decimals));
}

function isRouteMatch(
  value:
    | {
        destinationChainId: number;
        sourceChainId: number;
      }
    | null,
  route: ReturnType<typeof getRoute>,
) {
  if (!value) {
    return false;
  }

  return (
    value.sourceChainId === route.sourceChainId &&
    value.destinationChainId === route.destinationChainId
  );
}

function formatInputAmount(value: bigint, decimals: number) {
  const formatted = formatUnits(value, decimals);

  if (!formatted.includes('.')) {
    return formatted;
  }

  return formatted.replace(/(\.\d*?[1-9])0+$|\.0*$/, '$1');
}

function toErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Something went wrong.';
}

export default App;
