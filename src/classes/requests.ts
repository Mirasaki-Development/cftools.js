/* eslint-disable max-len */

import { Authentication } from './auth';
import {
  API_VERSION,
  ENTERPRISE_V1_API_BASE_URL,
  ENTERPRISE_V2_API_BASE_URL,
  V1_API_BASE_URL,
  V2_API_BASE_URL,
} from '../constants';
import { AbstractLogger } from '../types/logger';
import { AbstractRequestClient } from '../types/requests';
import { 
  BadSecretError,
  BadTokenError,
  DuplicateEntryError,
  ExpiredTokenError,
  FailedTypeValidationError,
  HTTPRequestError,
  InvalidBucketError,
  InvalidMethodError,
  InvalidOptionError,
  InvalidResourceError,
  LengthMismatchError,
  LibraryParsingError,
  LoginRequiredError,
  MaxLengthExceededError,
  MinLengthNotReachedError,
  NoGrantError,
  NotFoundError,
  ParameterRequiredError,
  RateLimitError,
  SystemUnavailableError,
  TimeoutError,
  TokenRegenerationRequiredError,
  UnexpectedError
} from './errors';

export class RequestClient extends AbstractRequestClient implements AbstractRequestClient {
  constructor(
    private authProvider: Authentication,
    private logger: AbstractLogger,
    public timeout = 10000,
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

    return headers;
  }

  /**
   * Resolves the request options for a request depending on the current state of the client
   * @param url The URL to request
   * @param options The options for the request
   * @param isAuthenticating Whether the request is for authentication or not
   * @returns The resolved request options
   */
  public resolveRequestOptions(
    url: string,
    options: RequestInit,
    isAuthenticating = false,
  ): RequestInit {
    const resolvedOptions: RequestInit = {
      ...options,
      headers: this.resolveHeaders(options.headers ?? {}, isAuthenticating),
      signal: AbortSignal.timeout(this.timeout),
    };

    this.logger.debug(`Resolved request options for ${url}`, {
      ...resolvedOptions,
      headers: {
        ...resolvedOptions.headers,
        Authorization: 'Bearer [REDACTED]',
        'X-Enterprise-Access-Token': Object.prototype.hasOwnProperty.call(
          resolvedOptions.headers,
          'X-Enterprise-Access-Token'
        ) ? '[REDACTED]' : undefined,
      },
    });

    return resolvedOptions;
  }

