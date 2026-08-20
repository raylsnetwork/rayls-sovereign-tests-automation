import { AxiosRequestConfig, AxiosResponse } from 'axios';

export interface IBaseController {
    setAuthToken(token: string): void;
    get(url:string,config?:AxiosRequestConfig):Promise<AxiosResponse>;
    post<T=any,B=any>(url:string,body?:B,config?:AxiosRequestConfig):Promise<AxiosResponse<T>>;
    put<T=any,B=any>(url:string,body?:B,config?:AxiosRequestConfig):Promise<AxiosResponse<T>>;
    patch<T=any,B=any>(url:string,body?:B,config?:AxiosRequestConfig):Promise<AxiosResponse<T>>;
    delete<T=any,B=any>(url:string,config?:AxiosRequestConfig):Promise<AxiosResponse<T>>;
}