// ops-api token registry status — mirrors the on-chain PN `privacyNodeStatus` state machine
// (PNTokenRegistryV1). The numeric `status` field in every registeredTokenResponse carries these
// semantics. Register starts a token at WAITING_APPROVAL; PATCH .../status accepts only AUTHORIZED (2)
// and UNAUTHORIZED (3) (0/1/4 → 400). FROZEN is reached only via the freeze route, never set-status.
export enum TokenStatus {
    UNDEFINED        = 0,
    WAITING_APPROVAL = 1,
    AUTHORIZED       = 2,
    UNAUTHORIZED     = 3,
    FROZEN           = 4
}
