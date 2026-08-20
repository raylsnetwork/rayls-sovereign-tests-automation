export enum TokenStandards {
    CUSTOM = 0,
    ERC20 = 1,
    ERC721 = 2,
    ERC1155 = 3,
    ENYGMA = 4,
    DVPERC721 = 5,
    DVPERC1155 = 6,
    // Test-only variants. Ordinals MUST match the on-chain SharedObjects.ErcStandard / the relayer's
    // types.ErcStandard. On the constructor-deploy path a *Example contract self-identifies via
    // GetERCStandard() (it overrides the base standard to its *Test ordinal), so the receiver
    // auto-deploys the matching *_TEST_KEY seeded bytecode (addressToFail / receiveTeleportAtomic
    // revert / receiveMsgA).
    ERC20TEST = 7,
    ERC721TEST = 8,
    ERC1155TEST = 9,
    ENYGMATEST = 10,
    DVPERC721TEST = 11,
    DVPERC1155TEST = 12,
}