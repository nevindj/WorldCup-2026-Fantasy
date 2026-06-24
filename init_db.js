import mysql from 'mysql2/promise';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function init() {
  try {
    const connection = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || 'root',
      multipleStatements: true
    });
    
    console.log("Connected to MySQL server.");

    const schemaPath = path.join(__dirname, 'schema.sql');
    const sql = fs.readFileSync(schemaPath, 'utf8');

    await connection.query(sql);
    console.log("Database initialized successfully!");
    
    await connection.end();
  } catch (error) {
    console.error("Failed to initialize database:", error);
    process.exit(1);
  }
}

init();
