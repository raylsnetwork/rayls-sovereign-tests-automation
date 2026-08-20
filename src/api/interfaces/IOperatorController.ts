import {AxiosResponse} from "axios";
import {IPendingUserAddressPairs, IUpdateOnbStatusRequest} from "../models/IOnboardingApiBodies";
import {IFreezeTokenRequest, ISubmitTokenRequest, IUpdateTokenStatusRequest} from "../models/ITokensApiBodies";

export interface IOperatorController {
    // Lists every user's pending address pairs, grouped by ops-api UUID — used to discover the path `:id`.
    listAllPendingAddressPairs(): Promise<IPendingUserAddressPairs[]>;
    // Approves/rejects a pair for the user identified by `userId` (path `:id`).
    approveAddressPair(userId: string, request: IUpdateOnbStatusRequest): Promise<AxiosResponse>;
    // Move a registered token through its status lifecycle (address → path). Body is `{ status }` only.
    updateTokenStatus(address: string, request : IUpdateTokenStatusRequest): Promise<AxiosResponse>;
    // Freeze/unfreeze a token on a given layer (address → path, body `{ layer }`).
    freezeToken(address: string, request : IFreezeTokenRequest): Promise<AxiosResponse>;
    unfreezeToken(address: string, request : IFreezeTokenRequest): Promise<AxiosResponse>;
    // Submit an AUTHORIZED token to another layer (address → path, body `{ target }`).
    submitToken(address: string, request : ISubmitTokenRequest): Promise<AxiosResponse>;
}
