// ops-api address-pair shape: numeric `status` (0=pending/1=approved/2=rejected).
// The add-pair POST takes no body and returns this; identity is JWT-derived server-side.
// The `status_label` string was dropped by ops-api — map `status` to a display string on the client if needed.
export interface IOnboardingResponse {
    public_chain_address: string;
    private_chain_address: string;
    status: number;
    created_at: string;
}

// Structurally identical to IOnboardingResponse today — the distinct name is a semantic marker:
// this is a pair as it appears in a *listing* (listMyAddressPairs / IPendingUserAddressPairs),
// vs. the single pair returned by the add-pair POST. Kept as an alias so list call sites read as
// address-pairs, not onboarding responses; promote to its own interface if the list shape diverges.
export type IUserAddressPair = IOnboardingResponse;

// Operator discovery shape: `GET /api/v1/admin/address-pairs/pending` groups each user's pending
// pairs under their ops-api UUID. `user_id` is the path `:id` for the approve/reject PATCH.
export interface IPendingUserAddressPairs {
    user_id: string;
    address_pairs: IUserAddressPair[];
}

// Approve/reject body. The target user is the path `:id`, never the body. `status` allows 1/2 only.
export interface IUpdateOnbStatusRequest {
    public_address: string;
    private_address: string;
    status: number;
}
