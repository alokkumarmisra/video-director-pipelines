// PostgreSQL Migration Script - Creates schema for all assets, scenarios, and metadata
import { Client } from 'pg';

const client = new Client({
  host: process.env.PG_HOST || 'localhost',
  port: parseInt(process.env.PG_PORT || '5432'),
  database: process.env.PG_DATABASE || 'sanskriti_ai_studio',
  user: process.env.PG_USER || 'postgres',
  password: process.env.PG_PASSWORD || '',
});

async function createSchema() {
  await client.connect();
  
  console.log('🎬 Creating PostgreSQL schema for video assets...\n');
  
  // Scenarios table - stores scenario configurations
  await client.query(`
    CREATE TABLE IF NOT EXISTS scenarios (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) UNIQUE NOT NULL,
      description TEXT,
      config_json JSONB,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  
  // Assets table - all generated images/videos with full versioning
  await client.query(`
    CREATE TABLE IF NOT EXISTS assets (
      id SERIAL PRIMARY KEY,
      scenario_id INTEGER REFERENCES scenarios(id) ON DELETE CASCADE,
      type VARCHAR(50) NOT NULL CHECK (type IN ('ref', 'keyframe', 'clip', 'final')),
      title TEXT,
      width INTEGER,
      height INTEGER,
      file_size BIGINT,
      mime_type VARCHAR(100),
      path TEXT UNIQUE,
      uploaded_by VARCHAR(255),
      metadata_json JSONB,
      created_at TIMESTAMP DEFAULT NOW(),
      version_number INTEGER
    )
  `);
  
  // Versions table - track which version is main for each asset
  await client.query(`
    CREATE TABLE IF NOT EXISTS versions (
      id SERIAL PRIMARY KEY,
      asset_id INTEGER REFERENCES assets(id) ON DELETE CASCADE,
      version_number INTEGER NOT NULL,
      is_main BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  
  // Runs table - track generation jobs
  await client.query(`
    CREATE TABLE IF NOT EXISTS runs (
      id SERIAL PRIMARY KEY,
      scenario_id INTEGER REFERENCES scenarios(id),
      status VARCHAR(50) DEFAULT 'pending',
      graph_json JSONB,
      entry_json JSONB,
      started_at TIMESTAMP DEFAULT NOW(),
      completed_at TIMESTAMP
    )
  `);
  
  // Relationships table - link keyframes to reference images
  await client.query(`
    CREATE TABLE IF NOT EXISTS relationships (
      id SERIAL PRIMARY KEY,
      asset_id INTEGER REFERENCES assets(id),
      ref_asset_id INTEGER REFERENCES assets(id),
      beat_index INTEGER
    )
  `);
  
  // Indexes for common queries
  await client.query('CREATE INDEX IF NOT EXISTS idx_assets_scenario ON assets(scenario_id);');
  await client.query('CREATE INDEX IF NOT EXISTS idx_assets_type ON assets(type);');
  await client.query('CREATE INDEX IF NOT EXISTS idx_assets_created ON assets(created_at DESC);');
  await client.query('CREATE INDEX IF NOT EXISTS idx_runs_scenario ON runs(scenario_id);');
  await client.query('CREATE INDEX IF NOT EXISTS idx_versions_main ON versions(asset_id, is_main);');
  
  console.log('✅ Tables created:');
  console.log('   - scenarios (scenario configurations)');
  console.log('   - assets (all images/videos with metadata)');
  console.log('   - versions (version tracking with main flag)');
  console.log('   - runs (generation job history)');
  console.log('   - relationships (keyframe-to-reference links)');
  console.log('\n✅ Indexes created for optimized queries\n');
  
  await client.end();
}

createSchema().catch(console.error);