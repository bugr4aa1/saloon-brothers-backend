import pg from 'pg';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Required for Neon.tech free tier
  }
});

// Initialize PostgreSQL Tables
export async function initDb() {
  const client = await pool.connect();
  try {
    console.log('Connecting to PostgreSQL database...');

    // 1. Barbers Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS barbers (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        specialty VARCHAR(100),
        rating DECIMAL(3,1),
        review_count INTEGER,
        experience VARCHAR(50),
        avatar VARCHAR(255)
      );
    `);

    // 2. Services Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS services (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        price INTEGER NOT NULL,
        duration INTEGER NOT NULL
      );
    `);

    // 3. Appointments Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS appointments (
        id VARCHAR(50) PRIMARY KEY,
        barber_id INTEGER REFERENCES barbers(id),
        barber_name VARCHAR(100),
        services JSONB NOT NULL,
        appointment_date VARCHAR(20) NOT NULL,
        appointment_time VARCHAR(10) NOT NULL,
        customer_name VARCHAR(100) NOT NULL,
        customer_phone VARCHAR(50) NOT NULL,
        customer_email VARCHAR(100),
        notes TEXT,
        total_price INTEGER NOT NULL,
        total_duration INTEGER NOT NULL,
        status VARCHAR(50) DEFAULT 'Beklemede',
        created_at VARCHAR(50) NOT NULL
      );
    `);

    // 4. Expenses Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS expenses (
        id VARCHAR(50) PRIMARY KEY,
        title VARCHAR(150) NOT NULL,
        amount INTEGER NOT NULL,
        category VARCHAR(50) NOT NULL,
        expense_date VARCHAR(20) NOT NULL,
        notes TEXT,
        created_at VARCHAR(50) NOT NULL
      );
    `);

    console.log('Tables initialized successfully.');

    // Seed mock barbers if empty
    const barberCheck = await client.query('SELECT COUNT(*) FROM barbers');
    if (parseInt(barberCheck.rows[0].count) === 0) {
      console.log('Seeding barbers table from JSON mock data...');
      const barbersData = JSON.parse(
        await fs.readFile(path.join(__dirname, 'data', 'barbers.json'), 'utf8')
      );
      for (const b of barbersData) {
        await client.query(
          `INSERT INTO barbers (id, name, specialty, rating, review_count, experience, avatar)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [b.id, b.name, b.specialty, b.rating, b.reviewCount, b.experience, b.avatar]
        );
      }
      // Reset sequence
      await client.query(`SELECT setval('barbers_id_seq', (SELECT MAX(id) FROM barbers))`);
    }

    // Seed mock services if empty
    const serviceCheck = await client.query('SELECT COUNT(*) FROM services');
    if (parseInt(serviceCheck.rows[0].count) === 0) {
      console.log('Seeding services table from JSON mock data...');
      const servicesData = JSON.parse(
        await fs.readFile(path.join(__dirname, 'data', 'services.json'), 'utf8')
      );
      for (const s of servicesData) {
        await client.query(
          `INSERT INTO services (id, name, description, price, duration)
           VALUES ($1, $2, $3, $4, $5)`,
          [s.id, s.name, s.description, s.price, s.duration]
        );
      }
      // Reset sequence
      await client.query(`SELECT setval('services_id_seq', (SELECT MAX(id) FROM services))`);
    }

    console.log('Database seeding complete.');
  } catch (err) {
    console.error('Error during database initialization:', err);
    throw err;
  } finally {
    client.release();
  }
}

export default pool;
