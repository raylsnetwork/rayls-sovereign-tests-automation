export const USER_API_ENDPOINTS = {
    // ops-api token registry (RequireAuth, no role): full catalog + pending (INACTIVE) subset.
    GET_TOKENS: '/api/tokens/registry',
    GET_PENDING_TOKENS: '/api/tokens/registry/pending',
    // ops-api self address-pairs: POST (add, no body) + GET (list, optional `?status=0` for pending).
    ADDRESS_PAIRS: '/api/me/address-pairs',
    // Register an already-deployed token; address is the path param, never the body.
    tokenRegister: (addr: string) => `/api/tokens/${addr}/register`,
    // Teleport (legacy "token lock"); address is the path param, never the body.
    tokenTeleport: (addr: string) => `/api/tokens/${addr}/teleport`,
}
