# Dvp Performance Tests

This directory contains performance tests for the Zero-Knowledge Decentralized Value Protocol (Dvp) features.

## Structure

### deposits/
Contains performance tests for deposit operations into Dvp for different token types:

- **EnygmaDepositPerformance.ts** - Tests deposit performance for EnygmaWrapper tokens

### withdrawals/
Contains performance tests for withdrawal operations from Dvp for different token types:

- **EnygmaWithdrawalPerformance.ts** - Tests withdrawal performance for EnygmaWrapper tokens

## Usage

### Environment Variables

Each test supports configuration via environment variables:

#### EnygmaWrapper Deposits
```bash
DVP_DEPOSIT_TOTAL=10 npx hardhat test hardhat/test/performance/dvp/deposits/EnygmaDepositPerformance.ts
```

#### EnygmaWrapper Withdrawals
```bash
DVP_WITHDRAWAL_TOTAL=10 npx hardhat test hardhat/test/performance/dvp/withdrawals/EnygmaWithdrawalPerformance.ts
```

## Test Methodology

All tests follow a similar pattern:

1. **Setup Phase**: Deploy and register tokens, mint initial tokens
2. **Sequential Execution**: Send transactions one by one (EnygmaWrapper) or in parallel (ERC1155/ERC721)
3. **Settlement Monitoring**: Monitor for completion using proper verification methods
4. **Duration Tracking**: Track effective completion time (last meaningful event) vs total polling time
5. **TPS Calculation**: Calculate transactions per second using effective duration for accurate metrics
6. **Reporting**: Generate JSON and optionally HTML reports

## Verification Methods

### Deposits
- **EnygmaWrapper**: Dual verification - token balance reduction (tokens burned) + Dvp Commitments events 

### Withdrawals
- **EnygmaWrapper**: Token balance increase (tokens received from Dvp withdrawal)

## Duration Tracking

The EnygmaWrapper test uses intelligent duration tracking:

- **Effective Duration**: Time from test start until the last Dvp Commitments event was processed
- **Total Polling Duration**: Full time including timeout waiting period
- **TPS Calculation**: Uses effective duration for accurate performance metrics

This approach provides realistic TPS measurements by excluding timeout periods where no meaningful work occurred. For example, if 96/100 deposits complete in 490 seconds but the test waits an additional 750 seconds for the remaining 4, the TPS is calculated as 96/490 = 0.20 TPS rather than 96/1240 = 0.08 TPS.

## Intelligent Timeout Strategy

The EnygmaWrapper test implements smart timeout logic to avoid excessively long waits:

- **Maximum Inactivity**: 1 minute without progress before stopping
- **Progress Detection**: Monitors Dvp Commitments events for meaningful work
- **Early Termination**: Stops polling when no new events are processed for the timeout period
- **Clean Logging**: Logs timeout message only once, then proceeds with current results
- **Realistic Reporting**: Uses effective duration (time until last event) for TPS calculations

This prevents scenarios where tests wait 20+ minutes for a few remaining deposits that may never complete due to network issues or RPC rate limiting.

## Test Execution Patterns

- **EnygmaWrapper**: Sequential sending (like real user behavior) with comprehensive settlement verification
- **ERC1155/ERC721**: Parallel batch sending for maximum throughput testing

## Future Enhancements

The following features can be added:
- Swap performance tests (EnygmaWrapper ↔ ERC1155, EnygmaWrapper ↔ ERC721)
- ERC1155 and ERC721 withdrawal performance tests
- Mixed operation performance tests
