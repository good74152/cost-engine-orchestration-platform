import 'dotenv/config';
import { Pool } from 'pg';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not defined in the environment variables');
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
});