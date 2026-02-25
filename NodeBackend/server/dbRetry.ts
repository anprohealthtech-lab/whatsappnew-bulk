/**
 * Database retry utility for handling transient connection errors
 */

const RETRYABLE_ERROR_CODES = [
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'EAI_AGAIN',
  'ECONNRESET',
  '57P01', // postgres admin shutdown
  '57P03', // postgres cannot connect now
  '08006', // connection failure
  '08003', // connection does not exist
  '08000', // connection exception
];

interface RetryOptions {
  maxAttempts?: number;
  initialDelay?: number;
  maxDelay?: number;
  backoffMultiplier?: number;
}

/**
 * Check if error is retryable
 */
function isRetryableError(error: any): boolean {
  if (!error) return false;
  
  const errorCode = error.code || error.errno;
  if (RETRYABLE_ERROR_CODES.includes(errorCode)) {
    return true;
  }
  
  const errorMessage = error.message?.toLowerCase() || '';
  return errorMessage.includes('timeout') || 
         errorMessage.includes('connection') ||
         errorMessage.includes('network');
}

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry a database operation with exponential backoff
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = 4,
    initialDelay = 1000,
    maxDelay = 15000,
    backoffMultiplier = 2
  } = options;

  let lastError: any;
  let delay = initialDelay;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error: any) {
      lastError = error;

      // Don't retry on final attempt or non-retryable errors
      if (attempt === maxAttempts || !isRetryableError(error)) {
        console.error(`Database operation failed after ${attempt} attempt(s):`, {
          code: error.code,
          message: error.message,
          attempt
        });
        throw error;
      }

      // Log retry attempt
      console.warn(`Database operation failed (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms...`, {
        code: error.code,
        message: error.message
      });

      // Wait before retry
      await sleep(delay);

      // Exponential backoff with max cap
      delay = Math.min(delay * backoffMultiplier, maxDelay);
    }
  }

  throw lastError;
}

/**
 * Wrap a database query function with automatic retry logic
 */
export function withRetryWrapper<TArgs extends any[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  options?: RetryOptions
): (...args: TArgs) => Promise<TResult> {
  return async (...args: TArgs) => {
    return withRetry(() => fn(...args), options);
  };
}
