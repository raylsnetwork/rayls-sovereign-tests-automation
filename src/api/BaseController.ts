import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { IBaseController } from './interfaces';
import { BackendError } from '../exceptions-and-errors/backend-error';

export class BaseController implements IBaseController {
  private Client: AxiosInstance;

  // Default to 60s. The ops-api endpoints behind these controllers submit
  // operator-signed on-chain transactions and synchronously wait for them to
  // mine. `POST /api/me/address-pairs` mints a fresh HSM wallet then writes the
  // pair on-chain; on a freshly-bootstrapped local stack that can take 9-15
  // seconds. A short timeout firing mid-tx leaves the write mining after the
  // client disconnects, creating an orphan PENDING pair (the outer `retry()`
  // then adds a second). Onboarding assertions are pair-relative, so an orphan
  // no longer breaks them — but 60s still comfortably covers the mining wait.
  constructor(baseURL: string, timeout: number = 60000) {
    this.Client = axios.create({
      baseURL,
      timeout,
      headers: { accept: 'application/json' },
    });

    this.Client.interceptors.request.use(config => {
      return config;
    });

    this.Client.interceptors.response.use(
      // Fulfilled: 2xx
      res => res,
      // Rejected: network or non-2xx
      err => {
        const status = err?.response?.status ?? 0;
        const data = err?.response?.data;
        const code = data?.code ?? data?.errorCode;
        const message = data?.message ?? data?.error ?? err?.message ?? 'Request failed';
        return Promise.reject(new BackendError(message, status, code, data));
      }
    );
  }

  setAuthToken(authToken: string) {
    this.Client.defaults.headers.common['Authorization'] = `Bearer ${authToken}`;
  }

  public async get<T>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return await this.Client.get<T>(url, config);
  }

  public async post<T = any, B = any>(url: string, body?: B, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return await this.Client.post<T>(url, body, config);
  }

  public async put<T = any, B = any>(url: string, body?: B, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return await this.Client.put<T>(url, body, config);
  }

  public async patch<T = any, B = any>(url: string, body?: B, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return await this.Client.patch<T>(url, body, config);
  }

  public async delete<T = any>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return await this.Client.delete<T>(url, config);
  }
}