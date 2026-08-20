// ops-api freeze layer — body of POST /api/v1/admin/tokens/:address/freeze | /unfreeze.
// `privacy_node` freezes at the PN level (blocks ALL operations); `public_chain` freezes public-chain ops.
// Any other value (including the Hub/PNH layer) is rejected with 400.
export enum FreezeLayer {
    PRIVACY_NODE = 'privacy_node',
    PUBLIC_CHAIN = 'public_chain'
}
