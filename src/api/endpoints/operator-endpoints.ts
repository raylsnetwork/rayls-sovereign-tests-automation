export const OPERATOR_API_ENDPOINTS = {
    // ops-api admin onboarding: list every user's pending pairs (discovery), then approve/reject by UUID path.
    GET_PENDING_ADDRESS_PAIRS: '/api/v1/admin/address-pairs/pending',
    approveAddressPair: (userId: string) => `/api/v1/admin/users/${userId}/address-pairs/status`,
    // ops-api token registry status change (operator role); address is the path param, never the body.
    setTokenStatus: (addr: string) => `/api/v1/admin/tokens/${addr}/status`,
    // ops-api token freeze/unfreeze (operator role); address → path, body `{ layer }`.
    freezeToken: (addr: string) => `/api/v1/admin/tokens/${addr}/freeze`,
    unfreezeToken: (addr: string) => `/api/v1/admin/tokens/${addr}/unfreeze`,
    // ops-api submit token to another layer (operator role); address → path, body `{ target }`.
    submitToken: (addr: string) => `/api/v1/admin/tokens/${addr}/submit`,
}
