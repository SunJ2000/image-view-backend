import 'dotenv/config';
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { validateEnvironment } from '../config/environment.js';
import { databaseOptions } from './database-options.js';

export default new DataSource(
  databaseOptions(validateEnvironment(process.env)),
);
