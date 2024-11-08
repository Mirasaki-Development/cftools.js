import 'dotenv/config';

import { CFToolsClient } from '../src/classes/client';
import { ConsoleLogger } from '../src/classes/logger';

const logger = ConsoleLogger.getInstance();
// @ts-expect-error - disable logging
logger.logLevel = 'off';

export const getClient = () => {
  if (!process.env.CFTOOLS_APPLICATION_ID) {
    throw new Error('CFTOOLS_APPLICATION_ID is not defined');
  }
  
  if (!process.env.CFTOOLS_APPLICATION_SECRET) {
    throw new Error('CFTOOLS_APPLICATION_SECRET is not defined');
  }

  return new CFToolsClient({
    applicationId: process.env.CFTOOLS_APPLICATION_ID,
    applicationSecret: process.env.CFTOOLS_APPLICATION_SECRET,
    enterpriseToken: process.env.CFTOOLS_ENTERPRISE_TOKEN,
    serverApiId: process.env.CFTOOLS_SERVER_API_ID,
    userAgent: 'CFTools API Client / Test Suite',
  }, logger);
};