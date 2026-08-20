// ops-api submit target — body of POST /api/v1/admin/tokens/:address/submit.
// Initiates cross-chain propagation of an AUTHORIZED token. Only `public_chain` is used by the backend
// teleport flows; hub cross-chain activation (A→B) stays contract-side (`activateOnHub`) — ops-api
// `submit {target:hub}` reverts on-chain in this stack (the PN-side `submitToHub` hub-messaging body).
export enum SubmitTarget {
    PUBLIC_CHAIN = 'public_chain'
}
