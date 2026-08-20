import { FreezeLayer } from '../../enums/FreezeLayer';
import { SubmitTarget } from '../../enums/SubmitTarget';

// NOTE: register (POST /api/tokens/:address/register) takes NO request body — the address is the path
// param and the contract reads name/symbol/standard/supply on-chain. The old `IRegisterTokenRequest`
// body was removed; do NOT reintroduce it.

// ops-api registry entry. Core fields keep the legacy names (`address`, `updated_at`, numeric `status`)
// for frontend compatibility. The derived label fields were dropped by ops-api — map numeric
// `standard`/`status` to display strings on the client if needed.
export interface ITokenListResponse {
    address: string,
    name: string,
    symbol: string,
    uri: string,
    standard: number,
    status: number,
    updated_at: string
}

// ops-api teleport body (POST /api/tokens/:address/teleport). The token address is the path param,
// not the body — `token` was dropped from the legacy "token lock" shape. `data` is the optional
// ERC1155 0x-hex payload.
export interface ITokenLockRequest {
    from: string,
    standard: number,
    to: string,
    data?: string,
}

export interface ITokenLockRequestERC721 extends ITokenLockRequest{
  tokenId: string
}

export interface ITokenLockRequestERC1155 extends ITokenLockRequest{
  tokenId: string,
  amount: string,
}

export interface ITokenLockRequestERC20 extends ITokenLockRequest{
  amount: string,
}

// ops-api set-status body (PATCH /api/v1/admin/tokens/:address/status). Address is the path param.
// `status` carries privacyNodeStatus semantics and accepts only 2 AUTHORIZED / 3 UNAUTHORIZED
// (0 UNDEFINED / 1 WAITING_APPROVAL / 4 FROZEN are rejected → 400). FROZEN is reached via the freeze route.
export interface IUpdateTokenStatusRequest {
    status: number
}

// ops-api freeze/unfreeze body (POST /api/v1/admin/tokens/:address/freeze | /unfreeze). Address is the
// path param. `layer` selects the status machine to (un)freeze — `privacy_node` | `public_chain`; any
// other value (incl. the Hub/PNH layer) → 400. Success is 200 with no body; contract rejection → 422.
export interface IFreezeTokenRequest {
    layer: FreezeLayer | string
}

// ops-api submit body (POST /api/v1/admin/tokens/:address/submit). Address is the path param.
// `target` selects the cross-chain destination — `hub` | `public_chain`. Initiates the flow only;
// Hub/public activation completes later via PNH/relayer callbacks. Token must be privacyNodeStatus ==
// AUTHORIZED first, else 422. (Backend flows use `public_chain`; see `SubmitTarget`.)
export interface ISubmitTokenRequest {
    target: SubmitTarget | string
}

// Teleport-only response. ops-api returns a dedicated `teleportResponse{ tx_hash }` (snake_case) for
// frontend compatibility — NOT the shared mint/burn `txResponse{ txHash }`. Do NOT rename to `txHash`.
export interface ITokenLockResponse {
    tx_hash: string
}
