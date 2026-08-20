import { BaseController } from './BaseController';
import { IOperatorController } from './interfaces';
import { OPERATOR_API_ENDPOINTS } from './endpoints/operator-endpoints';
import { IPendingUserAddressPairs, IUpdateOnbStatusRequest } from './models/IOnboardingApiBodies';
import { IFreezeTokenRequest, ISubmitTokenRequest, IUpdateTokenStatusRequest } from './models/ITokensApiBodies';
import { AxiosResponse } from 'axios';

export class OperatorController extends BaseController implements IOperatorController {
  constructor(baseUrl: string, authToken: string) {
    super(baseUrl);
    super.setAuthToken(authToken);
  }

  // Discovery endpoint: every user's pending pairs, grouped by ops-api UUID (`user_id` → PATCH path `:id`).
  async listAllPendingAddressPairs(): Promise<IPendingUserAddressPairs[]> {
    const response = await super.get<IPendingUserAddressPairs[]>(OPERATOR_API_ENDPOINTS.GET_PENDING_ADDRESS_PAIRS);
    return response.data;
  }

  // Set the pair status for `userId` (path `:id`). `request.status` allows 0 (pending) / 1 (approved) / 2 (rejected).
  async approveAddressPair(userId: string, request: IUpdateOnbStatusRequest): Promise<AxiosResponse> {
    return await super.patch(OPERATOR_API_ENDPOINTS.approveAddressPair(userId), request);
  }

  // Move a registered token through its status lifecycle (address → path). Body is `{ status }` only.
  async updateTokenStatus(address: string, request: IUpdateTokenStatusRequest): Promise<AxiosResponse> {
    return await super.patch(OPERATOR_API_ENDPOINTS.setTokenStatus(address), request);
  }

  // Freeze a token on a given layer (address → path, body `{ layer }`). 200 no body; bad layer → 400.
  async freezeToken(address: string, request: IFreezeTokenRequest): Promise<AxiosResponse> {
    return await super.post(OPERATOR_API_ENDPOINTS.freezeToken(address), request);
  }

  // Unfreeze a token on a given layer (address → path, body `{ layer }`). 200 no body; bad layer → 400.
  async unfreezeToken(address: string, request: IFreezeTokenRequest): Promise<AxiosResponse> {
    return await super.post(OPERATOR_API_ENDPOINTS.unfreezeToken(address), request);
  }

  // Submit an AUTHORIZED token to another layer (address → path, body `{ target }`). Initiates only —
  // Hub/public activation completes later via callbacks. 200 no body; non-AUTHORIZED token → 422.
  async submitToken(address: string, request: ISubmitTokenRequest): Promise<AxiosResponse> {
    return await super.post(OPERATOR_API_ENDPOINTS.submitToken(address), request);
  }
}