  /**
   * Perform a request to the CFTools API
   * @param url The URL to request
   * @param options The options for the request
   * @param isAuthenticating Whether the request is for authentication or not
   * @returns The parsed JSON response from the request
   * @throw {HTTPRequestError} Thrown if the request fails
   * @throw {InvalidMethodError} Thrown if the request method is invalid
   * @throw {ParameterRequiredError} Thrown if a required parameter is missing
   * @throw {FailedTypeValidationError} Thrown if a supplied argument failed type validation
   * @throw {InvalidOptionError} Thrown if a supplied option is not available for the selected route
   * @throw {MaxLengthExceededError} Thrown if the maximum length of a parameter has been exceeded
   * @throw {MinLengthNotReachedError} Thrown if the minimum length of a parameter has not been reached
   * @throw {LengthMismatchError} Thrown if the length of a parameter does not match the expected length
   * @throw {DuplicateEntryError} Thrown if a duplicate entry is detected
   * @throw {LoginRequiredError} Thrown if the client is not authenticated
   * @throw {TokenRegenerationRequiredError} Thrown if the authentication token needs to be regenerated
   * @throw {BadSecretError} Thrown if the secret is invalid
   * @throw {BadTokenError} Thrown if the token is invalid
   * @throw {ExpiredTokenError} Thrown if the token has expired
   * @throw {NoGrantError} Thrown if the token has no grant
   * @throw {NotFoundError} Thrown if the requested resource was not found
   * @throw {InvalidResourceError} Thrown if the requested resource is invalid
   * @throw {InvalidBucketError} Thrown if the requested bucket is invalid
   * @throw {RateLimitError} Thrown if the rate limit has been exceeded
   * @throw {UnexpectedError} Thrown if an unexpected error occurred
   * @throw {TimeoutError} Thrown if the request timed out
   * @throw {SystemUnavailableError} Thrown if the system is unavailable
   */
  public async request<T>(
    url: string,
    options: RequestInit,
    isAuthenticating = false,
  ): Promise<T> {
    if (this.authProvider.shouldRefresh() && !isAuthenticating) {
      await this.authProvider.performRefresh();
    }

    let response: Response;
    const method = options.method?.toLocaleUpperCase() ?? 'GET';

    try {
      response = await fetch(url, this.resolveRequestOptions(url, options, isAuthenticating));
    } catch (e) {
      this.logger.error('Request failed', 'error', `${e}`);

      if (e instanceof Error && e.name === 'AbortError') {
        throw new TimeoutError({ status: 408, body: { error: '[abort] Request timed out' } });
      }

      if (e instanceof Error && e.name === 'TimeoutError') {
        throw new TimeoutError({ status: 408, body: { error: 'Request timed out' } });
      }

      throw new HTTPRequestError(0, 'Request failed', { error: `${e}` });
    }

    if (!response.ok) {
      await this.errorHandler({ url, method }, response);
    }

    this.logger.debug(`${method} Request to ${url} successful`, response.statusText);

    if (response.status === 204) {
      this.logger.debug('Request was successful but returned no content, returning empty response');
      return undefined as unknown as T;
    }

    let json;
    try {
      json = await response.json();
    } catch (e) {
      this.logger.error('Failed to parse response', 'error', `${e}`, 'response', response);
      throw new LibraryParsingError('Failed to parse response, create a GitHub issue with the response body');
    }

    this.logger.debug(`Parsed response from ${method} ${url}`, json);

    return json;
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

  private async errorHandler(request: {
    url: string;
    method: string;
  }, response: Response): Promise<void> {
    this.logger.error('Request failed', response.statusText);

    let body;
    try {
      body = await response.json();
      this.logger.error('Request error', 'response-body', JSON.stringify(body), 'headers', response.headers);
    } catch (e) {
      this.logger.error('Failed to parse error response', 'error', `${e}`, 'headers', response.headers);
    }

    const status: number = response.status;
    const safeError: string | null = typeof body === 'object' && body
      && 'error' in body && typeof body.error === 'string'
      ? body.error
      : null;

    const errorBody = {
      statusCode: status,
      url: request.url,
      method: request.method,
      body: body,
      headers: response.headers,
    };

    switch (status) {
    case 400: {
      switch (safeError) {
      case 'invalid-method':
        throw new InvalidMethodError(errorBody);
      case 'parameter-required':
        throw new ParameterRequiredError(errorBody);
      case 'failed-type-validation':
        throw new FailedTypeValidationError(errorBody);
      case 'invalid-option':
        throw new InvalidOptionError(errorBody);
      case 'max-length-exceeded':
        throw new MaxLengthExceededError(errorBody);
      case 'min-length-too-small':
        throw new MinLengthNotReachedError(errorBody);
      case 'length-missmatch':
        throw new LengthMismatchError(errorBody);
      case 'duplicate':
        throw new DuplicateEntryError(errorBody);
      }
      break;
    }
    case 401: {
      if (safeError === 'login-required') {
        throw new LoginRequiredError(errorBody);
      }
      break;
    }
    case 403: {
      switch (safeError) {
      case 'token-regeneration-required':
        throw new TokenRegenerationRequiredError(errorBody);
      case 'bad-secret':
        throw new BadSecretError(errorBody);
      case 'bad-token':
        throw new BadTokenError(errorBody);
      case 'expired-token':
        throw new ExpiredTokenError(errorBody);
      case 'no-grant':
        throw new NoGrantError(errorBody);
      }
      break;
    }
    case 404: {
      switch (safeError) {
      case 'not-found':
        throw new NotFoundError(errorBody, 'The requested resource was not found');
      case 'invalid-resource':
        throw new InvalidResourceError(errorBody);
      case 'invalid-bucket':
        throw new InvalidBucketError(errorBody);
      }
      break;
    }
    case 429: {
      throw new RateLimitError(errorBody);
    }
    case 500: {
      switch (safeError) {
      case 'unexpected':
        throw new UnexpectedError(errorBody);
      case 'timeout':
        throw new TimeoutError(errorBody);
      case 'system-unavailable':
        throw new SystemUnavailableError(errorBody);
      }
      break;
    }
    }

    throw new HTTPRequestError(status, `Request failed: ${response.statusText} (${response.status})`, errorBody);
  }
}