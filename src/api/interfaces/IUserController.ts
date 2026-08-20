import {IOnboardingResponse, IUserAddressPair} from "../models/IOnboardingApiBodies";
import {ITokenListResponse, ITokenLockRequest, ITokenLockResponse} from "../models/ITokensApiBodies";
import { TokenStatus } from '../../enums/TokenStatus';
import { OnboardingStatus } from '../../enums/OnboardingStatus';

export interface IUserController {
    // Full on-chain token registry catalog.
    listRegistry(): Promise<ITokenListResponse[]>;
    // Pending (WAITING_APPROVAL) registry subset — user-auth, no role.
    listRegistryPending(): Promise<ITokenListResponse[]>;
    // Adds a fresh HSM address pair for the JWT's user (no body). Returns the created pair (201).
    addAddressPair(): Promise<IOnboardingResponse>;
    // Lists the JWT user's pairs; pass `OnboardingStatus.PENDING` to filter to pending (`?status=0`).
    listMyAddressPairs(status?: OnboardingStatus): Promise<IUserAddressPair[]>;
    // Teleport a token to the public chain (address → path; response keeps `tx_hash`).
    teleport<T extends ITokenLockRequest>(address: string, request : T): Promise<ITokenLockResponse>;
    // Register an already-deployed token (address → path, no body). Returns the created registry entry (201).
    registerToken(address: string): Promise<ITokenListResponse>;
   pollUntilTokenStatusIsUpdated(tokenAddress: string, status: TokenStatus, maxAttempts?: number, delayMs?: number): Promise<ITokenListResponse>;
}
