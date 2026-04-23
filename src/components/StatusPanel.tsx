import {
  chainMeta,
  type BridgePhase,
  type RelayStatusRecord,
  getExplorerTxUrl,
  shortAddress,
} from '../lib/bridge';

type BridgeIntent = {
  account: string;
  amount: string;
  destinationChainId: number;
  id?: string;
  recipient: string;
  sourceChainId: number;
};

type StatusPanelProps = {
  approvalSatisfied: boolean;
  bridgeIntent: BridgeIntent | null;
  bridgeOperatorAddress?: string;
  relayError: string;
  relayRecord: RelayStatusRecord | null;
  phase: BridgePhase;
  onRetryRelay: () => void;
};

const phaseLabel: Record<BridgePhase, string> = {
  idle: 'Waiting for a bridge request',
  confirming_approval: 'Waiting for token approval',
  awaiting_signature: 'Waiting for a bridge signature',
  submitting_request: 'Submitting to the relay',
  relay_processing: 'Relay is processing',
  completed: 'Bridge completed',
  failed: 'Bridge failed',
};

export function StatusPanel({
  approvalSatisfied,
  bridgeIntent,
  bridgeOperatorAddress,
  relayError,
  relayRecord,
  phase,
  onRetryRelay,
}: StatusPanelProps) {
  const sourceChain =
    bridgeIntent && chainMeta[bridgeIntent.sourceChainId]
      ? chainMeta[bridgeIntent.sourceChainId]
      : null;
  const destinationChain =
    bridgeIntent && chainMeta[bridgeIntent.destinationChainId]
      ? chainMeta[bridgeIntent.destinationChainId]
      : null;
  const hasFailedRecord =
    relayRecord?.status === 'failed_burn' ||
    relayRecord?.status === 'failed_mint' ||
    phase === 'failed';
  const isCompleted = relayRecord?.status === 'completed' || phase === 'completed';
  const burnCompleted =
    relayRecord?.status === 'burn_confirmed' ||
    relayRecord?.status === 'mint_submitted' ||
    relayRecord?.status === 'completed';
  const mintSubmitted =
    relayRecord?.status === 'mint_submitted' || relayRecord?.status === 'completed';

  if (!bridgeIntent) {
    return null;
  }

  return (
    <section className="status-panel">
      <div className="status-panel__summary">
        <div>
          <span className="status-panel__label">Transfer Route</span>
          <strong className="status-panel__title">
            {sourceChain?.label} to {destinationChain?.label}
          </strong>
        </div>
        <span
          className={`status-chip status-chip--${hasFailedRecord ? 'failed' : isCompleted ? 'success' : 'live'}`}
        >
          {phaseLabel[phase]}
        </span>
      </div>

      <div className="status-grid">
        <div className="status-card">
          <span className="status-card__label">Amount</span>
          <strong>{bridgeIntent.amount} mBTC</strong>
        </div>
        <div className="status-card">
          <span className="status-card__label">Recipient</span>
          <strong>{shortAddress(relayRecord?.recipient || bridgeIntent.recipient)}</strong>
        </div>
        <div className="status-card">
          <span className="status-card__label">Request</span>
          <strong>{shortAddress(bridgeIntent.id)}</strong>
        </div>
      </div>

      <ol className="steps">
        <li className={approvalSatisfied ? 'steps__item steps__item--done' : 'steps__item'}>
          Approval granted to {bridgeOperatorAddress ? shortAddress(bridgeOperatorAddress) : 'bridge operator'}
        </li>
        <li className={burnCompleted ? 'steps__item steps__item--done' : 'steps__item'}>
          Relay burns on {sourceChain?.label}
        </li>
        <li className={mintSubmitted ? 'steps__item steps__item--done' : 'steps__item'}>
          Relay submits mint on {destinationChain?.label}
        </li>
        <li className={isCompleted ? 'steps__item steps__item--done' : 'steps__item'}>
          Tokens arrive at the destination address
        </li>
      </ol>

      <div className="tx-links">
        {relayRecord?.burnTxHash && (
          <a
            href={getExplorerTxUrl(bridgeIntent.sourceChainId, relayRecord.burnTxHash)}
            target="_blank"
            rel="noreferrer"
          >
            View burn tx
          </a>
        )}
        {relayRecord?.mintTxHash && (
          <a
            href={getExplorerTxUrl(bridgeIntent.destinationChainId, relayRecord.mintTxHash)}
            target="_blank"
            rel="noreferrer"
          >
            View mint tx
          </a>
        )}
      </div>

      {relayRecord?.error && <p className="error-banner">{relayRecord.error}</p>}
      {relayError && <p className="error-banner">{relayError}</p>}

      {!isCompleted && bridgeIntent.id && (
        <button className="secondary-button" type="button" onClick={onRetryRelay}>
          Re-submit signed bridge request
        </button>
      )}
    </section>
  );
}
