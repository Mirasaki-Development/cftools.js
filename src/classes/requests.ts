import { Authentication } from './auth';
import {
  API_VERSION,
  ENTERPRISE_V1_API_BASE_URL,
  ENTERPRISE_V2_API_BASE_URL,
  V1_API_BASE_URL,
  V2_API_BASE_URL
} from '../constants';
import { AbstractLogger } from '../types/logger';
import { AbstractRequestClient } from '../types/requests';

export class RequestClient extends AbstractRequestClient implements AbstractRequestClient {
  constructor(
    private authProvider: Authentication,
    private logger: AbstractLogger,
  ) {
    super();
    this.apiUrl = this.apiUrl.bind(this);
    this.resolveHeaders = this.resolveHeaders.bind(this);
    this.resolveRequestOptions = this.resolveRequestOptions.bind(this);
    this.request = this.request.bind(this);
    this.get = this.get.bind(this);
    this.post = this.post.bind(this);
    this.put = this.put.bind(this);
    this.delete = this.delete.bind(this);
  }

  public apiUrl(version: API_VERSION, path: string, params?: Record<string, string> | URLSearchParams): string {
    const baseUrl = this.authProvider.enterpriseToken
      ? version === API_VERSION.V1 ? ENTERPRISE_V1_API_BASE_URL : ENTERPRISE_V2_API_BASE_URL
      : version === API_VERSION.V1 ? V1_API_BASE_URL : V2_API_BASE_URL;
    const resolvedParams = params ?
      !(params instanceof URLSearchParams) ? new URLSearchParams(params) : params
      : undefined;
    const resolvedUrl = `${baseUrl}${path}${resolvedParams ? `?${resolvedParams.toString()}` : ''}`;

    this.logger.debug(`Resolved API URL for version ${version}`, resolvedUrl);

    return resolvedUrl;
  }

  public resolveHeaders(
    headersInit: HeadersInit,
    isAuthenticating = false,
  ): HeadersInit {
    const headers = {
      ...headersInit,
      ...this.authProvider.getHeaders(isAuthenticating),
      'User-Agent': this.authProvider.userAgent,
    };

    // Note: The CFTools API does not allow the Referer header
    // to be set to assist in DDOS protection and mitigation
    if ('Referer' in headers) {
      this.logger.warn('Referer header is not allowed by the CFTools API, removing from request');
      delete headers['Referer'];
    }

    this.logger.debug('Resolved headers for request', headers);

    return headers;
  }

  public resolveRequestOptions(
    options: RequestInit,
    isAuthenticating = false,
  ): RequestInit {
    const resolvedOptions = {
      ...options,
      headers: this.resolveHeaders(options.headers ?? {}, isAuthenticating),
    };

    this.logger.debug('Resolved request options', resolvedOptions);

    return resolvedOptions;
  }

  public async request<T>(
    url: string,
    options: RequestInit,
    isAuthenticating = false,
  ): Promise<T> {
    if (this.authProvider.shouldRefresh() && !isAuthenticating) {
      this.logger.debug('Authentication token is expired, refreshing token');
      await this.authProvider.performRefresh();
    }

    this.logger.debug('Performing request', url, options);

    return fetch(url, this.resolveRequestOptions(options, isAuthenticating)).then(async (response) => {
      if (!response.ok) {
        this.logger.error(`Request to ${url} failed`, response.statusText);
        try {
          const error = await response.json();
          this.logger.error('Request error', error);
        } catch (e) {
          this.logger.error('Failed to parse error response', e);
        }
        throw new Error(`Request to ${url} failed: ${response.statusText}`);
      }

      this.logger.debug(`Request to ${url} successful`, response.statusText);

      if (response.status === 204) {
        this.logger.debug('Request was successful but returned no content, returning empty response');
        return {
          status: true,
          error: undefined,
        } as T;
      }

      return response.json();
    });
  }

  public async get<T>(url: string, isAuthenticating = false): Promise<T> {
    return this.request(url, { method: 'GET' }, isAuthenticating);
  }

  public async post<T>(url: string, body: Record<string, unknown>, isAuthenticating = false): Promise<T> {
    return this.request(url, { method: 'POST', body: JSON.stringify(body) }, isAuthenticating);
  }

  public async put<T>(url: string, body: Record<string, unknown>, isAuthenticating = false): Promise<T> {
    return this.request(url, { method: 'PUT', body: JSON.stringify(body) }, isAuthenticating);
  }

  public async delete<T>(url: string, isAuthenticating = false): Promise<T> {
    return this.request(url, { method: 'DELETE' }, isAuthenticating);
  }
}