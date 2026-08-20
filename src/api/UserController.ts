import { BaseController } from './BaseController';
import { IUserController } from './interfaces/IUserController';
import { USER_API_ENDPOINTS } from './endpoints/user-endpoints';
import { IOnboardingResponse, IUserAddressPair } from './models/IOnboardingApiBodies';
import { ITokenListResponse, ITokenLockRequest, ITokenLockResponse } from './models/ITokensApiBodies';
import { eventually } from '../utils/common';
import { shortHex } from '../utils/formatters';
import { TokenStatus } from '../enums/TokenStatus';
import { OnboardingStatus } from '../enums/OnboardingStatus';

export class UserController extends BaseController implements IUserController {
  constructor(baseUrl: string, authToken: string) {
    super(baseUrl);
    super.setAuthToken(authToken);
  }

  // Add a fresh HSM address pair for the JWT's user. No body — identity is derived server-side.
  async addAddressPair(): Promise<IOnboardingResponse> {
    const response = await super.post<IOnboardingResponse>(USER_API_ENDPOINTS.ADDRESS_PAIRS);
    return response.data;
  }

  // List the JWT user's pairs. With a `status`, filters via `?status=<n>` (ops-api accepts 0=pending only).
  async listMyAddressPairs(status?: OnboardingStatus): Promise<IUserAddressPair[]> {
    const config = status !== undefined ? { params: { status } } : undefined;
    const response = await super.get<IUserAddressPair[]>(USER_API_ENDPOINTS.ADDRESS_PAIRS, config);
    return response.data;
  }

  // Pending (WAITING_APPROVAL) registry subset — user-auth, no role (collapses the legacy user/operator lists).
  async listRegistryPending(): Promise<ITokenListResponse[]> {
    const response = await super.get<ITokenListResponse[]>(USER_API_ENDPOINTS.GET_PENDING_TOKENS);
    return response.data;
  }

  // Full on-chain registry catalog.
  async listRegistry(): Promise<ITokenListResponse[]> {
    const response = await super.get<ITokenListResponse[]>(USER_API_ENDPOINTS.GET_TOKENS);
    return response.data;
  }

  // Teleport a token to the public chain (address → path). Response keeps the legacy `tx_hash` field.
  async teleport<T extends ITokenLockRequest>(address: string, request: T): Promise<ITokenLockResponse> {
    const response = await super.post<ITokenLockResponse>(USER_API_ENDPOINTS.tokenTeleport(address), request);
    return response.data;
  }

  // Register an already-deployed token (address → path, no body — metadata read on-chain). Returns the
  // created registry entry (201) starting at WAITING_APPROVAL (1).
  async registerToken(address: string): Promise<ITokenListResponse> {
    const response = await super.post<ITokenListResponse>(USER_API_ENDPOINTS.tokenRegister(address));
    return response.data;
  }

  async pollUntilTokenStatusIsUpdated(tokenAddress: string, status: TokenStatus, maxAttempts = 10, delayMs = 5000): Promise<ITokenListResponse> {
    return await eventually({
      check: async () => {
        const tokens = await this.listRegistry();
        return tokens.find((t) => t.address.toLowerCase() === tokenAddress.toLowerCase()
        && t.status === status);
      },
      interval: delayMs,
      attempts: maxAttempts,
      message: `Waiting for token ${shortHex(tokenAddress)} status → ${status}`,
    })
  }
}